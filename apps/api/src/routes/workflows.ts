import { and, asc, count, desc, eq, gte, inArray, or } from "drizzle-orm";
import { isIP } from "node:net";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { graphProblem } from "@socialyar/workflow/graph";
import {
  getDb,
  aiSettings,
  aiProfiles,
  apiConnections,
  ensureCommentStorage,
  approvals,
  contentItems,
  contentVariants,
  publications,
  runEvents,
  runSteps,
  runs,
  schedules,
  socialAccounts,
  workflowConnections,
  workflowSteps,
  workflowVersions,
  workflows,
} from "@socialyar/db";
import { connection as redis } from "../queue";

const stepSchema = z.object({
  key: z.string().min(1),
  type: z.string().min(1),
  name: z.string().min(1),
  config: z.record(z.unknown()).default({}),
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
  order: z.number().int().default(0),
});

const connectionSchema = z.object({
  sourceKey: z.string().min(1),
  targetKey: z.string().min(1),
  condition: z.record(z.unknown()).nullable().optional(),
});

const createWorkflowSchema = z.object({
  name: z.string().min(1),
  pollIntervalMinutes: z.number().int().min(1).max(10080).default(5),
  status: z.enum(["draft", "active"]).default("draft"),
  description: z.string().nullable().optional(),
  autonomyMode: z.enum(["manual", "assisted", "semi_auto", "full_auto"]).default("assisted"),
  prompt: z.string().nullable().optional(),
  steps: z.array(stepSchema).default([]),
  connections: z.array(connectionSchema).default([]),
});

const updateWorkflowSchema = z.object({
  pollIntervalMinutes: z.number().int().min(1).max(10080).default(5),
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  autonomyMode: z.enum(["manual", "assisted", "semi_auto", "full_auto"]).optional(),
  status: z.enum(["draft", "active", "paused", "archived"]).optional(),
  prompt: z.string().nullable().optional(),
  steps: z.array(stepSchema),
  connections: z.array(connectionSchema).default([]),
});

async function insertGraph(
  tx: ReturnType<typeof getDb>,
  workflowVersionId: string,
  steps: z.infer<typeof stepSchema>[],
  connections: z.infer<typeof connectionSchema>[],
) {
  if (!steps.length) return;

  const insertedSteps = await tx
    .insert(workflowSteps)
    .values(
      steps.map((step) => ({
        workflowVersionId,
        key: step.key,
        type: step.type,
        name: step.name,
        config: step.config,
        position: step.position,
        order: step.order,
      })),
    )
    .returning({ id: workflowSteps.id, key: workflowSteps.key });

  const stepIds = new Map(insertedSteps.map((step) => [step.key, step.id]));

  if (connections.length) {
    await tx.insert(workflowConnections).values(
      connections.map((connection) => {
        const sourceStepId = stepIds.get(connection.sourceKey);
        const targetStepId = stepIds.get(connection.targetKey);

        if (!sourceStepId || !targetStepId) {
          throw new Error(
            `Invalid connection ${connection.sourceKey} -> ${connection.targetKey}`,
          );
        }

        return {
          workflowVersionId,
          sourceStepId,
          targetStepId,
          condition: connection.condition ?? null,
        };
      }),
    );
  }
}

