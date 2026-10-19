CREATE TABLE IF NOT EXISTS instagram_actions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 account_id uuid NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
 workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
 kind text NOT NULL, target_id text NOT NULL, status text NOT NULL, external_id text, day text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT instagram_actions_once UNIQUE(account_id,kind,target_id)
);
CREATE INDEX IF NOT EXISTS instagram_actions_daily ON instagram_actions(account_id,day);
