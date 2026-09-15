CREATE TYPE "workflow_status" AS ENUM ('draft','active','paused','archived');
CREATE TYPE "run_status" AS ENUM ('queued','running','waiting_approval','failed','completed','cancelled');
CREATE TYPE "run_step_status" AS ENUM ('queued','running','retrying','waiting_approval','failed','completed','skipped');
CREATE TYPE "run_event_type" AS ENUM ('run_started','step_started','step_completed','step_failed','retry','fallback','approval_requested','approval_resolved','run_completed','run_failed');
CREATE TYPE "channel" AS ENUM ('instagram','telegram','website','x','linkedin');
CREATE TYPE "content_status" AS ENUM ('draft','generated','waiting_approval','approved','rejected','scheduled','published','failed');
CREATE TYPE "approval_status" AS ENUM ('pending','approved','rejected','changes_requested');
CREATE TYPE "publication_status" AS ENUM ('queued','publishing','published','failed','cancelled');
CREATE TYPE "schedule_status" AS ENUM ('scheduled','processing','completed','cancelled','failed');

CREATE TABLE "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" text NOT NULL,
  "name" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "users_email_uq" ON "users" ("email");

CREATE TABLE "workspaces" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "owner_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "workspaces_slug_uq" ON "workspaces" ("slug");
CREATE INDEX "workspaces_owner_idx" ON "workspaces" ("owner_id");

CREATE TABLE "workspace_members" (
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role" text NOT NULL DEFAULT 'member',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("workspace_id","user_id")
);

CREATE TABLE "social_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "channel" channel NOT NULL,
  "external_account_id" text NOT NULL,
  "display_name" text,
  "credentials" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "social_accounts_workspace_idx" ON "social_accounts" ("workspace_id");
CREATE UNIQUE INDEX "social_accounts_workspace_channel_external_uq" ON "social_accounts" ("workspace_id","channel","external_account_id");

CREATE TABLE "workflows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text,
  "status" workflow_status NOT NULL DEFAULT 'draft',
  "autonomy_mode" text NOT NULL DEFAULT 'assisted',
  "current_version" integer NOT NULL DEFAULT 1,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "workflows_workspace_idx" ON "workflows" ("workspace_id");
CREATE INDEX "workflows_status_idx" ON "workflows" ("status");

CREATE TABLE "workflow_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workflow_id" uuid NOT NULL REFERENCES "workflows"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "prompt" text,
  "snapshot" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "workflow_versions_workflow_version_uq" ON "workflow_versions" ("workflow_id","version");

CREATE TABLE "workflow_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workflow_version_id" uuid NOT NULL REFERENCES "workflow_versions"("id") ON DELETE CASCADE,
  "key" text NOT NULL,
  "type" text NOT NULL,
  "name" text NOT NULL,
  "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "position" jsonb NOT NULL DEFAULT '{"x":0,"y":0}'::jsonb,
  "order" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "workflow_steps_version_idx" ON "workflow_steps" ("workflow_version_id");
CREATE UNIQUE INDEX "workflow_steps_version_key_uq" ON "workflow_steps" ("workflow_version_id","key");

CREATE TABLE "workflow_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workflow_version_id" uuid NOT NULL REFERENCES "workflow_versions"("id") ON DELETE CASCADE,
  "source_step_id" uuid NOT NULL REFERENCES "workflow_steps"("id") ON DELETE CASCADE,
  "target_step_id" uuid NOT NULL REFERENCES "workflow_steps"("id") ON DELETE CASCADE,
  "condition" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "workflow_connections_version_idx" ON "workflow_connections" ("workflow_version_id");
CREATE INDEX "workflow_connections_source_idx" ON "workflow_connections" ("source_step_id");

CREATE TABLE "runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workflow_id" uuid NOT NULL REFERENCES "workflows"("id") ON DELETE CASCADE,
  "workflow_version_id" uuid NOT NULL REFERENCES "workflow_versions"("id") ON DELETE RESTRICT,
  "status" run_status NOT NULL DEFAULT 'queued',
  "trigger" text NOT NULL DEFAULT 'manual',
  "input" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "output" jsonb,
  "total_input_tokens" integer NOT NULL DEFAULT 0,
  "total_output_tokens" integer NOT NULL DEFAULT 0,
  "total_cost_micros" integer NOT NULL DEFAULT 0,
  "started_at" timestamptz,
  "finished_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "runs_workflow_idx" ON "runs" ("workflow_id");
CREATE INDEX "runs_status_idx" ON "runs" ("status");
CREATE INDEX "runs_created_idx" ON "runs" ("created_at");

CREATE TABLE "run_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "run_id" uuid NOT NULL REFERENCES "runs"("id") ON DELETE CASCADE,
  "workflow_step_id" uuid NOT NULL REFERENCES "workflow_steps"("id") ON DELETE RESTRICT,
  "status" run_step_status NOT NULL DEFAULT 'queued',
  "attempt" integer NOT NULL DEFAULT 0,
  "provider" text,
  "model" text,
  "input" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "output" jsonb,
  "error" jsonb,
  "input_tokens" integer NOT NULL DEFAULT 0,
  "output_tokens" integer NOT NULL DEFAULT 0,
  "cost_micros" integer NOT NULL DEFAULT 0,
  "started_at" timestamptz,
  "finished_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "run_steps_run_idx" ON "run_steps" ("run_id");
