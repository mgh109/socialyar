CREATE TABLE IF NOT EXISTS publishing_proxies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 name text NOT NULL, protocol text NOT NULL CHECK (protocol IN ('http','https','socks5')),
 host text NOT NULL, port integer NOT NULL CHECK (port BETWEEN 1 AND 65535), auth_enc text,
 is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS connection_checks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 proxy_id uuid REFERENCES publishing_proxies(id) ON DELETE SET NULL, target text NOT NULL,
 config jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'queued', result jsonb,
 checked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS connection_checks_workspace_created ON connection_checks(workspace_id,created_at);
CREATE TABLE IF NOT EXISTS publication_connection_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 publication_id uuid REFERENCES publications(id) ON DELETE CASCADE, youtube_item_id uuid REFERENCES youtube_items(id) ON DELETE CASCADE,
 route text NOT NULL, proxy_name text, result text NOT NULL, error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS publication_connection_events_publication ON publication_connection_events(publication_id,created_at);
