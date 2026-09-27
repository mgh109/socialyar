import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { apiConnections, decryptSecret, encryptSecret, ensureCommentStorage, getDb, secretConfigurationProblem, workflowSteps, workflowVersions, workflows } from "@socialyar/db";
import { apiRequest, inspectApiComments, validApiBase } from "@socialyar/workflow/api-client";
import { connection as redis } from "../queue";

const schema = z.object({
  name: z.string().trim().min(1).max(80), baseUrl: z.string().url(), authType: z.enum(["bearer", "api_key"]),
  headerName: z.string().max(60).nullable().optional(), token: z.string().min(1).optional(),
});
const params = z.object({ id: z.string().uuid() });
const previewSchema = z.object({ path: z.string().startsWith("/").max(300), itemsPath: z.string().min(1).max(150),
  idField: z.string().min(1).max(100), textField: z.string().min(1).max(100), contextField: z.string().max(100).optional(),
  readMode: z.enum(["single", "batch", "post"]).optional(), postId: z.string().max(100).optional(),
  postIdField: z.string().max(100).optional(), batchLimit: z.union([z.literal(10), z.literal(25), z.literal(50)]).optional() });
const publicFields = { id: apiConnections.id, name: apiConnections.name, baseUrl: apiConnections.baseUrl,
  authType: apiConnections.authType, headerName: apiConnections.headerName };

