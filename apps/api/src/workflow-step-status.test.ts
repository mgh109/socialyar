import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@socialyar/db/schema";
import { getDb } from "@socialyar/db";
import { latestWorkflowStepStates } from "./workflow-step-status";

test("card failure survives the live event window and only a newer execution in the same graph replaces it", async () => {
  const engine = new PGlite();
  const db = drizzle(engine, { schema });
  const database = db as unknown as ReturnType<typeof getDb>;
  try {
    for (const file of ["0000_initial.sql", "0001_auth.sql", "0002_eitaa_automation.sql", "0011_execution_recovery.sql", "0012_tenant_access.sql", "0014_image_generation.sql"])
      await engine.exec(await readFile(new URL(`../../../packages/db/migrations/${file}`, import.meta.url), "utf8"));
    const userId = randomUUID(), workspaceId = randomUUID(), workflowId = randomUUID(), otherWorkflow = randomUUID(), versionId = randomUUID(), otherVersion = randomUUID();
    await db.insert(schema.users).values({ id: userId, email: "card-state@example.com" });
    await db.insert(schema.workspaces).values({ id: workspaceId, ownerId: userId, name: "test", slug: "card-state" });
    await db.insert(schema.workflows).values([{ id: workflowId, workspaceId, name: "one" }, { id: otherWorkflow, workspaceId, name: "other" }]);
    await db.insert(schema.workflowVersions).values([{ id: versionId, workflowId, version: 1 }, { id: otherVersion, workflowId: otherWorkflow, version: 1 }]);
    const stepId = randomUUID(), foreignStep = randomUUID();
    await db.insert(schema.workflowSteps).values([{ id: stepId, workflowVersionId: versionId, key: "ai", type: "ai", name: "AI" }, { id: foreignStep, workflowVersionId: otherVersion, key: "ai", type: "ai", name: "other" }]);
    const record = async (workflow: string, version: string, step: string, status: "failed" | "completed", at: string) => {
      const runId = randomUUID();
      await db.insert(schema.runs).values({ id: runId, workflowId: workflow, workflowVersionId: version, status });
      await db.insert(schema.runSteps).values({ runId, workflowStepId: step, status, startedAt: new Date(at) });
    };
    await record(workflowId, versionId, stepId, "failed", "2020-01-01T00:00:00Z");
    await record(otherWorkflow, otherVersion, foreignStep, "completed", "2026-10-20T00:00:00Z");
    let states = await latestWorkflowStepStates(database, workflowId, versionId);
    assert.equal(states.length, 1);
    assert.equal(states[0].status, "failed");
    assert.equal(states[0].stepKey, "ai");
    await record(workflowId, versionId, stepId, "completed", "2020-01-02T00:00:00Z");
    states = await latestWorkflowStepStates(database, workflowId, versionId);
    assert.equal(states[0].status, "completed");
    assert.deepEqual(await latestWorkflowStepStates(database, workflowId, otherVersion), []);
  } finally {
    await engine.close();
  }
});