async function autoWorkflowProblem(steps: z.infer<typeof stepSchema>[], connections: z.infer<typeof connectionSchema>[], workspaceId: string): Promise<string | null> {
  const sorted = [...steps].sort((a, b) => a.order - b.order);
  const source = sorted.find((step) => ["rss_source", "api_source"].includes(step.type));
  const graphError = graphProblem(steps, connections, true);
  if (graphError) return graphError;
  if (!source || steps.some((step) => step.type === "manual_input")) return "graph_missing_input";
  for (const source of sorted.filter((step) => step.type === "rss_source")) {
  const feedUrls = Array.isArray(source.config.feedUrls) ? source.config.feedUrls : [source.config.feedUrl];
  const channels = source.config.eitaaChannels ?? (source.config.sourceKind === "eitaa" ? [source.config.channel] : []);
  const baleChannels = source.config.baleChannels ?? (source.config.sourceKind === "bale" ? [source.config.channel] : []);
  if (!Array.isArray(channels) || channels.length > 10 || channels.some((value) => typeof value !== "string" ||
    !/^(?:https:\/\/eitaa\.com\/(?:s\/)?|@)?[a-zA-Z0-9_]{4,32}\/?$/.test(value.trim())) ||
    new Set(channels.map((value) => String(value).trim().replace(/^https:\/\/eitaa\.com\/(?:s\/)?|^@|\/$/g, "").toLowerCase())).size !== channels.length) return "invalid_eitaa_source";
  if (!Array.isArray(baleChannels) || baleChannels.length > 10 || baleChannels.some((value) => typeof value !== "string" ||
    !/^(?:https:\/\/ble\.ir\/(?:s\/)?|@)?[a-zA-Z0-9_]{4,32}\/?$/.test(value.trim())) ||
    new Set(baleChannels.map((value) => String(value).trim().replace(/^https:\/\/ble\.ir\/(?:s\/)?|^@|\/$/g, "").toLowerCase())).size !== baleChannels.length) return "invalid_bale_source";
  const filledFeeds = feedUrls.filter((value) => typeof value === "string" && value.trim());
  if (!filledFeeds.length && !channels.length && !baleChannels.length || feedUrls.length > 10 ||
    feedUrls.some((value) => typeof value !== "string" || !value.trim()) && filledFeeds.length > 0 ||
    new Set(filledFeeds).size !== filledFeeds.length) return "invalid_rss_url";
  for (const value of filledFeeds) {
    try {
      const url = new URL(value as string);
      if (url.protocol !== "https:" || url.username || url.password || url.port ||
        isIP(url.hostname.replace(/[\[\]]/g, "")) !== 0 ||
        /^(localhost|.*\.local|.*\.internal)$/i.test(url.hostname)) return "invalid_rss_url";
    } catch { return "invalid_rss_url"; }
  }
  }
  const db = getDb();
  if (sorted.some((step) => ["api_source", "api_action"].includes(step.type))) await ensureCommentStorage();
  for (const step of sorted.filter((item) => ["api_source", "api_action"].includes(item.type))) {
    const { connectionId, path } = step.config;
    if (typeof connectionId !== "string" || !z.string().uuid().safeParse(connectionId).success ||
      typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.length > 300)
      return "invalid_api_step";
    const [connection] = await db.select({ id: apiConnections.id }).from(apiConnections)
      .where(and(eq(apiConnections.id, connectionId), eq(apiConnections.workspaceId, workspaceId))).limit(1);
    if (!connection) return "invalid_api_step";
    if (step.type === "api_source" && (!["itemsPath", "idField", "textField"].every((key) =>
      typeof step.config[key] === "string" && String(step.config[key]).length > 0)) ||
      step.type === "api_action" && !["approve", "reject", "reply"].includes(String(step.config.action)))
      return "invalid_api_step";
    if (step.type === "api_source") {
      const mode = String(step.config.readMode ?? "single");
      if (!["single", "batch", "post"].includes(mode) ||
        (mode !== "single" && (!Number.isInteger(Number(step.config.batchLimit ?? 10)) ||
          Number(step.config.batchLimit ?? 10) < 1 || Number(step.config.batchLimit ?? 10) > 1000 ||
          step.config.readAll !== undefined && typeof step.config.readAll !== "boolean")) ||
        (mode === "post" && (!String(step.config.postId ?? "").trim() || !String(step.config.postIdField ?? "").trim())))
        return "invalid_api_step";
      if (mode !== "single") {
        const seen = new Set<string>(), queue = [step.key];
        while (queue.length) {
          const key = queue.shift()!;
          if (seen.has(key)) continue;
          seen.add(key);
          queue.push(...connections.filter((edge) => edge.sourceKey === key).map((edge) => edge.targetKey));
        }
        const reachable = sorted.filter((item) => seen.has(item.key));
        if (!reachable.some((item) => item.type === "ai" && item.config.aiMode === "feedback") ||
          reachable.some((item) => ["api_action", "comment_decision"].includes(item.type))) return "invalid_feedback_path";
      }
    }
    if (step.type === "api_action" && ["idField", "statusField", "replyField"].some((key) =>
      step.config[key] !== undefined && !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(String(step.config[key]))))
      return "invalid_api_step";
  }
  for (const step of sorted.filter((item) => item.type === "comment_decision")) {
    if (typeof step.config.rules !== "string" || !step.config.rules.trim()) return "invalid_comment_decision";
    const outgoing = connections.filter((edge) => edge.sourceKey === step.key);
    if (!outgoing.length || outgoing.some((edge) => !["approve", "reject", "reply", "review"].includes(String(edge.condition?.decision))))
      return "invalid_decision_branch";
    const profileId = step.config.profileId;
    if (profileId !== undefined && profileId !== "default" &&
      (typeof profileId !== "string" || !z.string().uuid().safeParse(profileId).success)) return "ai_profile_not_found";
    const [profile] = profileId && profileId !== "default" ? await db.select({ id: aiProfiles.id }).from(aiProfiles)
      .where(and(eq(aiProfiles.id, String(profileId)), eq(aiProfiles.workspaceId, workspaceId))).limit(1) :
      await db.select({ id: aiSettings.workspaceId }).from(aiSettings).where(eq(aiSettings.workspaceId, workspaceId)).limit(1);
    if (!profile) return "ai_profile_not_found";
  }
  for (const publisher of sorted.filter((step) => step.type === "publish")) {
    const interval = publisher.config.publishIntervalSeconds ?? 30;
    if (typeof interval !== "number" || !Number.isInteger(interval) || interval < 30 || interval > 604800)
      return "invalid_publish_interval";
    const accountId = publisher.config.accountId;
    if (typeof accountId !== "string" || !z.string().uuid().safeParse(accountId).success) return "eitaa_account_required";
    const [account] = await db.select().from(socialAccounts)
      .where(and(eq(socialAccounts.id, accountId), eq(socialAccounts.workspaceId, workspaceId),
        eq(socialAccounts.isActive, true))).limit(1);
    if (!account || !["eitaa", "telegram", "website"].includes(account.channel)) return "eitaa_account_not_found";
  }
  const accountIds = sorted.filter((step) => step.type === "publish").map((step) => step.config.accountId);
  if (new Set(accountIds).size !== accountIds.length) return "duplicate_publish_channel";
  for (const filter of sorted.filter((step) => step.type === "filter")) {
    if (typeof filter.config.keywords !== "string" || !filter.config.keywords.trim() ||
      !["include", "exclude"].includes(String(filter.config.mode ?? "include"))) return "graph_invalid_filter";
  }
  for (const step of sorted.filter((item) => item.type === "ai")) {
    if (!["rewrite", "feedback"].includes(String(step.config.aiMode ?? "rewrite"))) return "ai_output_invalid";
    const titleMode = String(step.config.titleMode ?? "keep");
    const imageMode = String(step.config.imageMode ?? "keep");
    if (!["keep", "rewrite", "custom"].includes(titleMode) ||
      !["keep", "remove", "custom"].includes(imageMode)) return "ai_output_invalid";
    if (titleMode === "custom" && (typeof step.config.customTitle !== "string" ||
      !step.config.customTitle.trim() || step.config.customTitle.length > 180)) return "ai_output_invalid";
    if (imageMode === "custom") {
      if (typeof step.config.customImageUrl !== "string") return "ai_output_invalid";
      try {
        const url = new URL(step.config.customImageUrl);
        if (url.protocol !== "https:" || url.username || url.password || url.port ||
          isIP(url.hostname.replace(/[\[\]]/g, "")) !== 0 ||
          /^(localhost|.*\.local|.*\.internal)$/i.test(url.hostname)) return "ai_output_invalid";
      } catch { return "ai_output_invalid"; }
    }
    const profileId = step.config.profileId;
    if (profileId !== undefined && profileId !== "default" &&
      (typeof profileId !== "string" || !z.string().uuid().safeParse(profileId).success)) return "ai_profile_not_found";
    const [settings] = profileId && profileId !== "default" ? await db.select({ id: aiProfiles.id }).from(aiProfiles)
      .where(and(eq(aiProfiles.id, profileId as string), eq(aiProfiles.workspaceId, workspaceId))).limit(1) :
      await db.select({ id: aiSettings.workspaceId }).from(aiSettings)
        .where(eq(aiSettings.workspaceId, workspaceId)).limit(1);
    if (!settings) return profileId && profileId !== "default" ? "ai_profile_not_found" : "ai_token_not_configured";
  }
  return null;
}