export async function apiConnectionRoutes(app: FastifyInstance) {
  const db = getDb(); app.addHook("onRequest", app.authenticate);
  app.get("/api-connections", async (request) => {
    await ensureCommentStorage();
    return db.select(publicFields).from(apiConnections).where(eq(apiConnections.workspaceId, request.auth.workspaceId));
  });
  app.post("/api-connections", async (request, reply) => {
    const input = schema.parse(request.body);
    if (!validApiBase(input.baseUrl) || input.authType === "api_key" && !/^X-[A-Za-z0-9-]{1,60}$/i.test(input.headerName ?? ""))
      return reply.code(400).send({ error: "invalid_api_connection" });
    if (!input.token) return reply.code(400).send({ error: "token_required" });
    const problem = secretConfigurationProblem(); if (problem) return reply.code(503).send({ error: problem });
    await ensureCommentStorage();
    const [row] = await db.insert(apiConnections).values({ workspaceId: request.auth.workspaceId, name: input.name,
      baseUrl: input.baseUrl, authType: input.authType, headerName: input.authType === "api_key" ? input.headerName : null,
      encryptedToken: encryptSecret(input.token) }).returning(publicFields);
    return reply.code(201).send(row);
  });
  app.put("/api-connections/:id", async (request, reply) => {
    const { id } = params.parse(request.params), input = schema.parse(request.body);
    if (!validApiBase(input.baseUrl) || input.authType === "api_key" && !/^X-[A-Za-z0-9-]{1,60}$/i.test(input.headerName ?? ""))
      return reply.code(400).send({ error: "invalid_api_connection" });
    await ensureCommentStorage();
    const [existing] = await db.select().from(apiConnections).where(and(eq(apiConnections.id, id),
      eq(apiConnections.workspaceId, request.auth.workspaceId))).limit(1);
    if (!existing) return reply.code(404).send({ error: "api_connection_not_found" });
    const problem = secretConfigurationProblem(); if (problem) return reply.code(503).send({ error: problem });
    const [row] = await db.update(apiConnections).set({ name: input.name, baseUrl: input.baseUrl,
      authType: input.authType, headerName: input.authType === "api_key" ? input.headerName : null,
      encryptedToken: input.token ? encryptSecret(input.token) : existing.encryptedToken, updatedAt: new Date() })
      .where(eq(apiConnections.id, id)).returning(publicFields);
    return row;
  });
  app.post("/api-connections/:id/test", async (request, reply) => {
    const { id } = params.parse(request.params);
    const { path } = z.object({ path: z.string().startsWith("/").max(300) }).parse(request.body);
    await ensureCommentStorage();
    const [row] = await db.select().from(apiConnections).where(and(eq(apiConnections.id, id),
      eq(apiConnections.workspaceId, request.auth.workspaceId))).limit(1);
    if (!row) return reply.code(404).send({ error: "api_connection_not_found" });
    try {
      const data = await apiRequest({ ...row, token: decryptSecret(row.encryptedToken) }, path, "GET");
      return { ok: true, sample: JSON.stringify(data).slice(0, 1000) };
    } catch (error) { return reply.code(502).send({ error: "api_connection_test_failed",
      message: error instanceof Error ? error.message : "ارتباط ناموفق بود" }); }
  });
  app.post("/api-connections/:id/preview", async (request, reply) => {
    const { id } = params.parse(request.params), config = previewSchema.parse(request.body);
    await ensureCommentStorage();
    const [row] = await db.select().from(apiConnections).where(and(eq(apiConnections.id, id),
      eq(apiConnections.workspaceId, request.auth.workspaceId))).limit(1);
    if (!row) return reply.code(404).send({ error: "api_connection_not_found" });
    try {
      const response = await apiRequest({ ...row, token: decryptSecret(row.encryptedToken) }, config.path, "GET");
      const result = inspectApiComments(response, config);
      return { status: "ok", rawCount: result.rawCount, matchedCount: result.matchedCount,
        selectedCount: result.selectedCount, validCount: result.validCount,
        availablePaths: result.availablePaths,
        samples: result.comments.slice(0, 3).map((item) => ({ id: item.id, text: item.text.slice(0, 180) })) };
    } catch (error) { return reply.code(422).send({ error: "api_source_preview_failed",
      message: error instanceof Error ? error.message : "خواندن کامنت‌ها ناموفق بود" }); }
  });
  app.get("/workflows/:workflowId/sources/:key/status", async (request, reply) => {
    const { workflowId, key } = z.object({ workflowId: z.string().uuid(), key: z.string().min(1).max(150) }).parse(request.params);
    const [workflow] = await db.select({ id: workflows.id, currentVersion: workflows.currentVersion }).from(workflows)
      .where(and(eq(workflows.id, workflowId), eq(workflows.workspaceId, request.auth.workspaceId))).limit(1);
    if (!workflow) return reply.code(404).send({ error: "workflow_not_found" });
    const [version] = await db.select({ id: workflowVersions.id }).from(workflowVersions)
      .where(and(eq(workflowVersions.workflowId, workflow.id), eq(workflowVersions.version, workflow.currentVersion))).limit(1);
    if (!version) return reply.code(404).send({ error: "workflow_version_not_found" });
    const [source] = await db.select({ id: workflowSteps.id }).from(workflowSteps)
      .where(and(eq(workflowSteps.workflowVersionId, version.id), eq(workflowSteps.key, key), eq(workflowSteps.type, "api_source"))).limit(1);
    if (!source) return reply.code(404).send({ error: "api_source_not_found" });
    const value = await redis.get(`source-health:${workflow.id}:${version.id}:${key}`);
    return value ? JSON.parse(value) : { status: "not_checked" };
  });
  app.delete("/api-connections/:id", async (request, reply) => {
    const { id } = params.parse(request.params);
    await ensureCommentStorage();
    const used = await db.select({ config: workflowSteps.config }).from(workflowSteps)
      .innerJoin(workflowVersions, eq(workflowSteps.workflowVersionId, workflowVersions.id))
      .innerJoin(workflows, eq(workflowVersions.workflowId, workflows.id))
      .where(eq(workflows.workspaceId, request.auth.workspaceId));
    if (used.some((item) => item.config.connectionId === id)) return reply.code(409).send({ error: "api_connection_in_use" });
    const [deleted] = await db.delete(apiConnections).where(and(eq(apiConnections.id, id),
      eq(apiConnections.workspaceId, request.auth.workspaceId))).returning({ id: apiConnections.id });
    if (!deleted) return reply.code(404).send({ error: "api_connection_not_found" });
    return reply.code(204).send();
  });
}
