import { desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { getDb, users, workspaces, workspaceMembers, workspaceSubscriptions, auditLogs, socialAccounts, workflows, runs, runEvents, aiUsageEvents } from "@socialyar/db";
import { normalizePhone, hashPassword } from "../password";

const createSchema = z.object({ name: z.string().trim().min(1).max(160), slug: z.string().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), managerPhone: z.string().min(8).max(40), managerName: z.string().trim().min(1).max(120), managerPassword: z.string().min(10).max(200) });
const quota = z.number().int().min(0).max(2147483647).nullable();
const subscriptionSchema = z.object({ plan: z.string().trim().min(1).max(80), status: z.enum(["active", "suspended", "cancelled", "expired"]), expiresAt: z.string().datetime({ offset: true }).nullable(), maxUsers: z.number().int().min(1).max(2147483647).nullable(), maxChannels: quota, maxWorkflows: quota, aiTokenLimit: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable() }).partial().refine(value => Object.keys(value).length > 0);
const workspaceParams = z.object({ id: z.string().uuid() });

export async function platformRoutes(app: FastifyInstance, options: { db?: ReturnType<typeof getDb> } = {}) {
  const db = options.db ?? getDb();
  const platformGuard = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.auth.isPlatformAdmin) return reply.code(403).send({ error: "platform_admin_required", message: "این بخش فقط برای مدیر سامانه در دسترس است." });
  };
  app.get("/platform/workspaces", { onRequest: [app.authenticate], preHandler: platformGuard }, async request => {
    const list = await db.select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug, subscription: workspaceSubscriptions }).from(workspaces).leftJoin(workspaceSubscriptions, eq(workspaceSubscriptions.workspaceId, workspaces.id)).orderBy(desc(workspaces.createdAt)).limit(500);
    await db.insert(auditLogs).values({ actorId: request.auth.userId, action: "platform.workspaces_viewed", targetType: "platform", detail: {} });
    return { workspaces: list };
  });
  app.post("/platform/workspaces", { onRequest: [app.authenticate], preHandler: platformGuard }, async (request, reply) => {
    const input = createSchema.parse(request.body);
    let phone: string;
    try { phone = normalizePhone(input.managerPhone); } catch { return reply.code(400).send({ error: "invalid_phone", message: "شماره موبایل معتبر نیست." }); }
    const passwordHash = await hashPassword(input.managerPassword);
    try {
      const result = await db.transaction(async tx => {
        const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.phone, phone));
        if (existing) return null;
        const [manager] = await tx.insert(users).values({ phone, name: input.managerName, passwordHash, mustChangePassword: true }).returning({ id: users.id });
        const [workspace] = await tx.insert(workspaces).values({ name: input.name, slug: input.slug, ownerId: manager.id }).returning({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug });
        await tx.insert(workspaceMembers).values({ workspaceId: workspace.id, userId: manager.id, role: "manager" });
        const [subscription] = await tx.insert(workspaceSubscriptions).values({ workspaceId: workspace.id, plan: "trial", status: "active", expiresAt: new Date(Date.now() + 14 * 86400000), maxUsers: 3, maxChannels: 3, maxWorkflows: 3, aiTokenLimit: 100000 }).returning();
        await tx.insert(auditLogs).values({ workspaceId: workspace.id, actorId: request.auth.userId, action: "platform.workspace_created", targetType: "workspace", targetId: workspace.id, detail: { managerId: manager.id, plan: "trial" } });
        return { ...workspace, subscription };
      });
      if (!result) return reply.code(409).send({ error: "phone_already_registered", message: "این شماره قبلاً ثبت شده است؛ برای اتصال حساب موجود باید دسترسی آن جدا بررسی شود." });
      return reply.code(201).send({ workspace: result });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") return reply.code(409).send({ error: "workspace_or_phone_exists", message: "شناسه سازمان یا شماره موبایل قبلاً ثبت شده است." });
      throw error;
    }
  });
  app.patch("/platform/workspaces/:id", { onRequest: [app.authenticate], preHandler: platformGuard }, async (request, reply) => {
    const { id } = workspaceParams.parse(request.params);
    const input = subscriptionSchema.parse(request.body);
    const subscription = await db.transaction(async tx => {
      const [workspace] = await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, id)).for("update");
      if (!workspace) return null;
      const { expiresAt, ...rest } = input;
      const update = { ...rest, ...(expiresAt !== undefined ? { expiresAt: expiresAt === null ? null : new Date(expiresAt) } : {}), updatedAt: new Date() };
      const [result] = await tx.insert(workspaceSubscriptions).values({ workspaceId: id, ...update }).onConflictDoUpdate({ target: workspaceSubscriptions.workspaceId, set: update }).returning();
      await tx.insert(auditLogs).values({ workspaceId: id, actorId: request.auth.userId, action: "platform.subscription_updated", targetType: "workspace", targetId: id, detail: { fields: Object.keys(input) } });
      return result;
    });
    if (!subscription) return reply.code(404).send({ error: "workspace_not_found", message: "سازمان پیدا نشد." });
    return { subscription };
  });
  app.get("/platform/workspaces/:id/activity", { onRequest: [app.authenticate], preHandler: platformGuard }, async (request, reply) => {
    const { id } = workspaceParams.parse(request.params);
    const [workspace] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, id));
    if (!workspace) return reply.code(404).send({ error: "workspace_not_found", message: "سازمان پیدا نشد." });
    await db.insert(auditLogs).values({ workspaceId: id, actorId: request.auth.userId, action: "platform.workspace_activity_viewed", targetType: "workspace", targetId: id, detail: {} });
    const [channels, flows, recentRuns, events, activity, totals] = await Promise.all([
      db.select({ id: socialAccounts.id, channel: socialAccounts.channel, displayName: socialAccounts.displayName, isActive: socialAccounts.isActive }).from(socialAccounts).where(eq(socialAccounts.workspaceId, id)),
      db.select({ id: workflows.id, name: workflows.name, status: workflows.status }).from(workflows).where(eq(workflows.workspaceId, id)),
      db.select({ id: runs.id, workflowId: runs.workflowId, status: runs.status, createdAt: runs.createdAt, finishedAt: runs.finishedAt }).from(runs).innerJoin(workflows, eq(workflows.id, runs.workflowId)).where(eq(workflows.workspaceId, id)).orderBy(desc(runs.createdAt)).limit(100),
      db.select({ id: runEvents.id, runId: runEvents.runId, type: runEvents.type, createdAt: runEvents.createdAt }).from(runEvents).innerJoin(runs, eq(runs.id, runEvents.runId)).innerJoin(workflows, eq(workflows.id, runs.workflowId)).where(eq(workflows.workspaceId, id)).orderBy(desc(runEvents.createdAt)).limit(100),
      db.select({ id: auditLogs.id, action: auditLogs.action, actorId: auditLogs.actorId, targetType: auditLogs.targetType, targetId: auditLogs.targetId, detail: auditLogs.detail, createdAt: auditLogs.createdAt }).from(auditLogs).where(eq(auditLogs.workspaceId, id)).orderBy(desc(auditLogs.createdAt)).limit(100),
      db.select({ inputTokens: sql<number>`coalesce(sum(${aiUsageEvents.inputTokens}), 0)`, outputTokens: sql<number>`coalesce(sum(${aiUsageEvents.outputTokens}), 0)`, costMicros: sql<number>`coalesce(sum(${aiUsageEvents.costMicros}), 0)` }).from(aiUsageEvents).where(eq(aiUsageEvents.workspaceId, id)),
    ]);
    return { channels, workflows: flows, runs: recentRuns, runEvents: events,
      activity: activity.map(entry => ({ ...entry, detail: Object.fromEntries(Object.entries(entry.detail ?? {}).filter(([key, value]) =>
        ["role", "plan", "passwordReset", "managerId", "fields"].includes(key) && (typeof value === "string" || typeof value === "boolean" || Array.isArray(value) && value.every(item => typeof item === "string")))) })), usage: { inputTokens: Number(totals[0]?.inputTokens ?? 0), outputTokens: Number(totals[0]?.outputTokens ?? 0), costMicros: Number(totals[0]?.costMicros ?? 0) } };
  });
}