CREATE INDEX "run_steps_status_idx" ON "run_steps" ("status");

CREATE TABLE "run_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "run_id" uuid NOT NULL REFERENCES "runs"("id") ON DELETE CASCADE,
  "run_step_id" uuid REFERENCES "run_steps"("id") ON DELETE CASCADE,
  "type" run_event_type NOT NULL,
  "message" text,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "run_events_run_created_idx" ON "run_events" ("run_id","created_at");

CREATE TABLE "content_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "run_id" uuid REFERENCES "runs"("id") ON DELETE SET NULL,
  "source_run_step_id" uuid REFERENCES "run_steps"("id") ON DELETE SET NULL,
  "title" text,
  "body" text NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" content_status NOT NULL DEFAULT 'draft',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "content_items_workspace_idx" ON "content_items" ("workspace_id");
CREATE INDEX "content_items_run_idx" ON "content_items" ("run_id");

CREATE TABLE "content_variants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "content_item_id" uuid NOT NULL REFERENCES "content_items"("id") ON DELETE CASCADE,
  "channel" channel NOT NULL,
  "format" text NOT NULL DEFAULT 'post',
  "body" text NOT NULL,
  "title" text,
  "hashtags" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "settings" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" content_status NOT NULL DEFAULT 'draft',
  "version" integer NOT NULL DEFAULT 1,
  "generated_by" text NOT NULL DEFAULT 'ai',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "content_variants_item_idx" ON "content_variants" ("content_item_id");
CREATE INDEX "content_variants_channel_idx" ON "content_variants" ("channel");

CREATE TABLE "approvals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "content_variant_id" uuid NOT NULL REFERENCES "content_variants"("id") ON DELETE CASCADE,
  "run_id" uuid REFERENCES "runs"("id") ON DELETE SET NULL,
  "status" approval_status NOT NULL DEFAULT 'pending',
  "reason" text,
  "agent_recommendation" text,
  "requested_by" text NOT NULL DEFAULT 'policy',
  "resolved_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "resolution_note" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "resolved_at" timestamptz
);
CREATE INDEX "approvals_workspace_status_idx" ON "approvals" ("workspace_id","status");
CREATE INDEX "approvals_variant_idx" ON "approvals" ("content_variant_id");

CREATE TABLE "schedules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "content_variant_id" uuid NOT NULL REFERENCES "content_variants"("id") ON DELETE CASCADE,
  "social_account_id" uuid REFERENCES "social_accounts"("id") ON DELETE SET NULL,
  "status" schedule_status NOT NULL DEFAULT 'scheduled',
  "scheduled_at" timestamptz NOT NULL,
  "timezone" text NOT NULL DEFAULT 'UTC',
  "smart_schedule" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "schedules_due_idx" ON "schedules" ("status","scheduled_at");

CREATE TABLE "publications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "content_variant_id" uuid NOT NULL REFERENCES "content_variants"("id") ON DELETE CASCADE,
  "schedule_id" uuid REFERENCES "schedules"("id") ON DELETE SET NULL,
  "social_account_id" uuid REFERENCES "social_accounts"("id") ON DELETE SET NULL,
  "status" publication_status NOT NULL DEFAULT 'queued',
  "attempt" integer NOT NULL DEFAULT 0,
  "external_id" text,
  "external_url" text,
  "error" jsonb,
  "published_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "publications_status_idx" ON "publications" ("status");
CREATE INDEX "publications_variant_idx" ON "publications" ("content_variant_id");

CREATE TABLE "ai_usage" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "run_id" uuid REFERENCES "runs"("id") ON DELETE SET NULL,
  "run_step_id" uuid REFERENCES "run_steps"("id") ON DELETE SET NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "input_tokens" integer NOT NULL DEFAULT 0,
  "output_tokens" integer NOT NULL DEFAULT 0,
  "cost_micros" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "ai_usage_workspace_created_idx" ON "ai_usage" ("workspace_id","created_at");

CREATE TABLE "analytics_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "publication_id" uuid REFERENCES "publications"("id") ON DELETE CASCADE,
  "channel" channel NOT NULL,
  "type" text NOT NULL,
  "value" integer NOT NULL DEFAULT 0,
  "dimensions" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "recorded_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "analytics_events_publication_idx" ON "analytics_events" ("publication_id");
CREATE INDEX "analytics_events_workspace_recorded_idx" ON "analytics_events" ("workspace_id","recorded_at");

CREATE TABLE "reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "type" text NOT NULL,
  "period_start" timestamptz NOT NULL,
  "period_end" timestamptz NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "reports_workspace_period_idx" ON "reports" ("workspace_id","period_start","period_end");
