import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const workflowStatus = pgEnum("workflow_status", ["draft", "active", "paused", "archived"]);
export const runStatus = pgEnum("run_status", ["queued", "running", "waiting_approval", "failed", "completed", "cancelled"]);
export const runStepStatus = pgEnum("run_step_status", ["queued", "running", "retrying", "waiting_approval", "failed", "completed", "skipped"]);
export const runEventType = pgEnum("run_event_type", ["run_started", "step_started", "step_completed", "step_failed", "retry", "fallback", "approval_requested", "approval_resolved", "run_completed", "run_failed"]);
export const channel = pgEnum("channel", ["instagram", "telegram", "website", "x", "linkedin", "eitaa"]);
export const contentStatus = pgEnum("content_status", ["draft", "generated", "waiting_approval", "approved", "rejected", "scheduled", "published", "failed"]);
export const approvalStatus = pgEnum("approval_status", ["pending", "approved", "rejected", "changes_requested"]);
export const publicationStatus = pgEnum("publication_status", ["queued", "publishing", "published", "failed", "cancelled"]);
export const scheduleStatus = pgEnum("schedule_status", ["scheduled", "processing", "completed", "cancelled", "failed"]);

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull(),
  name: text("name"),
  passwordHash: text("password_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  emailIdx: uniqueIndex("users_email_uq").on(t.email),
}));

export const workspaces = pgTable("workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  slugIdx: uniqueIndex("workspaces_slug_uq").on(t.slug),
  ownerIdx: index("workspaces_owner_idx").on(t.ownerId),
}));

export const workspaceMembers = pgTable("workspace_members", {
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").default("member").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.workspaceId, t.userId] }),
}));

export const socialAccounts = pgTable("social_accounts", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  channel: channel("channel").notNull(),
  externalAccountId: text("external_account_id").notNull(),
  displayName: text("display_name"),
  credentials: jsonb("credentials").$type<Record<string, unknown>>().default({}).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workspaceIdx: index("social_accounts_workspace_idx").on(t.workspaceId),
  accountUq: uniqueIndex("social_accounts_workspace_channel_external_uq").on(t.workspaceId, t.channel, t.externalAccountId),
}));

export const workflows = pgTable("workflows", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  status: workflowStatus("status").default("draft").notNull(),
  autonomyMode: text("autonomy_mode").default("assisted").notNull(),
  currentVersion: integer("current_version").default(1).notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workspaceIdx: index("workflows_workspace_idx").on(t.workspaceId),
  statusIdx: index("workflows_status_idx").on(t.status),
}));

export const aiSettings = pgTable("ai_settings", {
  workspaceId: uuid("workspace_id").primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  encryptedToken: text("encrypted_token").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const newsItems = pgTable("news_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  workflowId: uuid("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
  itemKey: text("item_key").notNull(),
  runId: uuid("run_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ keyUq: uniqueIndex("news_items_workflow_key_uq").on(t.workflowId, t.itemKey) }));

export const workflowVersions = pgTable("workflow_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  workflowId: uuid("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  prompt: text("prompt"),
  snapshot: jsonb("snapshot").$type<Record<string, unknown>>().default({}).notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workflowVersionUq: uniqueIndex("workflow_versions_workflow_version_uq").on(t.workflowId, t.version),
}));

export const workflowSteps = pgTable("workflow_steps", {
  id: uuid("id").defaultRandom().primaryKey(),
  workflowVersionId: uuid("workflow_version_id").notNull().references(() => workflowVersions.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  type: text("type").notNull(),
  name: text("name").notNull(),
  config: jsonb("config").$type<Record<string, unknown>>().default({}).notNull(),
  position: jsonb("position").$type<{ x: number; y: number }>().default({ x: 0, y: 0 }).notNull(),
  order: integer("order").default(0).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  versionIdx: index("workflow_steps_version_idx").on(t.workflowVersionId),
  keyUq: uniqueIndex("workflow_steps_version_key_uq").on(t.workflowVersionId, t.key),
}));

export const workflowConnections = pgTable("workflow_connections", {
  id: uuid("id").defaultRandom().primaryKey(),
  workflowVersionId: uuid("workflow_version_id").notNull().references(() => workflowVersions.id, { onDelete: "cascade" }),
  sourceStepId: uuid("source_step_id").notNull().references(() => workflowSteps.id, { onDelete: "cascade" }),
  targetStepId: uuid("target_step_id").notNull().references(() => workflowSteps.id, { onDelete: "cascade" }),
  condition: jsonb("condition").$type<Record<string, unknown> | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  versionIdx: index("workflow_connections_version_idx").on(t.workflowVersionId),
  sourceIdx: index("workflow_connections_source_idx").on(t.sourceStepId),
}));

export const runs = pgTable("runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  workflowId: uuid("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
  workflowVersionId: uuid("workflow_version_id").notNull().references(() => workflowVersions.id, { onDelete: "restrict" }),
  status: runStatus("status").default("queued").notNull(),
  trigger: text("trigger").default("manual").notNull(),
  input: jsonb("input").$type<Record<string, unknown>>().default({}).notNull(),
  output: jsonb("output").$type<Record<string, unknown> | null>(),
  totalInputTokens: integer("total_input_tokens").default(0).notNull(),
  totalOutputTokens: integer("total_output_tokens").default(0).notNull(),
  totalCostMicros: integer("total_cost_micros").default(0).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workflowIdx: index("runs_workflow_idx").on(t.workflowId),
  statusIdx: index("runs_status_idx").on(t.status),
  createdIdx: index("runs_created_idx").on(t.createdAt),
}));

