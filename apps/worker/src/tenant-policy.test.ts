import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as tables from "@socialyar/db/schema";
import { getDb, assertWorkspaceOperational, reserveResourceQuota, createTenantAIQuota, tenantScopeAllows, tenantRoleAllows } from "@socialyar/db";
import { generateNewsDraft } from "../../../packages/ai/src/index";
const engine = new PGlite(), db = drizzle(engine, { schema: tables }), database = db as unknown as ReturnType<typeof getDb>;
before(async () => { for (const file of ["0000_initial.sql", "0001_auth.sql", "0002_eitaa_automation.sql", "0012_tenant_access.sql"]) await engine.exec(await readFile(new URL(`../../../packages/db/migrations/${file}`, import.meta.url), "utf8")); });
after(async () => { await engine.close(); });
async function workspace(extra: Partial<typeof tables.workspaceSubscriptions.$inferInsert> = {}) {
  const userId = randomUUID(), workspaceId = randomUUID();
  await db.insert(tables.users).values({ id: userId, phone: userId });
  await db.insert(tables.workspaces).values({ id: workspaceId, ownerId: userId, name: "tenant", slug: workspaceId });
  await db.insert(tables.workspaceMembers).values({ workspaceId, userId, role: "manager" });
  await db.insert(tables.workspaceSubscriptions).values({ workspaceId, ...extra });
  return { workspaceId, userId };
}
test("roles and null/empty scopes preserve distinct permissions", () => {
  assert.equal(tenantScopeAllows(null, "any"), true); assert.equal(tenantScopeAllows([], "any"), false);
  assert.equal(tenantRoleAllows("viewer", "edit"), false); assert.equal(tenantRoleAllows("reviewer", "publish"), false);
  assert.equal(tenantRoleAllows("publisher", "publish"), true); assert.equal(tenantRoleAllows("manager", "manage"), true);
});
test("inactive/expired tenant cannot work while a different tenant remains active", async () => {
  const expired = await workspace({ expiresAt: new Date("2000-01-01") }), active = await workspace();
  await assert.rejects(assertWorkspaceOperational(database, expired.workspaceId), { code: "subscription_expired", statusCode: 402 });
  assert.equal((await assertWorkspaceOperational(database, active.workspaceId)).status, "active");
  await db.update(tables.workspaces).set({ isActive: false }).where(eq(tables.workspaces.id, active.workspaceId));
  await assert.rejects(assertWorkspaceOperational(database, active.workspaceId), { code: "workspace_inactive" });
});
test("all stored channels, active seats and active workflows enforce their distinct quotas", async () => {
  const { workspaceId } = await workspace({ maxUsers: 1, maxChannels: 1, maxWorkflows: 1 });
  const quota = (resource: "users" | "channels" | "workflows") => db.transaction((tx) => reserveResourceQuota(tx as unknown as ReturnType<typeof getDb>, workspaceId, resource));
  await assert.rejects(quota("users"), { code: "quota_users" });
  await db.insert(tables.socialAccounts).values({ workspaceId, channel: "telegram", externalAccountId: "one", isActive: false });
  await assert.rejects(quota("channels"), { code: "quota_channels" });
  await db.insert(tables.workflows).values({ workspaceId, name: "draft", status: "draft" }); await quota("workflows");
  await db.insert(tables.workflows).values({ workspaceId, name: "active", status: "active" });
  await assert.rejects(quota("workflows"), { code: "quota_workflows" });
});
test("AI reserves capacity and settles actual usage exactly once within its own tenant", async () => {
  const tenant = await workspace({ aiTokenLimit: 1500 }), other = await workspace({ aiTokenLimit: 10 });
  const quota = createTenantAIQuota(database, tenant.workspaceId); await quota.beforeRequest(100, 1000);
  await assert.rejects(createTenantAIQuota(database, tenant.workspaceId).beforeRequest(100, 1000), { code: "quota_ai" });
  await quota.onUsage({ inputTokens: 20, outputTokens: 30 }); await quota.onUsage({ inputTokens: 20, outputTokens: 30 });
  const [saved] = await db.select().from(tables.workspaceSubscriptions).where(eq(tables.workspaceSubscriptions.workspaceId, tenant.workspaceId));
  assert.equal(saved.aiTokensUsed, 50); assert.equal(saved.aiTokensReserved, 0);
  const [untouched] = await db.select().from(tables.workspaceSubscriptions).where(eq(tables.workspaceSubscriptions.workspaceId, other.workspaceId)); assert.equal(untouched.aiTokensUsed, 0);
});
test("real provider path checks quota before fetch and releases credit on HTTP rejection", async () => {
  const empty = await workspace({ aiTokenLimit: 0 }), allowed = await workspace({ aiTokenLimit: 10000 }), original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ error: { message: "rejected" } }), { status: 400 }); };
  try {
    const generate = (workspaceId: string) => generateNewsDraft({ provider: "openai", model: "test", token: "test", ...createTenantAIQuota(database, workspaceId) }, { title: "test", text: "test" });
    await assert.rejects(generate(empty.workspaceId), { code: "quota_ai" }); assert.equal(calls, 0);
    await assert.rejects(generate(allowed.workspaceId), /400/); assert.equal(calls, 1);
    const [saved] = await db.select().from(tables.workspaceSubscriptions).where(eq(tables.workspaceSubscriptions.workspaceId, allowed.workspaceId)); assert.equal(saved.aiTokensReserved, 0); assert.equal(saved.aiTokensUsed, 0);
  } finally { globalThis.fetch = original; }
});
test("unknown provider failure retains the reservation instead of permitting a free retry", async () => {
  const tenant = await workspace({ aiTokenLimit: 10000 }), original = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("network lost"); };
  try {
    await assert.rejects(generateNewsDraft({ provider: "openai", model: "test", token: "test", ...createTenantAIQuota(database, tenant.workspaceId) }, { title: "test", text: "test" }));
    const [saved] = await db.select().from(tables.workspaceSubscriptions).where(eq(tables.workspaceSubscriptions.workspaceId, tenant.workspaceId)); assert.ok(saved.aiTokensReserved > 0); assert.equal(saved.aiTokensUsed, 0);
  } finally { globalThis.fetch = original; }
});
test("missing provider token usage charges the reservation instead of silently granting credit", async () => {
  const tenant = await workspace({ aiTokenLimit: 2000 }), quota = createTenantAIQuota(database, tenant.workspaceId);
  await quota.beforeRequest(50, 1000); await quota.onUsage({ inputTokens: null, outputTokens: null });
  const [saved] = await db.select().from(tables.workspaceSubscriptions).where(eq(tables.workspaceSubscriptions.workspaceId, tenant.workspaceId));
  assert.equal(saved.aiTokensUsed, 1050); assert.equal(saved.aiTokensReserved, 0);
});
test("idempotent tenant migration retains owners as workspace managers without making them platform admins", async () => {
  const tenant = await workspace();
  await db.update(tables.workspaceMembers).set({ role: "member" }).where(eq(tables.workspaceMembers.workspaceId, tenant.workspaceId));
  const migration = await readFile(new URL("../../../packages/db/migrations/0012_tenant_access.sql", import.meta.url), "utf8");
  await engine.exec(migration); await engine.exec(migration);
  const [member] = await db.select().from(tables.workspaceMembers).where(eq(tables.workspaceMembers.workspaceId, tenant.workspaceId));
  const [user] = await db.select().from(tables.users).where(eq(tables.users.id, tenant.userId));
  assert.equal(member.role, "manager"); assert.equal(user.isPlatformAdmin, false); assert.equal(user.email, null);
});
