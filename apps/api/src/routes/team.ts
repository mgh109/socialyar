import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { getDb, users, workspaceMembers, workspaces, reserveResourceQuota, type TenantDatabase, socialAccounts, workflows, auditLogs } from "@socialyar/db";
import { hashPassword, normalizePhone } from "../password";

const scopes = z.array(z.string().uuid()).max(1000).nullable();
const role = z.enum(["manager", "editor", "reviewer", "publisher", "viewer"]);
const fields = { name: z.string().trim().min(1).max(120), password: z.string().min(10).max(200), role, channelIds: scopes, workflowIds: scopes };
const createSchema = z.object({ ...fields, phone: z.string().min(8).max(40), role: role.default("editor"), channelIds: scopes.optional(), workflowIds: scopes.optional() });
const updateSchema = z.object({ ...fields, active: z.boolean() }).partial().refine(value => Object.keys(value).length > 0);
const errorMessages: Record<string, string> = {
  team_manager_required: "مدیریت اعضا فقط برای مدیر سازمان مجاز است.", invalid_phone: "شماره موبایل معتبر نیست.",
  scope_outside_workspace: "کانال یا جریان انتخاب‌شده متعلق به این سازمان نیست.", phone_already_registered: "این شماره قبلاً ثبت شده است؛ افزودن حساب موجود به سازمان نیازمند بررسی مدیر سامانه است.",
  cannot_edit_self: "برای حفظ دسترسی، تغییر حساب خود از این بخش مجاز نیست.", cannot_edit_owner: "تغییر حساب مدیر اصلی سازمان از این بخش مجاز نیست.",
  shared_account_credentials_locked: "اطلاعات حساب مشترک بین سازمان‌ها را فقط مدیر سامانه می‌تواند تغییر دهد.", member_not_found: "عضو پیدا نشد.",
  cannot_grant_manager: "مدیر دارای دسترسی محدود نمی‌تواند دسترسی مدیریتی اعطا کند.", cannot_expand_scope: "دسترسی عضو نمی‌تواند از دسترسی شما بیشتر باشد.",
  platform_account_locked: "حساب مدیر سامانه از مدیریت اعضای سازمان قابل تغییر نیست.", workspace_not_found: "سازمان پیدا نشد.",
};
const errorBody = (code: string) => ({ error: code, message: errorMessages[code] ?? "انجام این تغییر ممکن نیست." });
class TeamError extends Error { constructor(public code: string, public status = 409) { super(code); } }
const memberFields = { userId: users.id, name: users.name, phone: users.phone, role: workspaceMembers.role, active: sql<boolean>`${workspaceMembers.isActive} AND ${users.isActive}`, channelIds: workspaceMembers.channelIds, workflowIds: workspaceMembers.workflowIds };