export async function workflowRoutes(app: FastifyInstance) {
  const db = getDb();
  app.addHook("onRequest", app.authenticate);

  app.get("/workflows/:workflowId/live", async (request, reply) => {
    const { workflowId } = z.object({ workflowId: z.string().uuid() }).parse(request.params);
    const [workflow] = await db.select({ id: workflows.id, currentVersion: workflows.currentVersion, status: workflows.status })
      .from(workflows).where(and(eq(workflows.id, workflowId), eq(workflows.workspaceId, request.auth.workspaceId))).limit(1);
    if (!workflow) return reply.code(404).send({ error: "workflow_not_found" });
    const [version] = await db.select({ id: workflowVersions.id, snapshot: workflowVersions.snapshot }).from(workflowVersions)
      .where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.version, workflow.currentVersion))).limit(1);
    if (!version) return { events: [], active: [], sources: [], publications: [], filters: [], nextPollAt: null };
    const sourceSteps = await db.select({ key: workflowSteps.key }).from(workflowSteps)
      .where(and(eq(workflowSteps.workflowVersionId, version.id), inArray(workflowSteps.type, ["rss_source", "api_source"])));
    const markerKeys = sourceSteps.map((step) => `source-live:${workflowId}:${version.id}:${step.key}`);
    const pollKey = `news-poll:${workflowId}:${version.id}`;
    const [markers, events, active, publicationRows, filterRows] = await Promise.all([
      redis.mget(...markerKeys, pollKey),
      db.select({ id: runEvents.id, type: runEvents.type, createdAt: runEvents.createdAt,
        stepKey: workflowSteps.key, decision: runEvents.payload })
        .from(runEvents).innerJoin(runs, eq(runEvents.runId, runs.id))
        .leftJoin(runSteps, eq(runEvents.runStepId, runSteps.id))
        .leftJoin(workflowSteps, eq(runSteps.workflowStepId, workflowSteps.id))
        .where(and(eq(runs.workflowId, workflowId),
          gte(runEvents.createdAt, new Date(Date.now() - 90_000))))
        .orderBy(desc(runEvents.createdAt)).limit(150),
      db.select({ stepKey: workflowSteps.key, status: runSteps.status, startedAt: runSteps.startedAt })
        .from(runSteps).innerJoin(runs, eq(runSteps.runId, runs.id))
        .innerJoin(workflowSteps, eq(runSteps.workflowStepId, workflowSteps.id))
        .where(and(eq(runs.workflowId, workflowId),
          inArray(runs.status, ["running", "waiting_approval"]),
          inArray(runSteps.status, ["running", "retrying", "waiting_approval"])))
        .orderBy(desc(runSteps.startedAt)).limit(100),
      db.select({ id: publications.id, status: publications.status, updatedAt: publications.updatedAt,
        publishedAt: publications.publishedAt, metadata: contentItems.metadata })
        .from(publications).innerJoin(contentVariants, eq(publications.contentVariantId, contentVariants.id))
        .innerJoin(contentItems, eq(contentVariants.contentItemId, contentItems.id))
        .innerJoin(runs, eq(contentItems.runId, runs.id))
        .where(and(eq(runs.workflowId, workflowId),
          or(eq(publications.status, "publishing"), gte(publications.updatedAt, new Date(Date.now() - 90_000)))))
        .orderBy(desc(publications.updatedAt)).limit(50),
      db.select({ stepKey: workflowSteps.key, runId: runSteps.runId, status: runSteps.status,
        output: runSteps.output, finishedAt: runSteps.finishedAt })
        .from(runSteps).innerJoin(runs, eq(runSteps.runId, runs.id))
        .innerJoin(workflowSteps, eq(runSteps.workflowStepId, workflowSteps.id))
        .where(and(eq(runs.workflowId, workflowId), eq(workflowSteps.type, "filter"),
          inArray(runSteps.status, ["completed", "skipped"])))
        .orderBy(desc(runSteps.finishedAt)).limit(100),
    ]);
    const latestFilters = new Map<string, { stepKey: string; runId: string; passed: boolean; title: string | null; at: Date | null }>();
    for (const row of filterRows) {
      if (latestFilters.has(row.stepKey)) continue;
      latestFilters.set(row.stepKey, { stepKey: row.stepKey, runId: row.runId,
        passed: row.status === "completed", title: typeof row.output?.title === "string" ? row.output.title : null,
        at: row.finishedAt });
    }
    const configured = Number(version.snapshot.pollIntervalMinutes ?? 5);
    const intervalMinutes = Number.isInteger(configured) && configured >= 1 && configured <= 10080 ? configured : 5;
    const startedAt = Number(markers[sourceSteps.length]);
    const nextPoll = startedAt + intervalMinutes * 60_000;
    return {
      nextPollAt: workflow.status === "active" && Number.isFinite(startedAt) && startedAt > 0 && nextPoll > Date.now()
        ? new Date(nextPoll).toISOString() : null,
      events: events.reverse().map((event) => ({ id: event.id, type: event.type,
        createdAt: event.createdAt, stepKey: event.stepKey,
        decision: typeof event.decision?.decision === "string" ? event.decision.decision : null })),
      active,
      filters: [...latestFilters.values()],
      publications: publicationRows.flatMap((row) => typeof row.metadata.publishStepKey === "string" ?
        [{ id: row.id, stepKey: row.metadata.publishStepKey, status: row.status,
          updatedAt: row.updatedAt, publishedAt: row.publishedAt }] : []),
      sources: sourceSteps.flatMap((step, index) => {
        const raw = markers[index];
        if (!raw) return [];
        try { const marker = JSON.parse(raw) as { status: string; at: string; count?: number };
          return [{ stepKey: step.key, ...marker }]; } catch { return []; }
      }),
    };
  });

  app.get("/workflows/:workflowId/activity", async (request, reply) => {
    const { workflowId } = z.object({ workflowId: z.string().uuid() }).parse(request.params);
    const [owned] = await db.select({ id: workflows.id }).from(workflows)
      .where(and(eq(workflows.id, workflowId), eq(workflows.workspaceId, request.auth.workspaceId))).limit(1);
    if (!owned) return reply.code(404).send({ error: "workflow_not_found" });
    const [run] = await db.select({ id: runs.id, status: runs.status, createdAt: runs.createdAt }).from(runs)
      .where(eq(runs.workflowId, workflowId)).orderBy(desc(runs.createdAt)).limit(1);
    const [publication] = await db.select({ status: publications.status, createdAt: publications.createdAt,
      publishedAt: publications.publishedAt, externalUrl: publications.externalUrl }).from(publications)
      .innerJoin(contentVariants, eq(publications.contentVariantId, contentVariants.id))
      .innerJoin(contentItems, eq(contentVariants.contentItemId, contentItems.id))
      .innerJoin(runs, eq(contentItems.runId, runs.id))
      .where(and(eq(runs.workflowId, workflowId), eq(publications.workspaceId, request.auth.workspaceId)))
      .orderBy(desc(publications.createdAt)).limit(1);
    const [waiting] = await db.select({ total: count() }).from(publications)
      .innerJoin(contentVariants, eq(publications.contentVariantId, contentVariants.id))
      .innerJoin(contentItems, eq(contentVariants.contentItemId, contentItems.id))
      .innerJoin(runs, eq(contentItems.runId, runs.id))
      .where(and(eq(runs.workflowId, workflowId), eq(publications.workspaceId, request.auth.workspaceId), eq(publications.status, "queued")));
    return { run: run ?? null, publication: publication ?? null, queueCount: waiting?.total ?? 0 };
  });

  app.post("/workflows", async (request, reply) => {
    const input = createWorkflowSchema.parse(request.body);
    const graphError = graphProblem(input.steps, input.connections, input.status === "active");
    if (graphError) return reply.code(409).send({ error: graphError });
    if (input.status === "active" && input.autonomyMode === "full_auto") {
      const problem = await autoWorkflowProblem(input.steps, input.connections, request.auth.workspaceId);
      if (problem) return reply.code(409).send({ error: problem });
    }

    const result = await db.transaction(async (tx) => {
      const [workflow] = await tx
        .insert(workflows)
        .values({
          workspaceId: request.auth.workspaceId,
          name: input.name,
          description: input.description ?? null,
          autonomyMode: input.autonomyMode,
          status: input.status,
          createdBy: request.auth.userId,
          currentVersion: 1,
        })
        .returning();

      const [version] = await tx
        .insert(workflowVersions)
        .values({
          workflowId: workflow.id,
          version: 1,
          prompt: input.prompt ?? null,
          snapshot: {
            autonomyMode: input.autonomyMode,
            pollIntervalMinutes: input.pollIntervalMinutes,
            stepCount: input.steps.length,
            connectionCount: input.connections.length,
          },
          createdBy: request.auth.userId,
        })
        .returning();

      await insertGraph(
        tx as unknown as ReturnType<typeof getDb>,
        version.id,
        input.steps,
        input.connections,
      );

      return { workflow, version };
    });

    return reply.code(201).send(result);
  });

  app.get("/workflows", async (request) => {
    return db
      .select()
      .from(workflows)
      .where(eq(workflows.workspaceId, request.auth.workspaceId))
      .orderBy(desc(workflows.updatedAt));
  });

  app.get("/workflows/:workflowId", async (request, reply) => {
    const { workflowId } = z
      .object({ workflowId: z.string().uuid() })
      .parse(request.params);

    const [workflow] = await db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.id, workflowId),
          eq(workflows.workspaceId, request.auth.workspaceId),
        ),
      )
      .limit(1);

    if (!workflow) {
      return reply.code(404).send({ error: "workflow_not_found" });
    }

    const [version] = await db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.workflowId, workflowId))
      .orderBy(desc(workflowVersions.version))
      .limit(1);

    if (!version) {
      return { workflow, version: null, steps: [], connections: [] };
    }

    const steps = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.workflowVersionId, version.id))
      .orderBy(asc(workflowSteps.order));

    const connections = await db
      .select()
      .from(workflowConnections)
      .where(eq(workflowConnections.workflowVersionId, version.id));

    return { workflow, version, steps, connections };
  });

  app.delete("/workflows/:workflowId", async (request, reply) => {
    const { workflowId } = z.object({ workflowId: z.string().uuid() }).parse(request.params);

    const result = await db.transaction(async (tx) => {
      const [workflow] = await tx.select().from(workflows).where(and(
        eq(workflows.id, workflowId),
        eq(workflows.workspaceId, request.auth.workspaceId),
      )).for("update").limit(1);

      if (!workflow) return "not_found";
      if (workflow.status === "active") return "active";

      const workflowRunIds = tx.select({ id: runs.id }).from(runs)
        .where(eq(runs.workflowId, workflowId));
      const [unfinished] = await tx.select({ id: runs.id }).from(runs)
        .where(and(eq(runs.workflowId, workflowId), inArray(runs.status, ["queued", "running", "waiting_approval"])))
        .limit(1);
      if (unfinished) return "has_pending_work";

      const workflowContentIds = tx.select({ id: contentItems.id }).from(contentItems)
        .where(inArray(contentItems.runId, workflowRunIds));
      const [publication] = await tx.select({ id: publications.id }).from(publications)
        .innerJoin(contentVariants, eq(publications.contentVariantId, contentVariants.id))
        .where(inArray(contentVariants.contentItemId, workflowContentIds)).limit(1);
      if (publication) return "has_publications";
      const [schedule] = await tx.select({ id: schedules.id }).from(schedules)
        .innerJoin(contentVariants, eq(schedules.contentVariantId, contentVariants.id))
        .where(inArray(contentVariants.contentItemId, workflowContentIds)).limit(1);
      if (schedule) return "has_publications";
      const [pendingApproval] = await tx.select({ id: approvals.id }).from(approvals)
        .innerJoin(contentVariants, eq(approvals.contentVariantId, contentVariants.id))
        .where(and(inArray(contentVariants.contentItemId, workflowContentIds), eq(approvals.status, "pending"))).limit(1);
      if (pendingApproval) return "has_pending_work";

      // Drafts and completed run logs belong to this workflow; remove them before
      // deleting versions, whose steps are referenced by run_steps with RESTRICT.
      await tx.delete(contentItems).where(inArray(contentItems.id, workflowContentIds));
      await tx.delete(runs).where(eq(runs.workflowId, workflowId));
      await tx.delete(workflows).where(eq(workflows.id, workflowId));
      return "deleted";
    });

    if (result === "not_found") return reply.code(404).send({ error: "workflow_not_found" });
    if (result === "active") return reply.code(409).send({ error: "workflow_active" });
    if (result === "has_pending_work") return reply.code(409).send({ error: "workflow_has_pending_work" });
    if (result === "has_publications") return reply.code(409).send({ error: "workflow_has_publications" });
    return reply.code(204).send();
  });

  app.put("/workflows/:workflowId", async (request, reply) => {
    const { workflowId } = z
      .object({ workflowId: z.string().uuid() })
      .parse(request.params);
    const input = updateWorkflowSchema.parse(request.body);

    const [existing] = await db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.id, workflowId),
          eq(workflows.workspaceId, request.auth.workspaceId),
        ),
      )
      .limit(1);

    if (!existing) {
      return reply.code(404).send({ error: "workflow_not_found" });
    }
    const graphError = graphProblem(input.steps, input.connections, (input.status ?? existing.status) === "active");
    if (graphError) return reply.code(409).send({ error: graphError });
    if ((input.status ?? existing.status) === "active" && (input.autonomyMode ?? existing.autonomyMode) === "full_auto") {
      const problem = await autoWorkflowProblem(input.steps, input.connections, request.auth.workspaceId);
      if (problem) return reply.code(409).send({ error: problem });
    }

    const nextVersion = existing.currentVersion + 1;

    const result = await db.transaction(async (tx) => {
      const [workflow] = await tx
        .update(workflows)
        .set({
          name: input.name ?? existing.name,
          description:
            input.description === undefined ? existing.description : input.description,
          autonomyMode: input.autonomyMode ?? existing.autonomyMode,
          status: input.status ?? existing.status,
          currentVersion: nextVersion,
          updatedAt: new Date(),
        })
        .where(eq(workflows.id, workflowId))
        .returning();

      const [version] = await tx
        .insert(workflowVersions)
        .values({
          workflowId,
          version: nextVersion,
          prompt: input.prompt ?? null,
          snapshot: {
            autonomyMode: input.autonomyMode ?? existing.autonomyMode,
            pollIntervalMinutes: input.pollIntervalMinutes,
            stepCount: input.steps.length,
            connectionCount: input.connections.length,
          },
          createdBy: request.auth.userId,
        })
        .returning();

      await insertGraph(
        tx as unknown as ReturnType<typeof getDb>,
        version.id,
        input.steps,
        input.connections,
      );

      return { workflow, version };
    });

    return result;
  });
}
