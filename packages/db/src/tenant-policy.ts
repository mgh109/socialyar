import { and, eq, sql, count } from "drizzle-orm";
import { getDb } from "./client";
import { workspaces, workspaceSubscriptions, workspaceMembers, users, socialAccounts, workflows, tenantAIReservations } from "./schema";

export class TenantPolicyError extends Error {
  constructor(public code: string, message: string, public statusCode = 403) { super(message); }
}
export type TenantDatabase = Pick<ReturnType<typeof getDb>, "select" | "update" | "insert" | "execute">;
export type TenantRole = "manager" | "editor" | "reviewer" | "publisher" | "viewer";
export function tenantScopeAllows(ids: string[] | null | undefined, id: string) { return ids == null || ids.includes(id); }
export function tenantRoleAllows(role: string, action: "manage" | "edit" | "review" | "publish" | "read") {
  return role === "manager" || action === "read" && ["editor", "reviewer", "publisher", "viewer"].includes(role) ||
    action === "edit" && role === "editor" || action === "review" && role === "reviewer" || action === "publish" && role === "publisher";
}

export async function assertWorkspaceOperational(db: TenantDatabase, workspaceId: string, now = new Date()) {
  const [row] = await db.select({ workspace: workspaces, subscription: workspaceSubscriptions }).from(workspaces)
    .leftJoin(workspaceSubscriptions, eq(workspaceSubscriptions.workspaceId, workspaces.id)).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!row) throw new TenantPolicyError("workspace_not_found", "فضای کاری پیدا نشد.", 404);
  if (!row.workspace.isActive) throw new TenantPolicyError("workspace_inactive", "فضای کاری غیرفعال است؛ با مدیر سامانه تماس بگیرید.");
  const subscription = row.subscription;
  if (!subscription) throw new TenantPolicyError("subscription_missing", "اشتراک فضای کاری تنظیم نشده است.", 402);
  if (subscription.status !== "active") throw new TenantPolicyError("subscription_inactive", "اشتراک فضای کاری فعال نیست؛ با مدیر سامانه تماس بگیرید.", 402);
  if (subscription.expiresAt && subscription.expiresAt.getTime() <= now.getTime())
    throw new TenantPolicyError("subscription_expired", "اشتراک فضای کاری پایان یافته است؛ آن را تمدید کنید.", 402);
  return subscription;
}

/** Call inside the SAME transaction as the insert/activation. Workspace lock
 * serializes concurrent quota checks; count active workflows, members/accounts. */
export async function reserveResourceQuota(tx: TenantDatabase, workspaceId: string, resource: "users" | "channels" | "workflows") {
  await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
  const subscription = await assertWorkspaceOperational(tx, workspaceId);
  const maximum = resource === "users" ? subscription.maxUsers : resource === "channels" ? subscription.maxChannels : subscription.maxWorkflows;
  if (maximum === null) return;
  const rows = resource === "users" ? await tx.select({ total: count() }).from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId)).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.isActive, true), eq(users.isActive, true))) :
    resource === "channels" ? await tx.select({ total: count() }).from(socialAccounts).where(and(eq(socialAccounts.workspaceId, workspaceId))) :
    await tx.select({ total: count() }).from(workflows).where(and(eq(workflows.workspaceId, workspaceId), eq(workflows.status, "active")));
  if (Number(rows[0]?.total ?? 0) >= maximum)
    throw new TenantPolicyError(`quota_${resource}`, resource === "users" ? "ظرفیت کاربران اشتراک تکمیل شده است." : resource === "channels" ? "ظرفیت کانال‌های اشتراک تکمیل شده است." : "ظرفیت جریان‌های فعال اشتراک تکمیل شده است.", 409);
}

export type TenantAIUsage = { inputTokens: number | null; outputTokens: number | null };
/** One guard per AI connection. Reserve an upper bound atomically before each
 * request; settle on reported usage. Ambiguous failures keep their reservation
 * so retries cannot spend unaccounted credits. Explicit HTTP rejection releases. */
export function createTenantAIQuota(db: ReturnType<typeof getDb>, workspaceId: string) {
  let reservationId: string | undefined;
  const settle = async (usage: TenantAIUsage | null) => {
    const id = reservationId;
    if (!id) return;
    await db.transaction(async (tx) => {
      const [reservation] = await tx.select().from(tenantAIReservations).where(eq(tenantAIReservations.id, id)).for("update");
      if (!reservation || reservation.status !== "reserved") return;
      const actual = usage === null ? 0 : usage.inputTokens !== null && usage.outputTokens !== null ? usage.inputTokens + usage.outputTokens : reservation.amount;
      await tx.update(workspaceSubscriptions).set({
        aiTokensReserved: sql`GREATEST(0, ${workspaceSubscriptions.aiTokensReserved} - ${reservation.amount})`,
        aiTokensUsed: sql`${workspaceSubscriptions.aiTokensUsed} + ${actual}`, updatedAt: new Date(),
      }).where(eq(workspaceSubscriptions.workspaceId, workspaceId));
      await tx.update(tenantAIReservations).set({ status: usage === null ? "released" : "settled", actualTokens: actual }).where(eq(tenantAIReservations.id, id));
    });
    reservationId = undefined;
  };
  return {
    beforeRequest: async (inputTokensUpperBound: number, maxOutputTokens: number) => {
      const amount = inputTokensUpperBound + maxOutputTokens;
      if (!Number.isSafeInteger(amount) || amount < 0 || amount > 2_147_483_647) throw new TenantPolicyError("ai_request_too_large", "درخواست هوش مصنوعی بیش از حد بزرگ است.", 400);
      await db.transaction(async (tx) => {
        await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
        await assertWorkspaceOperational(tx, workspaceId);
        const [reserved] = await tx.update(workspaceSubscriptions).set({ aiTokensReserved: sql`${workspaceSubscriptions.aiTokensReserved} + ${amount}`, updatedAt: new Date() })
          .where(and(eq(workspaceSubscriptions.workspaceId, workspaceId), eq(workspaceSubscriptions.status, "active"),
            sql`(${workspaceSubscriptions.expiresAt} IS NULL OR ${workspaceSubscriptions.expiresAt} > now())`,
            sql`(${workspaceSubscriptions.aiTokenLimit} IS NULL OR ${workspaceSubscriptions.aiTokensUsed} + ${workspaceSubscriptions.aiTokensReserved} + ${amount} <= ${workspaceSubscriptions.aiTokenLimit})`)).returning();
        if (!reserved) throw new TenantPolicyError("quota_ai", "اعتبار هوش مصنوعی برای این درخواست کافی نیست؛ اشتراک را ارتقا دهید.", 409);
        const [reservation] = await tx.insert(tenantAIReservations).values({ workspaceId, amount }).returning();
        reservationId = reservation.id;
      });
    },
    onUsage: (usage: TenantAIUsage) => settle(usage),
    onRequestRejected: () => settle(null),
  };
}
