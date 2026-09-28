import { sql } from "drizzle-orm";
import { getDb } from "./client";

let pending: Promise<void> | undefined;
export async function ensureAIUsageStorage() {
  pending ??= (async () => {
    const db = getDb();
    await db.execute(sql`CREATE TABLE IF NOT EXISTS "ai_usage_events" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
      "workflow_id" uuid REFERENCES "workflows"("id") ON DELETE SET NULL,
      "run_id" uuid REFERENCES "runs"("id") ON DELETE SET NULL,
      "run_step_id" uuid REFERENCES "run_steps"("id") ON DELETE SET NULL,
      "provider" text NOT NULL, "model" text NOT NULL,
      "input_tokens" integer, "output_tokens" integer, "cost_micros" integer,
      "created_at" timestamptz NOT NULL DEFAULT now()
    )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS "ai_usage_workspace_created_idx" ON "ai_usage_events" ("workspace_id", "created_at")`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS "ai_usage_workflow_created_idx" ON "ai_usage_events" ("workflow_id", "created_at")`);
  })();
  try { await pending; } catch (error) { pending = undefined; throw error; }
}
