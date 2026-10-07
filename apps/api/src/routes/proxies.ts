import { and, desc, eq, or, getTableColumns } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDb, publishingProxies, connectionChecks, encryptSecret, decryptSecret, validateProxyHost, connectionPolicy,
  publicationConnectionEvents, contentVariants, contentItems, publications, youtubeItems } from "@socialyar/db";
import { connectionCheckQueue } from "../queue";

const fields = z.object({ name: z.string().trim().min(1).max(100), protocol: z.enum(["http", "https", "socks5"]),
  host: z.string().trim().min(1).max(253), port: z.number().int().min(1).max(65535),
  username: z.string().max(255).optional(), password: z.string().max(255).optional(), clearCredentials: z.boolean().optional(), isActive: z.boolean() });
export const policySchema = z.object({ mode: z.enum(["direct", "proxy", "auto"]), proxyId: z.string().uuid().optional() });
const targetSchema = z.enum(["youtube", "telegram", "instagram", "dropbox"]);
function safeProxy({ authEnc, ...proxy }: typeof publishingProxies.$inferSelect) { return { ...proxy, hasCredentials: Boolean(authEnc) }; }
export async function proxyRoutes(app: FastifyInstance) {
  const db = getDb(); app.addHook("onRequest", app.authenticate);
  app.get("/proxies", async (request) => {
    const rows = await db.select().from(publishingProxies).where(eq(publishingProxies.workspaceId, request.auth.workspaceId)).orderBy(desc(publishingProxies.createdAt));
    const checks = await db.select().from(connectionChecks).where(eq(connectionChecks.workspaceId, request.auth.workspaceId)).orderBy(desc(connectionChecks.createdAt)).limit(100);
    return rows.map((proxy) => ({ ...safeProxy(proxy), checks: checks.filter((check) => check.proxyId === proxy.id) }));
  });
  app.post("/proxies", async (request, reply) => {
    const input = fields.parse(request.body); await validateProxyHost(input.host);
    const [proxy] = await db.insert(publishingProxies).values({ workspaceId: request.auth.workspaceId,
      name: input.name, protocol: input.protocol, host: input.host, port: input.port, isActive: input.isActive,
      authEnc: input.username || input.password ? encryptSecret(JSON.stringify({ username: input.username ?? "", password: input.password ?? "" })) : null }).returning();
    return reply.code(201).send(safeProxy(proxy));
  });
  app.patch("/proxies/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params); const input = fields.parse(request.body);
    const [current] = await db.select().from(publishingProxies).where(and(eq(publishingProxies.id, id), eq(publishingProxies.workspaceId, request.auth.workspaceId)));
    if (!current) return reply.code(404).send({ error: "proxy_not_found" });
    await validateProxyHost(input.host);
    const previous = current.authEnc ? JSON.parse(decryptSecret(current.authEnc)) as { username: string; password: string } : { username: "", password: "" };
    const [proxy] = await db.update(publishingProxies).set({ name: input.name, protocol: input.protocol, host: input.host,
      port: input.port, isActive: input.isActive, updatedAt: new Date(),
      authEnc: input.clearCredentials ? null : input.username !== undefined || input.password !== undefined ?
        encryptSecret(JSON.stringify({ username: input.username ?? previous.username, password: input.password ?? previous.password })) : current.authEnc,
    }).where(and(eq(publishingProxies.id, id), eq(publishingProxies.workspaceId, request.auth.workspaceId))).returning();
    return safeProxy(proxy);
  });
  app.delete("/proxies/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const deleted = await db.delete(publishingProxies).where(and(eq(publishingProxies.id, id), eq(publishingProxies.workspaceId, request.auth.workspaceId))).returning({ id: publishingProxies.id });
    return deleted.length ? { ok: true } : reply.code(404).send({ error: "proxy_not_found" });
  });
  app.post("/connection-checks", async (request, reply) => {
    const input = z.object({ target: targetSchema, connection: policySchema }).parse(request.body); const policy = connectionPolicy(input.connection);
    if (policy.proxyId) {
      const [proxy] = await db.select().from(publishingProxies).where(and(eq(publishingProxies.id, policy.proxyId), eq(publishingProxies.workspaceId, request.auth.workspaceId), eq(publishingProxies.isActive, true)));
      if (!proxy) return reply.code(400).send({ error: "proxy_inactive_or_not_found" });
    }
    const [check] = await db.insert(connectionChecks).values({ workspaceId: request.auth.workspaceId, proxyId: policy.proxyId,
      target: input.target, config: policy }).returning();
    try { await connectionCheckQueue.add("connection-check", { checkId: check.id }, { jobId: `check-${check.id}`, attempts: 1, removeOnComplete: 100, removeOnFail: 100 }); }
    catch { await db.update(connectionChecks).set({ status: "failed", checkedAt: new Date(), result: { reachable: false, error: "صف بررسی اتصال در دسترس نیست." } }).where(eq(connectionChecks.id, check.id)); return reply.code(503).send({ error: "connection_check_queue_unavailable" }); }
    return reply.code(202).send(check);
  });
  app.get("/connection-checks/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const [check] = await db.select().from(connectionChecks).where(and(eq(connectionChecks.id, id), eq(connectionChecks.workspaceId, request.auth.workspaceId)));
    return check ?? reply.code(404).send({ error: "check_not_found" });
  });
  app.get("/publication-connection-events", async (request) => {
    const query = z.object({ publicationId: z.string().uuid().optional(), youtubeItemId: z.string().uuid().optional(), runId: z.string().uuid().optional() }).parse(request.query);
    return db.select(getTableColumns(publicationConnectionEvents)).from(publicationConnectionEvents)
      .leftJoin(publications, eq(publicationConnectionEvents.publicationId, publications.id))
      .leftJoin(contentVariants, eq(publications.contentVariantId, contentVariants.id))
      .leftJoin(contentItems, eq(contentVariants.contentItemId, contentItems.id))
      .leftJoin(youtubeItems, eq(publicationConnectionEvents.youtubeItemId, youtubeItems.id))
      .where(and(eq(publicationConnectionEvents.workspaceId, request.auth.workspaceId),
      query.publicationId ? eq(publicationConnectionEvents.publicationId, query.publicationId) : undefined,
      query.runId ? or(eq(contentItems.runId, query.runId), eq(youtubeItems.runId, query.runId)) : undefined,
      query.youtubeItemId ? eq(publicationConnectionEvents.youtubeItemId, query.youtubeItemId) : undefined)).orderBy(desc(publicationConnectionEvents.createdAt)).limit(100);
  });
}
