ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_admin boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_uq ON users(phone);
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS channel_ids uuid[];
ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS workflow_ids uuid[];
ALTER TABLE workspace_members ALTER COLUMN role SET DEFAULT 'editor';
UPDATE workspace_members SET role = 'editor' WHERE role = 'member';
UPDATE workspace_members SET role = 'manager' WHERE role = 'owner';
INSERT INTO workspace_members(workspace_id,user_id,role)
SELECT id,owner_id,'manager' FROM workspaces ON CONFLICT(workspace_id,user_id) DO NOTHING;
UPDATE workspace_members m SET role = 'manager' FROM workspaces w WHERE m.workspace_id=w.id AND m.user_id=w.owner_id;
CREATE TABLE IF NOT EXISTS workspace_subscriptions (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  plan text NOT NULL DEFAULT 'legacy', status text NOT NULL DEFAULT 'active', expires_at timestamptz,
  max_users integer CHECK(max_users >= 0), max_channels integer CHECK(max_channels >= 0), max_workflows integer CHECK(max_workflows >= 0),
  ai_token_limit bigint CHECK(ai_token_limit >= 0), ai_tokens_used bigint NOT NULL DEFAULT 0 CHECK(ai_tokens_used >= 0),
  ai_tokens_reserved bigint NOT NULL DEFAULT 0 CHECK(ai_tokens_reserved >= 0), updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO workspace_subscriptions(workspace_id) SELECT id FROM workspaces ON CONFLICT(workspace_id) DO NOTHING;
CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL, action text NOT NULL,target_type text NOT NULL,target_id text,
  detail jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_workspace_created_idx ON audit_logs(workspace_id,created_at);
CREATE TABLE IF NOT EXISTS tenant_ai_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  amount integer NOT NULL CHECK(amount >= 0), actual_tokens integer CHECK(actual_tokens >= 0),
  status text NOT NULL DEFAULT 'reserved', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tenant_ai_reservations_workspace_status_idx ON tenant_ai_reservations(workspace_id,status);
