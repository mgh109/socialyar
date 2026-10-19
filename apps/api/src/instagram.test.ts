import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@socialyar/db/schema";
import { getDb } from "@socialyar/db";
import { instagramWorkflowRoutes } from "./routes/instagram";
import { runRoutes } from "./routes/runs";
import { connection } from "./queue";
const engine = new PGlite(),
  db = drizzle(engine, { schema }),
  database = db as unknown as ReturnType<typeof getDb>,
  app = Fastify();
const workspaceId = randomUUID(),
  other = randomUUID(),
  userId = randomUUID(),
  workflowId = randomUUID(),
  versionId = randomUUID();
let current = workspaceId,
  jobs = 0;
before(async () => {
  connection.disconnect();
  for (const f of [
    "0000_initial.sql",
    "0001_auth.sql",
    "0002_eitaa_automation.sql",
    "0011_execution_recovery.sql",
    "0012_tenant_access.sql",
    "0014_image_generation.sql",
  ])
    await engine.exec(
      await readFile(
        new URL(`../../../packages/db/migrations/${f}`, import.meta.url),
        "utf8",
      ),
    );
  await db
    .insert(schema.users)
    .values({ id: userId, email: "ig-api@example.com" });
  await db.insert(schema.workspaces).values([
    { id: workspaceId, ownerId: userId, name: "تست", slug: "ig-api" },
    { id: other, ownerId: userId, name: "دیگر", slug: "ig-api-other" },
  ]);
  await db
    .insert(schema.workflows)
    .values({ id: workflowId, workspaceId, name: "تست" });
  await db
    .insert(schema.workflowVersions)
    .values({ id: versionId, workflowId, version: 1 });
  app.decorate("authenticate", async (request: any) => {
    request.auth = { userId, workspaceId: current };
  });
  app.addHook("onRequest", app.authenticate);
  await instagramWorkflowRoutes(app, database);
  await app.register(runRoutes, {
    database,
    queue: {
      add: async () => {
        jobs++;
        return {} as any;
      },
    },
  });
  await app.ready();
});
after(async () => {
  await app.close();
  await engine.close();
});
async function pending(type: string, referred = false) {
  const stepId = randomUUID(),
    runId = randomUUID();
  await db
    .insert(schema.workflowSteps)
    .values({
      id: stepId,
      workflowVersionId: versionId,
      key: stepId,
      type,
      name: "اینستاگرام",
    });
  await db
    .insert(schema.runs)
    .values({
      id: runId,
      workflowId,
      workflowVersionId: versionId,
      status: "waiting_approval",
    });
  await db
    .insert(schema.runSteps)
    .values({
      runId,
      workflowStepId: stepId,
      status: "waiting_approval",
      output: {
        text: "سؤال",
        reply: "پاسخ اولیه",
        decision: "reply",
        ...(referred ? { actionStatus: "referred" } : {}),
      },
    });
  return { stepId, runId };
}
test("approving comment and inbox actions queues the same step with edited reply", async () => {
  for (const type of ["instagram_action", "instagram_inbox"]) {
    const { runId, stepId } = await pending(type),
      count = jobs;
    const response = await app.inject({
      method: "POST",
      url: `/runs/${runId}/approval`,
      payload: {
        action: "approve",
        stepKey: stepId,
        edit: { reply: "پاسخ ویرایش‌شده" },
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const [step] = await db
      .select()
      .from(schema.runSteps)
      .where(eq(schema.runSteps.runId, runId));
    assert.equal(step.status, "queued");
    assert.equal(step.output?.approved, true);
    assert.equal(step.output?.reply, "پاسخ ویرایش‌شده");
    assert.equal(jobs, count + 1);
  }
});
test("referrals complete review without sending and rejected actions stay skipped", async () => {
  const referred = await pending("instagram_action", true);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/runs/${referred.runId}/approval`,
        payload: { action: "approve", stepKey: referred.stepId },
      })
    ).statusCode,
    200,
  );
  const [step] = await db
    .select()
    .from(schema.runSteps)
    .where(eq(schema.runSteps.runId, referred.runId));
  assert.equal(step.status, "completed");
  const rejected = await pending("instagram_inbox");
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/runs/${rejected.runId}/approval`,
        payload: { action: "reject", stepKey: rejected.stepId },
      })
    ).statusCode,
    200,
  );
  const [denied] = await db
    .select()
    .from(schema.runSteps)
    .where(eq(schema.runSteps.runId, rejected.runId));
  assert.equal(denied.status, "skipped");
});
test("Instagram reports and approvals cannot cross workspaces", async () => {
  const { runId, stepId } = await pending("instagram_analysis");
  const url = `/workflows/${workflowId}/instagram?stepKey=${stepId}`;
  current = other;
  assert.equal((await app.inject({ method: "GET", url })).statusCode, 404);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/runs/${runId}/approval`,
        payload: { action: "approve", stepKey: stepId },
      })
    ).statusCode,
    404,
  );
  current = workspaceId;
  const response = await app.inject({ method: "GET", url });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().length, 1);
  assert.equal(response.json()[0].runId, runId);
});
