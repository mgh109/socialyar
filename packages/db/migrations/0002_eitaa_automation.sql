ALTER TYPE "channel" ADD VALUE IF NOT EXISTS 'eitaa';

CREATE TABLE IF NOT EXISTS "ai_settings" (
  "workspace_id" uuid PRIMARY KEY REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "encrypted_token" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "news_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workflow_id" uuid NOT NULL REFERENCES "workflows"("id") ON DELETE CASCADE,
  "item_key" text NOT NULL,
  "run_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "news_items_workflow_key_uq" ON "news_items" ("workflow_id", "item_key");