export const runSteps = pgTable("run_steps", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  workflowStepId: uuid("workflow_step_id").notNull().references(() => workflowSteps.id, { onDelete: "restrict" }),
  status: runStepStatus("status").default("queued").notNull(),
  attempt: integer("attempt").default(0).notNull(),
  provider: text("provider"),
  model: text("model"),
  input: jsonb("input").$type<Record<string, unknown>>().default({}).notNull(),
  output: jsonb("output").$type<Record<string, unknown> | null>(),
  error: jsonb("error").$type<Record<string, unknown> | null>(),
  inputTokens: integer("input_tokens").default(0).notNull(),
  outputTokens: integer("output_tokens").default(0).notNull(),
  costMicros: integer("cost_micros").default(0).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  runIdx: index("run_steps_run_idx").on(t.runId),
  statusIdx: index("run_steps_status_idx").on(t.status),
}));

export const runEvents = pgTable("run_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  runStepId: uuid("run_step_id").references(() => runSteps.id, { onDelete: "cascade" }),
  type: runEventType("type").notNull(),
  message: text("message"),
  payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  runCreatedIdx: index("run_events_run_created_idx").on(t.runId, t.createdAt),
}));

export const contentItems = pgTable("content_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
  sourceRunStepId: uuid("source_run_step_id").references(() => runSteps.id, { onDelete: "set null" }),
  title: text("title"),
  body: text("body").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  status: contentStatus("status").default("draft").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workspaceIdx: index("content_items_workspace_idx").on(t.workspaceId),
  runIdx: index("content_items_run_idx").on(t.runId),
}));

export const contentVariants = pgTable("content_variants", {
  id: uuid("id").defaultRandom().primaryKey(),
  contentItemId: uuid("content_item_id").notNull().references(() => contentItems.id, { onDelete: "cascade" }),
  channel: channel("channel").notNull(),
  format: text("format").default("post").notNull(),
  body: text("body").notNull(),
  title: text("title"),
  hashtags: jsonb("hashtags").$type<string[]>().default([]).notNull(),
  settings: jsonb("settings").$type<Record<string, unknown>>().default({}).notNull(),
  status: contentStatus("status").default("draft").notNull(),
  version: integer("version").default(1).notNull(),
  generatedBy: text("generated_by").default("ai").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  itemIdx: index("content_variants_item_idx").on(t.contentItemId),
  channelIdx: index("content_variants_channel_idx").on(t.channel),
}));

export const approvals = pgTable("approvals", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  contentVariantId: uuid("content_variant_id").notNull().references(() => contentVariants.id, { onDelete: "cascade" }),
  runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
  status: approvalStatus("status").default("pending").notNull(),
  reason: text("reason"),
  agentRecommendation: text("agent_recommendation"),
  requestedBy: text("requested_by").default("policy").notNull(),
  resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
  resolutionNote: text("resolution_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (t) => ({
  workspaceStatusIdx: index("approvals_workspace_status_idx").on(t.workspaceId, t.status),
  variantIdx: index("approvals_variant_idx").on(t.contentVariantId),
}));

export const schedules = pgTable("schedules", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  contentVariantId: uuid("content_variant_id").notNull().references(() => contentVariants.id, { onDelete: "cascade" }),
  socialAccountId: uuid("social_account_id").references(() => socialAccounts.id, { onDelete: "set null" }),
  status: scheduleStatus("status").default("scheduled").notNull(),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  timezone: text("timezone").default("UTC").notNull(),
  smartSchedule: boolean("smart_schedule").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  dueIdx: index("schedules_due_idx").on(t.status, t.scheduledAt),
}));

export const publications = pgTable("publications", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  contentVariantId: uuid("content_variant_id").notNull().references(() => contentVariants.id, { onDelete: "cascade" }),
  scheduleId: uuid("schedule_id").references(() => schedules.id, { onDelete: "set null" }),
  socialAccountId: uuid("social_account_id").references(() => socialAccounts.id, { onDelete: "set null" }),
  status: publicationStatus("status").default("queued").notNull(),
  attempt: integer("attempt").default(0).notNull(),
  externalId: text("external_id"),
  externalUrl: text("external_url"),
  error: jsonb("error").$type<Record<string, unknown> | null>(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  statusIdx: index("publications_status_idx").on(t.status),
  variantIdx: index("publications_variant_idx").on(t.contentVariantId),
}));

export const aiUsage = pgTable("ai_usage", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
  runStepId: uuid("run_step_id").references(() => runSteps.id, { onDelete: "set null" }),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").default(0).notNull(),
  outputTokens: integer("output_tokens").default(0).notNull(),
  costMicros: integer("cost_micros").default(0).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workspaceCreatedIdx: index("ai_usage_workspace_created_idx").on(t.workspaceId, t.createdAt),
}));

export const analyticsEvents = pgTable("analytics_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  publicationId: uuid("publication_id").references(() => publications.id, { onDelete: "cascade" }),
  channel: channel("channel").notNull(),
  type: text("type").notNull(),
  value: integer("value").default(0).notNull(),
  dimensions: jsonb("dimensions").$type<Record<string, unknown>>().default({}).notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  publicationIdx: index("analytics_events_publication_idx").on(t.publicationId),
  workspaceRecordedIdx: index("analytics_events_workspace_recorded_idx").on(t.workspaceId, t.recordedAt),
}));

export const reports = pgTable("reports", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  workspacePeriodIdx: index("reports_workspace_period_idx").on(t.workspaceId, t.periodStart, t.periodEnd),
}));
