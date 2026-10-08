ALTER TYPE channel ADD VALUE IF NOT EXISTS 'bale';
CREATE TABLE IF NOT EXISTS collection_sheet_snapshots (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, source_step_key text NOT NULL,
 source_url text NOT NULL, sheet_gid text NOT NULL DEFAULT '0', data jsonb,
 error text, checked_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workflow_id,source_step_key)
);
