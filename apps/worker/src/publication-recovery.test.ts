import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as tables from "@socialyar/db/schema";
import { getDb } from "@socialyar/db";
import { executePublication } from "./publisher";
import { connection } from "./queue";
const engine = new PGlite();
const db = drizzle(engine, { schema: tables });
const database = db as unknown as ReturnType<typeof getDb>;
// Single-session PGlite fixtures already have exclusive ownership.
const owned = async <T>(_key: string, operation: (assertOwned: () => Promise<void>) => Promise<T>) => operation(async () => {});
const workspaceId = randomUUID(), workflowId = randomUUID(), versionId = randomUUID(), runId = randomUUID();
before(async () => {
  connection.disconnect();
  for (const name of ["0000_initial.sql", "0001_auth.sql", "0002_eitaa_automation.sql", "0006_youtube.sql", "0008_publication_calendar.sql", "0011_execution_recovery.sql", "0012_tenant_access.sql"])
    await engine.exec(await readFile(new URL(`../../../packages/db/migrations/${name}`, import.meta.url), "utf8"));
  const userId = randomUUID();
  await db.insert(tables.users).values({ id: userId, email: "recovery@example.com" });
  await db.insert(tables.workspaces).values({ id: workspaceId, name: "recovery", slug: "recovery", ownerId: userId });
  await db.insert(tables.workspaceSubscriptions).values({ workspaceId });
  await db.insert(tables.workflows).values({ id: workflowId, workspaceId, name: "test" });
  await db.insert(tables.workflowVersions).values({ id: versionId, workflowId, version: 1 });
  await db.insert(tables.runs).values({ id: runId, workflowId, workflowVersionId: versionId });
});
after(async () => { await engine.close(); });
async function fixture(extra: Partial<typeof tables.publications.$inferInsert> = {}) {
  const [content] = await db.insert(tables.contentItems).values({ workspaceId, runId, title: "test", body: "test" }).returning();
  const [variant] = await db.insert(tables.contentVariants).values({ contentItemId: content.id, channel: "telegram", title: "test", body: "test", status: "approved" }).returning();
  const [publication] = await db.insert(tables.publications).values({ workspaceId, contentVariantId: variant.id, status: "publishing", ...extra }).returning();
  return { variant, publication };
}
const execute = (id: string, queueVersion = 0) => executePublication({ publicationId: id, queueVersion, attempt: 1, maxAttempts: 3 }, database, owned);
test("crash after send began holds the delivery without a second network send", async () => {
  const { publication, variant } = await fixture({ sendStartedAt: new Date() });
  await execute(publication.id);
  const [saved] = await db.select().from(tables.publications).where(eq(tables.publications.id, publication.id));
  assert.equal(saved.status, "failed"); assert.equal(saved.error?.deliveryUnknown, true);
  const [savedVariant] = await db.select().from(tables.contentVariants).where(eq(tables.contentVariants.id, variant.id));
  assert.equal(savedVariant.status, "failed");
});
test("crash before send recovers ownership and reaches normal validation", async () => {
  const { publication } = await fixture();
  await assert.rejects(execute(publication.id), /No active social account/);
  const [saved] = await db.select().from(tables.publications).where(eq(tables.publications.id, publication.id));
  assert.equal(saved.status, "queued"); assert.equal(saved.attempt, 1);
  assert.equal(saved.sendStartedAt, null); assert.equal(saved.error?.deliveryUnknown, false);
});
test("confirmed remote result repairs local status without replaying send", async () => {
  const { publication, variant } = await fixture({ status: "failed", externalId: "remote-123", sendStartedAt: new Date() });
  await execute(publication.id);
  const [saved] = await db.select().from(tables.publications).where(eq(tables.publications.id, publication.id));
  const [savedVariant] = await db.select().from(tables.contentVariants).where(eq(tables.contentVariants.id, variant.id));
  assert.equal(saved.status, "published"); assert.equal(saved.externalId, "remote-123"); assert.equal(saved.error, null);
  assert.equal(savedVariant.status, "published");
});
test("stale jobs cannot recover or mutate a newer interrupted dispatch", async () => {
  const { publication } = await fixture({ queueVersion: 2, sendStartedAt: new Date() });
  await execute(publication.id, 1);
  const [saved] = await db.select().from(tables.publications).where(eq(tables.publications.id, publication.id));
  assert.equal(saved.status, "publishing"); assert.equal(saved.error, null);
});
test("first rollout holds legacy in-flight sends and repeated migration preserves new pre-send recovery", async () => {
  const { publication } = await fixture();
  await engine.exec("ALTER TABLE publications DROP COLUMN send_started_at");
  const migration = await readFile(new URL("../../../packages/db/migrations/0011_execution_recovery.sql", import.meta.url), "utf8");
  await engine.exec(migration);
  await execute(publication.id);
  const [legacy] = await db.select().from(tables.publications).where(eq(tables.publications.id, publication.id));
  assert.equal(legacy.status, "failed"); assert.equal(legacy.error?.deliveryUnknown, true);
  const { publication: fresh } = await fixture();
  await engine.exec(migration);
  const [preserved] = await db.select().from(tables.publications).where(eq(tables.publications.id, fresh.id));
  assert.equal(preserved.sendStartedAt, null);
});
