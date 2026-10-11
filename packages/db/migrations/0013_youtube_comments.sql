CREATE TABLE IF NOT EXISTS youtube_comment_replies (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    account_id uuid NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
    workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
    comment_id text NOT NULL, video_id text NOT NULL, reply text NOT NULL, status text NOT NULL,
    external_id text, error text, day text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT youtube_comment_replies_once UNIQUE(account_id, comment_id));
