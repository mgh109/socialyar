CREATE TABLE IF NOT EXISTS content_collections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id),
 workflow_id uuid NOT NULL REFERENCES workflows(id), source_step_key text NOT NULL, target_step_key text NOT NULL,
 revision integer NOT NULL DEFAULT 0, records jsonb NOT NULL DEFAULT '[]',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workflow_id, source_step_key, target_step_key)
);
CREATE TABLE IF NOT EXISTS collection_import_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), collection_id uuid NOT NULL REFERENCES content_collections(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id), user_id uuid NOT NULL REFERENCES users(id),
 revision integer NOT NULL, detail jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
