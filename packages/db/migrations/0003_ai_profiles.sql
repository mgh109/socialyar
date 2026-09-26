CREATE TABLE IF NOT EXISTS "ai_profiles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "encrypted_token" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "ai_profiles_workspace_idx" ON "ai_profiles" ("workspace_id");