export async function teamRoutes(app: FastifyInstance, options: { db?: ReturnType<typeof getDb> } = {}) {
  const db = options.db ?? getDb();
  const managerGuard = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.auth.role !== "manager" || request.auth.channelIds != null || request.auth.workflowIds != null) return reply.code(403).send(errorBody("team_manager_required"));
  };
  async function checkScopes(tx: TenantDatabase, workspaceId: string, channelIds?: string[] | null, workflowIds?: string[] | null) {
    for (const [table, ids] of [[socialAccounts, channelIds], [workflows, workflowIds]] as const) {
      if (!ids?.length) continue;
      const valid = await tx.select({ id: table.id }).from(table).where(and(eq(table.workspaceId, workspaceId), inArray(table.id, ids)));
      if (valid.length !== new Set(ids).size) throw new TeamError("scope_outside_workspace", 400);
    }
  }
  function checkGrant(auth: FastifyRequest["auth"], targetRole: string, channelIds: string[] | null, workflowIds: string[] | null) {
    if (auth.channelIds == null && auth.workflowIds == null) return;
    if (targetRole === "manager") throw new TeamError("cannot_grant_manager", 403);
    for (const [allowed, proposed] of [[auth.channelIds, channelIds], [auth.workflowIds, workflowIds]]) {
      if (allowed != null && (proposed == null || proposed.some(id => !allowed.includes(id)))) throw new TeamError("cannot_expand_scope", 403);
    }
  }
  app.get("/team", { onRequest: [app.authenticate], preHandler: managerGuard }, async request => {
    const id = request.auth.workspaceId;
    const [members, channels, flows] = await Promise.all([
      db.select(memberFields).from(workspaceMembers).innerJoin(users, eq(users.id, workspaceMembers.userId)).where(eq(workspaceMembers.workspaceId, id)),
      db.select({ id: socialAccounts.id, channel: socialAccounts.channel, displayName: socialAccounts.displayName, isActive: socialAccounts.isActive }).from(socialAccounts).where(eq(socialAccounts.workspaceId, id)),
      db.select({ id: workflows.id, name: workflows.name, status: workflows.status }).from(workflows).where(eq(workflows.workspaceId, id)),
    ]);
    return { members, channels, workflows: flows };
  });
  app.post("/team", { onRequest: [app.authenticate], preHandler: managerGuard }, async (request, reply) => {
    const input = createSchema.parse(request.body);
    let phone: string;
    try { phone = normalizePhone(input.phone); } catch { return reply.code(400).send(errorBody("invalid_phone")); }
    const passwordHash = await hashPassword(input.password);
    try {
      const member = await db.transaction(async tx => {
        await reserveResourceQuota(tx, request.auth.workspaceId, "users");
        checkGrant(request.auth, input.role, input.channelIds === undefined ? [] : input.channelIds, input.workflowIds === undefined ? [] : input.workflowIds);
        await checkScopes(tx, request.auth.workspaceId, input.channelIds, input.workflowIds);
        const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.phone, phone));
        if (existing) throw new TeamError("phone_already_registered");
        const [user] = await tx.insert(users).values({ phone, name: input.name, passwordHash, mustChangePassword: true }).returning({ id: users.id });
        const unrestricted = input.role === "manager";
        await tx.insert(workspaceMembers).values({ userId: user.id, workspaceId: request.auth.workspaceId, role: input.role, channelIds: unrestricted ? null : input.channelIds === undefined ? [] : input.channelIds, workflowIds: unrestricted ? null : input.workflowIds === undefined ? [] : input.workflowIds });
        await tx.insert(auditLogs).values({ workspaceId: request.auth.workspaceId, actorId: request.auth.userId, action: "team.member_created", targetType: "user", targetId: user.id, detail: { role: input.role } });
        const [result] = await tx.select(memberFields).from(workspaceMembers).innerJoin(users, eq(users.id, workspaceMembers.userId)).where(and(eq(workspaceMembers.workspaceId, request.auth.workspaceId), eq(users.id, user.id)));
        return result;
      });
      return reply.code(201).send({ member });
    } catch (error) {
      if (error instanceof TeamError) return reply.code(error.status).send(errorBody(error.code));
      if ((error as { code?: string }).code === "23505") return reply.code(409).send(errorBody("phone_already_registered"));
      throw error;
    }
  });
  app.patch("/team/:userId", { onRequest: [app.authenticate], preHandler: managerGuard }, async (request, reply) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params);
    const input = updateSchema.parse(request.body);
    if (userId === request.auth.userId) return reply.code(409).send(errorBody("cannot_edit_self"));
    const passwordHash = input.password ? await hashPassword(input.password) : undefined;
    try {
      const member = await db.transaction(async tx => {
        const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, request.auth.workspaceId)).for("update");
        if (!workspace) throw new TeamError("workspace_not_found", 404);
        if (workspace.ownerId === userId) throw new TeamError("cannot_edit_owner", 403);
        const [current] = await tx.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.userId, userId))).for("update");
        if (!current) throw new TeamError("member_not_found", 404);
        const [targetUser] = await tx.select({ platformAdmin: users.isPlatformAdmin }).from(users).where(eq(users.id, userId)).for("update");
        if (targetUser?.platformAdmin || (process.env.HOOR_PLATFORM_ADMIN_USER_IDS ?? "").split(",").map(id => id.trim()).includes(userId)) throw new TeamError("platform_account_locked", 403);
        const memberships = await tx.select({ id: workspaceMembers.workspaceId }).from(workspaceMembers).where(eq(workspaceMembers.userId, userId));
        if ((passwordHash || input.name) && memberships.length > 1) throw new TeamError("shared_account_credentials_locked", 403);
        if (input.active === true && !current.isActive) await reserveResourceQuota(tx, workspace.id, "users");
        await checkScopes(tx, workspace.id, input.channelIds, input.workflowIds);
        const nextRole = input.role ?? current.role;
        checkGrant(request.auth, nextRole, input.channelIds === undefined ? current.channelIds : input.channelIds, input.workflowIds === undefined ? current.workflowIds : input.workflowIds);
        await tx.update(workspaceMembers).set({ role: nextRole, isActive: input.active ?? current.isActive,
          channelIds: nextRole === "manager" ? null : input.channelIds !== undefined ? input.channelIds : current.channelIds,
          workflowIds: nextRole === "manager" ? null : input.workflowIds !== undefined ? input.workflowIds : current.workflowIds,
        }).where(and(eq(workspaceMembers.workspaceId, workspace.id), eq(workspaceMembers.userId, userId)));
        if (passwordHash || input.name) await tx.update(users).set({ ...(input.name ? { name: input.name } : {}), ...(passwordHash ? { passwordHash, mustChangePassword: true, sessionVersion: sql`${users.sessionVersion} + 1` } : {}), updatedAt: new Date() }).where(eq(users.id, userId));
        await tx.insert(auditLogs).values({ workspaceId: workspace.id, actorId: request.auth.userId, action: "team.member_updated", targetType: "user", targetId: userId, detail: { fields: Object.keys(input).filter(key => key !== "password"), passwordReset: Boolean(passwordHash) } });
        const [result] = await tx.select(memberFields).from(workspaceMembers).innerJoin(users, eq(users.id, workspaceMembers.userId)).where(and(eq(workspaceMembers.workspaceId, workspace.id), eq(users.id, userId)));
        return result;
      });
      return { member };
    } catch (error) { if (error instanceof TeamError) return reply.code(error.status).send(errorBody(error.code)); throw error; }
  });
}
