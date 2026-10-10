import { and, eq } from "drizzle-orm";
import { getDb, workflows, workflowSteps, workflowVersions, runs, contentItems, contentVariants, approvals, publications, schedules, socialAccounts, youtubeItems, assertWorkspaceOperational, TenantPolicyError } from "@socialyar/db";
import type { FastifyRequest, FastifyReply } from "fastify";

type Db = ReturnType<typeof getDb>;
const roles = new Set(["manager", "editor", "reviewer", "publisher", "viewer"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class Denied extends Error {}

/** Server-side authorization; omitted scopes are unrestricted, empty scopes grant nothing. */
export async function enforceAccess(db: Db, request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = request.auth;
  const path = request.url.split("?")[0].replace(/\/$/, "") || "/";
  const method = request.method;
  const read = method === "GET" || method === "HEAD";
  const body = request.body && typeof request.body === "object" && !Buffer.isBuffer(request.body) ? request.body as Record<string, unknown> : {};
  const params = (request.params ?? {}) as Record<string, unknown>;
  const restricted = auth.channelIds != null || auth.workflowIds != null;
  const deny = () => { throw new Denied(); };
  const allowed = (scope: string[] | null | undefined, id: string | null | undefined) => scope == null || Boolean(id && scope.includes(id));
  // Internal resolver follows only known ownership links, never a client-provided workspace.
  const row = async (table: any, id: unknown): Promise<any> => {
    if (typeof id !== "string" || !uuid.test(id)) return deny();
    const [result] = await db.select().from(table).where(eq(table.id, id)).limit(1);
    if (!result) return deny();
    return result;
  };
  const account = async (id: unknown) => {
    const value = await row(socialAccounts, id);
    if (value.workspaceId !== auth.workspaceId || !allowed(auth.channelIds, value.id)) deny();
  };
  const nestedAccounts = async (value: unknown): Promise<void> => {
    if (!value || typeof value !== "object" || Buffer.isBuffer(value)) return;
    if (Array.isArray(value)) { for (const child of value) await nestedAccounts(child); return; }
    for (const [key, child] of Object.entries(value)) {
      if (["accountId", "socialAccountId", "channelId"].includes(key) && child != null && child !== "") await account(child);
      if (key === "accountIds" || key === "channelIds") { if (Array.isArray(child)) for (const id of child) await account(id); }
      await nestedAccounts(child);
    }
  };
  const workflow = async (id: unknown) => {
    const value = await row(workflows, id);
    if (value.workspaceId !== auth.workspaceId || !allowed(auth.workflowIds, value.id)) deny();
    // Executing or reading a graph must not expose/use a channel outside the assigned scope.
    const steps = await db.select({ config: workflowSteps.config }).from(workflowSteps).innerJoin(workflowVersions,eq(workflowSteps.workflowVersionId,workflowVersions.id)).where(and(eq(workflowVersions.workflowId, value.id),eq(workflowVersions.version,value.currentVersion)));
    for (const step of steps) await nestedAccounts(step.config);
    return value;
  };
  const run = async (id: unknown) => {
    const value = await row(runs,id); await workflow(value.workflowId);
    const version = await row(workflowVersions,value.workflowVersionId);
    await nestedAccounts(version.snapshot);
    const steps = await db.select({ config:workflowSteps.config }).from(workflowSteps).where(eq(workflowSteps.workflowVersionId,value.workflowVersionId));
    for(const step of steps)await nestedAccounts(step.config);
    await nestedAccounts(value.input);await nestedAccounts(value.output);return value;
  };
  const content = async (id: unknown) => {
    const value = await row(contentItems,id);
    if (value.workspaceId !== auth.workspaceId) deny();
    if (value.runId) await run(value.runId);
    else if (value.metadata?.workflowId) await workflow(value.metadata.workflowId);
    else if (auth.workflowIds != null) deny();
    await nestedAccounts(value.metadata);
    return value;
  };
  const variant = async (id: unknown) => {
    const value = await row(contentVariants,id); await content(value.contentItemId);
    if (value.settings?.workflowId) await workflow(value.settings.workflowId);
    await nestedAccounts(value.settings);
    const attached = await db.select({ accountId: publications.socialAccountId }).from(publications).where(eq(publications.contentVariantId,value.id));
    const planned = await db.select({ accountId: schedules.socialAccountId }).from(schedules).where(eq(schedules.contentVariantId,value.id));
    for (const entry of [...attached,...planned]) if (entry.accountId) await account(entry.accountId);
    // A channel-restricted member needs an explicit destination, not a network enum.
    if (auth.channelIds != null && !value.settings?.accountId && !value.settings?.socialAccountId && ![...attached,...planned].some(x=>x.accountId)) deny();
    return value;
  };
  const video = async (id: unknown) => { const value = await row(youtubeItems,id); if(value.workspaceId!==auth.workspaceId)deny(); await workflow(value.workflowId);await account(value.accountId);return value; };
  try {
    if (auth.mustChangePassword && !["/auth/me","/auth/password"].includes(path)) return void reply.code(403).send({ error:"password_change_required", message:"ابتدا گذرواژه خود را تغییر دهید." });
    if (!roles.has(auth.role ?? "")) deny();
    const role = auth.role;
    if (path.startsWith("/platform")) { if (!auth.isPlatformAdmin) deny(); return; }
    if (path.startsWith("/team")) { if (role!=="manager") deny(); return; }
    if (path.startsWith("/auth/")) return;
    const credentials = /^\/(settings\/ai|api-connections|proxies|connection-checks|publication-connection-events)(\/|$)/.test(path)
      || (path.startsWith("/social-accounts") && !(read && path==="/social-accounts"))
      || /^\/youtube\/(connect|health|accounts)(\/|$)/.test(path);
    if (credentials && role!=="manager") deny();
    if (!read && role!=="manager") {
      if (role==="viewer") deny();
      const approvalAction = /\/approval$|\/resolve$/.test(path) || (path.startsWith("/calendar/items/") && ["approve","reject"].includes(String(body.action)));
      if (role==="reviewer" && !approvalAction) deny();
      if (role==="editor") {
        const edit = /^(\/workflows(?:\/[^/]+)?|\/runs\/[^/]+\/content|\/content\/[^/]+|\/content-variants\/[^/]+|\/content-variants\/[^/]+\/approval|\/content-collections\/(preview|apply|google-sheet|test-media)|\/youtube\/media|\/youtube\/items(?:\/[^/]+\/media)?)$/.test(path)
          || (path.startsWith("/calendar/items/") && body.action==="edit");
        if (!edit || approvalAction || method==="DELETE") deny();
        if (path.startsWith("/workflows") && (body.status==="active" || body.autonomyMode==="full_auto" || body.autonomyMode==="automatic")) deny();
        
      }
      // No non-manager role may administer unknown mutation routes.
      if (role==="publisher" && !/^\/(workflows|runs|content|content-variants|content-collections|calendar\/items|youtube\/(items|media)|publications|schedules|approvals)(\/|$)/.test(path)) deny();
    }
    const recovery = /\/(cancel|disconnect)$/.test(path) || ["stop","reject","unschedule"].includes(String(body.action)) || body.decision==="reject" || (["paused","archived"].includes(String(body.status)) && path.startsWith("/workflows/"));
    if (!read && !recovery) await assertWorkspaceOperational(db,auth.workspaceId);
    const walk = async (value: unknown): Promise<void> => {
      if (!value || typeof value!=="object" || Buffer.isBuffer(value)) return;
      if (Array.isArray(value)) { for(const child of value)await walk(child);return; }
      for(const [key,child] of Object.entries(value)) {
        if (key==="workspaceId" && child!==auth.workspaceId) deny();
        if (key==="workflowId" && child!=null) await workflow(child);
        if (key==="runId" && child!=null) await run(child);
        if (["variantId","contentVariantId"].includes(key) && child!=null) await variant(child);
        if (key==="contentItemId" && child!=null) await content(child);
        if (key==="workflowIds" && Array.isArray(child)) for(const id of child)await workflow(id);
        if (["accountId","socialAccountId","channelId"].includes(key) && child!=null && child!=="") await account(child);
        await walk(child);
      }
    };
    await walk(params); await walk(request.query); await walk(body); await nestedAccounts(body);
    if (params.workflowId) {
      const current = await workflow(params.workflowId);
      if (!read && role==="editor" && (current.status==="active" || current.autonomyMode==="full_auto")) deny();
    }
    if(params.runId)await run(params.runId);
    if(params.contentItemId)await content(params.contentItemId);
    if(params.variantId)await variant(params.variantId);
    if(params.approvalId){const value=await row(approvals,params.approvalId);if(value.workspaceId!==auth.workspaceId)deny();await variant(value.contentVariantId);}
    if(params.publicationId){const value=await row(publications,params.publicationId);if(value.workspaceId!==auth.workspaceId)deny();await variant(value.contentVariantId);if(value.socialAccountId)await account(value.socialAccountId);}
    if(params.scheduleId){const value=await row(schedules,params.scheduleId);if(value.workspaceId!==auth.workspaceId)deny();await variant(value.contentVariantId);if(value.socialAccountId)await account(value.socialAccountId);}
    if(path.startsWith("/youtube/items/")&&params.id)await video(params.id);
    if(path.startsWith("/youtube/accounts/")&&params.id)await account(params.id);
    if(path.startsWith("/calendar/items/")&&params.id){if(params.kind==="youtube")await video(params.id);else if(params.kind==="variant")await variant(params.id);else deny();}
    if (restricted) {
      // These handlers return workspace-wide data or have no ownership link for media blobs.
      if (/^\/(analytics|calendar|approvals|publications)(\/|$)/.test(path) && read && !params.id && !params.publicationId && !params.approvalId && !["/calendar/items","/approvals"].includes(path)) deny();
      
      if(path.startsWith("/youtube/media/"))deny();
      if(path.startsWith("/content-collections") && !body.workflowId && !(request.query as any)?.workflowId)deny();
      if(path==="/workflows" && !read && auth.workflowIds!=null)deny();
    }
  } catch (error) {
    if (error instanceof TenantPolicyError) throw error;
    if (!(error instanceof Denied)) { request.log.warn({ error: error instanceof Error ? error.name : "authorization" },"Authorization lookup failed"); }
    await reply.code(403).send({ error:"access_denied", message:"برای این اقدام یا مقصد دسترسی ندارید." });
  }
}

/** Called by onSend for the four supported scoped aggregate response shapes. */
export async function filterScopedAccessResponse(db: Db, request: FastifyRequest, payload: unknown): Promise<unknown> {
  if (request.auth.channelIds == null && request.auth.workflowIds == null) return payload;
  const path = request.url.split("?")[0];
  if (!["/calendar/items","/youtube/items","/workflow-approvals","/approvals"].includes(path)) return payload;
  if (!Array.isArray(payload)) return []; // Unknown shapes cannot expose workspace data.
  const result: unknown[] = [];
  for (const item of payload) {
    if (!item || typeof item !== "object") continue;
    const value = item as Record<string, any>;
    let route: string; let params: Record<string,unknown>;
    if (path==="/calendar/items") {
      if (!["variant","youtube"].includes(value.kind) || typeof value.sourceId!=="string") continue;
      route=`/calendar/items/${value.kind}/${value.sourceId}/events`;params={kind:value.kind,id:value.sourceId};
    } else if(path==="/youtube/items") {route=`/youtube/items/${value.id}`;params={id:value.id};}
    else if(path==="/workflow-approvals") {route=`/runs/${value.runId}`;params={runId:value.runId};}
    else {route=`/approvals/${value.approval?.id}`;params={approvalId:value.approval?.id};}
    let denied=false;
    const guardReply={code(){return this;},async send(){denied=true;}} as unknown as FastifyReply;
    const guardRequest={auth:request.auth,url:route,method:"GET",params,query:{},body:undefined,log:request.log} as unknown as FastifyRequest;
    await enforceAccess(db,guardRequest,guardReply);
    if(!denied)result.push(item);
  }
  return result;
}
