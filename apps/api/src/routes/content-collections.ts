import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { collectionDiff, collectionRowSchema, collectionRowsSchema } from "@socialyar/shared";
import { getDb, contentCollections, collectionImportEvents, youtubeItems, workflows, workflowVersions, workflowSteps, workflowConnections,
  socialAccounts, validateConnectionPolicy, youtubeToken, publishingTransport, googleJson, fetchCollectionMedia, storeYoutubeMedia } from "@socialyar/db";
import { connectionCheckQueue, publicationQueue } from "../queue";
const scope = z.object({ workflowId: z.string().uuid(), sourceStepKey: z.string().min(1), targetStepKey: z.string().min(1) });
const previewSchema = scope.extend({ rows: collectionRowsSchema, detectRemovals: z.boolean().default(true) });
const applySchema = previewSchema.extend({ revision: z.number().int().min(0), selected: z.array(z.object({ id: z.string(), version: z.number().nullable(), updatedAt: z.string().nullable() })).min(1).max(500) });
class ImportConflict extends Error {}
export async function contentCollectionRoutes(app: FastifyInstance, options: { database?: ReturnType<typeof getDb>; queue?: Pick<typeof publicationQueue,"add"> } = {}) {
  const db = options.database ?? getDb(); const queue = options.queue ?? publicationQueue; app.addHook("onRequest", app.authenticate);
  app.post("/content-collections/update-published", async (request,reply) => {
    const input = scope.extend({ row:collectionRowSchema, revision:z.number().int(), version:z.number().int(), updatedAt:z.string().datetime() }).parse(request.body);
    try {
      await destination(db,request.auth.workspaceId,input);
      await db.transaction(async (tx) => {
        const [collection] = await tx.select().from(contentCollections).where(collectionWhere(request.auth.workspaceId,input)).for("update");
        if (!collection || collection.revision!==input.revision) throw new ImportConflict("مجموعه تغییر کرده است؛ پیش‌نمایش را تازه کنید.");
        const record = collection.records.find((r) => r.row.id===input.row.id);
        if (!record) throw new ImportConflict("محتوا پیدا نشد.");
        const [item] = await tx.select().from(youtubeItems).where(and(eq(youtubeItems.id,record.itemId),eq(youtubeItems.workspaceId,request.auth.workspaceId))).for("update");
        const change = collectionDiff([input.row],[record],item ? [item] : [])[0];
        if (!item || !change.remoteEligible || item.queueVersion!==input.version || item.updatedAt.toISOString()!==input.updatedAt) throw new ImportConflict("این ویرایش برای محتوای منتشرشده مجاز نیست یا وضعیت آن تغییر کرده است.");
        const transport = await publishingTransport(item.workspaceId,item.settings.connection,"youtube");
        try {
          const { token,privateOnly } = await youtubeToken(item.accountId,item.workspaceId,transport.fetch);
          const headers = { Authorization:`Bearer ${token}`,"Content-Type":"application/json" };
          const current = await googleJson(await transport.fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,status&id=${encodeURIComponent(item.videoId!)}`,{ headers,signal:AbortSignal.timeout(15000) }));
          const video = current.items?.[0]; if (!video) throw new Error("ویدئوی منتشرشده در کانال پیدا نشد.");
          const fields = change.fields; const title=fields.includes("title") ? input.row.title : video.snippet.title;
          const description=fields.includes("description") ? input.row.description : video.snippet.description;
          const tags=fields.includes("tags") ? input.row.tags : video.snippet.tags ?? [];
          const privacy=fields.includes("privacy") ? privateOnly ? "private" : input.row.privacy : video.status.privacyStatus;
          const madeForKids=fields.includes("madeForKids") ? input.row.madeForKids : video.status.selfDeclaredMadeForKids ?? false;
          let coverMediaId: string | undefined;
          if (fields.includes("coverUrl")) {
            const cover = await fetchCollectionMedia(item.workspaceId,input.row.coverUrl,"image",item.settings.mediaConnection);
            coverMediaId = (await storeYoutubeMedia(item.workspaceId,cover.bytes)).mediaId;
            await googleJson(await transport.fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(item.videoId!)}&uploadType=media`,{
              method:"POST",headers:{ Authorization:`Bearer ${token}`,"Content-Type":cover.type },body:new Uint8Array(cover.bytes),signal:AbortSignal.timeout(30000) }));
          }
          await googleJson(await transport.fetch("https://www.googleapis.com/youtube/v3/videos?part=snippet,status",{ method:"PUT",headers,
            body:JSON.stringify({ id:item.videoId,snippet:{ title,description,tags,categoryId:video.snippet.categoryId },status:{ privacyStatus:privacy,selfDeclaredMadeForKids:madeForKids } }),signal:AbortSignal.timeout(15000) }));
          const settings: Record<string,unknown> = { ...item.settings, ...(coverMediaId ? { coverMediaId } : {}) }; for (const key of ["tags","privacy","madeForKids","coverUrl"] as const) if (fields.includes(key)) settings[key]=input.row[key];
          await tx.update(youtubeItems).set({ title,description,settings,actualPrivacy:privacy,queueVersion:item.queueVersion+1,updatedAt:new Date(),
            logs:[...item.logs,{ result:"metadata_updated",time:new Date().toISOString(),channel:item.channelName,userId:request.auth.userId }] }).where(eq(youtubeItems.id,item.id));
          await tx.update(contentCollections).set({ revision:collection.revision+1,updatedAt:new Date(),records:collection.records.map((r) => r.row.id===input.row.id ? { ...r,row:input.row } : r) }).where(eq(contentCollections.id,collection.id));
          await tx.insert(collectionImportEvents).values({ collectionId:collection.id,workspaceId:request.auth.workspaceId,userId:request.auth.userId,revision:collection.revision+1,detail:{ action:"update_published",id:input.row.id,fields } });
        } finally { await transport.close(); }
      });
      return { ok:true };
    } catch (e) { return reply.code(409).send({ error:e instanceof Error ? e.message : "به‌روزرسانی یوتیوب ناموفق بود." }); }
  });
  app.post("/content-collections/test-media", async (request, reply) => {
    const { connectionChecks } = await import("@socialyar/db");
    const input = scope.extend({ videoUrl: z.string().url() }).parse(request.body);
    const target = await destination(db,request.auth.workspaceId,input);
    await validateConnectionPolicy(request.auth.workspaceId,target.source.config.mediaConnection);
    const policy = target.source.config.mediaConnection as { proxyId?: string } | undefined;
    const [check] = await db.insert(connectionChecks).values({ workspaceId:request.auth.workspaceId,proxyId:policy?.proxyId,target:"media",
      config:{ connection:target.source.config.mediaConnection, videoUrl:input.videoUrl } }).returning();
    try { await connectionCheckQueue.add("connection-check",{ checkId:check.id },{ jobId:`check-${check.id}`,attempts:1,removeOnComplete:100,removeOnFail:100 }); }
    catch { await db.update(connectionChecks).set({ status:"failed",checkedAt:new Date(),result:{ reachable:false,error:"صف بررسی فایل در دسترس نیست." } }).where(eq(connectionChecks.id,check.id)); return reply.code(503).send({ error:"صف بررسی فایل در دسترس نیست." }); }
    return reply.code(202).send(check);
  });
  app.get("/content-collections", async (request) => {
    const input = z.object({ workflowId: z.string().uuid(), sourceStepKey: z.string() }).parse(request.query);
    return db.select({ id: contentCollections.id, targetStepKey: contentCollections.targetStepKey, revision: contentCollections.revision,
      records: contentCollections.records, updatedAt: contentCollections.updatedAt }).from(contentCollections)
      .where(and(eq(contentCollections.workspaceId, request.auth.workspaceId), eq(contentCollections.workflowId, input.workflowId), eq(contentCollections.sourceStepKey, input.sourceStepKey)));
  });
  app.post("/content-collections/preview", { bodyLimit: 4_000_000 }, async (request, reply) => {
    const input = previewSchema.parse(request.body);
    try {
      await destination(db, request.auth.workspaceId, input);
      const [collection] = await db.select().from(contentCollections).where(collectionWhere(request.auth.workspaceId, input));
      const ids = collection?.records.map((r) => r.itemId) ?? [];
      const items = ids.length ? await db.select().from(youtubeItems).where(and(eq(youtubeItems.workspaceId, request.auth.workspaceId), inArray(youtubeItems.id, ids))) : [];
      return { revision: collection?.revision ?? 0, changes: collectionDiff(input.rows, collection?.records ?? [], items).filter((c) => input.detectRemovals || c.kind !== "removed") };
    } catch (e) { return reply.code(409).send({ error: e instanceof Error ? e.message : "بررسی مجموعه ناموفق بود." }); }
  });
  app.post("/content-collections/apply", { bodyLimit: 4_000_000 }, async (request, reply) => {
    const input = applySchema.parse(request.body);
    try {
      const target = await destination(db, request.auth.workspaceId, input);
      await validateConnectionPolicy(request.auth.workspaceId, target.step.config.connection);
      await validateConnectionPolicy(request.auth.workspaceId, target.source.config.mediaConnection);
      const result = await db.transaction(async (tx) => {
        await tx.insert(contentCollections).values({ workspaceId: request.auth.workspaceId, workflowId: input.workflowId,
          sourceStepKey: input.sourceStepKey, targetStepKey: input.targetStepKey }).onConflictDoNothing();
        const [collection] = await tx.select().from(contentCollections).where(collectionWhere(request.auth.workspaceId, input)).for("update");
        if (collection.revision !== input.revision) throw new ImportConflict("مجموعه تغییر کرده است؛ پیش‌نمایش را دوباره دریافت کنید.");
        const ids = collection.records.map((r) => r.itemId);
        const items = ids.length ? await tx.select().from(youtubeItems).where(and(eq(youtubeItems.workspaceId, request.auth.workspaceId), inArray(youtubeItems.id, ids))).for("update") : [];
        const changes = collectionDiff(input.rows, collection.records, items).filter((c) => input.detectRemovals || c.kind !== "removed");
        const records = new Map(collection.records.map((r) => [r.row.id, r]));
        const tasks: Array<{ id: string; version: number }> = []; const applied: Array<{ id: string; kind: string }> = [];
        const selectedIds = new Set<string>();
        for (const selection of input.selected) {
          if (selectedIds.has(selection.id)) throw new ImportConflict("انتخاب تکراری است."); selectedIds.add(selection.id);
          const change = changes.find((c) => c.id === selection.id);
          if (!change || change.kind === "unchanged" || change.blocked) throw new ImportConflict(change?.blocked ?? "تغییر انتخاب‌شده معتبر نیست.");
          if (change.version !== selection.version || change.updatedAt !== selection.updatedAt) throw new ImportConflict("وضعیت یکی از ویدئوها تغییر کرده است؛ پیش‌نمایش را تازه کنید.");
          const old = items.find((i) => i.id === change.itemId); const row = change.row;
          if (change.kind === "removed") {
            await tx.update(youtubeItems).set({ status: "cancelled", queueVersion: old!.queueVersion + 1, approvedAt: null, approvedBy: null, updatedAt: new Date() }).where(eq(youtubeItems.id, old!.id));
            records.set(row.id, { row, itemId: old!.id, active: false });
          } else {
            if (row.scheduledAt && Date.parse(row.scheduledAt) <= Date.now()) throw new ImportConflict(`زمان انتشار «${row.title}» گذشته است؛ زمان آینده تعیین کنید.`);
            const settings: Record<string, unknown> = { ...(old?.settings ?? {}), collectionId: collection.id, collectionRowId: row.id, collectionSourceKey: input.sourceStepKey,
              timezone: "Asia/Tehran", mediaConnection: target.source.config.mediaConnection, connection: old?.settings.connection ?? target.step.config.connection };
            // Only changed spreadsheet fields overwrite content edited in the calendar.
            for (const key of ["videoUrl", "coverUrl", "videoType", "playlist", "order", "tags", "privacy", "madeForKids"] as const)
              if (!old || change.fields.includes(key)) settings[key] = row[key];
            if (!old || change.fields.includes("videoUrl")) { delete settings.videoMediaId; settings.sourceVideoUrl = row.videoUrl; }
            if (!old || change.fields.includes("coverUrl")) { delete settings.coverMediaId; settings.sourceCoverUrl = row.coverUrl; }
            const prepare = !settings.videoMediaId || Boolean(settings.coverUrl && !settings.coverMediaId) || change.fields.includes("videoType");
            const values = { settings, title: !old || change.fields.includes("title") ? row.title : old.title,
              description: !old || change.fields.includes("description") ? row.description : old.description,
              scheduledAt: !old || change.fields.includes("scheduledAt") ? row.scheduledAt ? new Date(row.scheduledAt) : null : old.scheduledAt,
              status: prepare ? "waiting_video" : "waiting_approval", approvedAt: null, approvedBy: null, error: null,
              queueVersion: (old?.queueVersion ?? -1) + 1, updatedAt: new Date() };
            let itemId = old?.id;
            if (old) await tx.update(youtubeItems).set(values).where(eq(youtubeItems.id, old.id));
            else {
              const [created] = await tx.insert(youtubeItems).values({ ...values, workspaceId: request.auth.workspaceId,
                workflowId: input.workflowId, stepKey: input.targetStepKey, itemKey: `collection:${collection.id}:${row.id}`,
                accountId: target.account.id, channelName: target.account.displayName ?? target.account.externalAccountId }).returning();
              itemId = created.id;
            }
            records.set(row.id, { row, itemId: itemId!, active: true });
            if (prepare) tasks.push({ id: itemId!, version: values.queueVersion });
          }
          applied.push({ id: row.id, kind: change.kind });
        }
        await tx.update(contentCollections).set({ records: [...records.values()], revision: collection.revision + 1, updatedAt: new Date() }).where(eq(contentCollections.id, collection.id));
        await tx.insert(collectionImportEvents).values({ collectionId: collection.id, workspaceId: request.auth.workspaceId,
          userId: request.auth.userId, revision: collection.revision + 1, detail: { applied } });
        return { tasks, applied };
      });
      let queueFailures = 0;
      for (const task of result.tasks) {
        try { await queue.add("youtube-prepare", { youtubeItemId: task.id, queueVersion: task.version },
          { jobId: `youtube-prepare-${task.id}-v${task.version}`, attempts: 2, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 1000, removeOnFail: 1000 }); }
        catch { queueFailures++; await db.update(youtubeItems).set({ status: "failed", error: "صف دریافت فایل در دسترس نیست؛ دریافت مجدد را بزنید.", updatedAt: new Date() })
          .where(and(eq(youtubeItems.id, task.id), eq(youtubeItems.queueVersion, task.version), eq(youtubeItems.status, "waiting_video"))); }
      }
      return { ok: true, applied: result.applied, queueFailures };
    } catch (e) { return reply.code(409).send({ error: e instanceof Error ? e.message : "ثبت مجموعه ناموفق بود." }); }
  });
}
function collectionWhere(workspaceId: string, input: z.infer<typeof scope>) {
  return and(eq(contentCollections.workspaceId, workspaceId), eq(contentCollections.workflowId, input.workflowId),
    eq(contentCollections.sourceStepKey, input.sourceStepKey), eq(contentCollections.targetStepKey, input.targetStepKey));
}
async function destination(db: ReturnType<typeof getDb>, workspaceId: string, input: z.infer<typeof scope>) {
  const [workflow] = await db.select().from(workflows).where(and(eq(workflows.id, input.workflowId), eq(workflows.workspaceId, workspaceId)));
  if (!workflow) throw new ImportConflict("جریان پیدا نشد.");
  const [version] = await db.select().from(workflowVersions).where(eq(workflowVersions.workflowId, workflow.id)).orderBy(desc(workflowVersions.version)).limit(1);
  if (!version) throw new ImportConflict("ابتدا جریان را ذخیره کنید.");
  const steps = await db.select().from(workflowSteps).where(eq(workflowSteps.workflowVersionId, version.id));
  const source = steps.find((s) => s.key === input.sourceStepKey && s.type === "collection_source");
  const step = steps.find((s) => s.key === input.targetStepKey && s.type === "publish");
  if (!source || !step) throw new ImportConflict("کارت مجموعه و انتشار را ذخیره کنید.");
  const [edge] = await db.select().from(workflowConnections).where(and(eq(workflowConnections.workflowVersionId, version.id), eq(workflowConnections.sourceStepId, source.id), eq(workflowConnections.targetStepId, step.id)));
  if (!edge) throw new ImportConflict("کارت مجموعه را مستقیم به کارت انتشار یوتیوب وصل و جریان را ذخیره کنید.");
  if (!z.string().uuid().safeParse(step.config.accountId).success) throw new ImportConflict("کانال یوتیوب را در کارت مقصد انتخاب و جریان را ذخیره کنید.");
  const [account] = await db.select().from(socialAccounts).where(and(eq(socialAccounts.id, String(step.config.accountId)), eq(socialAccounts.workspaceId, workspaceId), eq(socialAccounts.channel, "youtube"), eq(socialAccounts.isActive, true)));
  if (!account) throw new ImportConflict("در کارت مقصد، کانال فعال یوتیوب را انتخاب کنید.");
  return { step, account, source };
}
