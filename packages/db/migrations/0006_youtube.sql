ALTER TYPE channel ADD VALUE IF NOT EXISTS 'youtube';
CREATE TABLE IF NOT EXISTS youtube_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id),
 workflow_id uuid NOT NULL REFERENCES workflows(id), run_id uuid REFERENCES runs(id), step_key text NOT NULL,
 item_key text NOT NULL, account_id uuid NOT NULL REFERENCES social_accounts(id), channel_name text NOT NULL,
 status text NOT NULL DEFAULT 'waiting_video', title text NOT NULL, description text NOT NULL DEFAULT '',
 settings jsonb NOT NULL DEFAULT '{}', progress integer NOT NULL DEFAULT 0,
 approved_by uuid REFERENCES users(id), approved_at timestamptz, scheduled_at timestamptz,
 session_enc text, video_id text, actual_privacy text, error text, logs jsonb NOT NULL DEFAULT '[]',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workflow_id,step_key,item_key)
);
CREATE TABLE IF NOT EXISTS youtube_oauth_states (
 id text PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), verifier_enc text NOT NULL, expires_at timestamptz NOT NULL
);
