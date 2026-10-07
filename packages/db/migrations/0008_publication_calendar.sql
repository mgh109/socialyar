ALTER TABLE content_variants ADD COLUMN IF NOT EXISTS calendar_version integer NOT NULL DEFAULT 0;
ALTER TABLE publications ADD COLUMN IF NOT EXISTS queue_version integer NOT NULL DEFAULT 0;
ALTER TABLE youtube_items ADD COLUMN IF NOT EXISTS queue_version integer NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS calendar_actions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 source_id uuid NOT NULL, kind text NOT NULL, action text NOT NULL, detail jsonb NOT NULL DEFAULT '{}',
 user_id uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS calendar_actions_workspace_source ON calendar_actions(workspace_id,source_id,created_at);
