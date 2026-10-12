ALTER TABLE workspace_subscriptions ADD COLUMN IF NOT EXISTS image_daily_limit integer;
ALTER TABLE workspace_subscriptions ADD COLUMN IF NOT EXISTS image_monthly_limit integer;
ALTER TABLE workspace_subscriptions ADD COLUMN IF NOT EXISTS image_monthly_budget_micros bigint;
CREATE TABLE IF NOT EXISTS image_generation_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, step_key text NOT NULL, cache_key text NOT NULL,
 provider text NOT NULL, model text NOT NULL, status text NOT NULL DEFAULT 'reserved', image_count integer NOT NULL,
 reserved_micros bigint NOT NULL, cost_micros bigint, cost_estimated boolean NOT NULL DEFAULT true,
 input_tokens integer, output_tokens integer, images jsonb NOT NULL DEFAULT '[]', error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,cache_key)
);
CREATE INDEX IF NOT EXISTS image_jobs_scope_idx ON image_generation_jobs(workspace_id,workflow_id,step_key,created_at);
