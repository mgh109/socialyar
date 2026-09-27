import { sql } from "drizzle-orm";
import { getDb } from "./client";

let pending: Promise<void> | undefined;
export async function ensureCommentStorage() {
  pending ??= (async () => {
    const db = getDb();
    await db.execute(sql`CREATE TABLE IF NOT EXISTS "api_connections" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
      "name" text NOT NULL, "base_url" text NOT NULL, "auth_type" text NOT NULL, "header_name" text,
      "encrypted_token" text NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now())`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS "api_connections_workspace_idx" ON "api_connections" ("workspace_id")`);
    await db.execute(sql`CREATE TABLE IF NOT EXISTS "comment_actions" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
      "workflow_id" uuid NOT NULL REFERENCES "workflows"("id") ON DELETE CASCADE,
      "run_id" uuid REFERENCES "runs"("id") ON DELETE SET NULL, "step_key" text NOT NULL,
      "comment_id" text NOT NULL, "status" text NOT NULL, "detail" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now())`);
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "comment_actions_once_uq" ON "comment_actions" ("workflow_id", "step_key", "comment_id")`);
  })();
  try { await pending; } catch (error) { pending = undefined; throw error; }
}
