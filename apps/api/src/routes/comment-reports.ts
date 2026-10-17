import type { FastifyInstance } from "fastify";
import {
  and,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import {
  getDb,
  runs,
  runSteps,
  socialAccounts,
  workflows,
  workflowSteps,
} from "@socialyar/db";

const querySchema = z.object({
  workflowId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
  status: z
    .enum([
      "queued",
      "running",
      "waiting_approval",
      "retrying",
      "failed",
      "completed",
      "rejected",
      "succeeded",
      "already_replied",
      "skipped",
    ])
    .optional(),
  q: z.string().trim().max(200).default(""),
  period: z.enum(["7d", "30d", "90d", "all"]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});

export async function youtubeCommentReportRoutes(
  app: FastifyInstance,
  options: { database: ReturnType<typeof getDb> },
) {
  const db = options.database;
  app.get("/analytics/youtube-comments", async (request) => {
    const query = querySchema.parse(request.query);
    const replies = db
      .select({
        id: runSteps.id,
        runId: runSteps.runId,
        status: runSteps.status,
        output: runSteps.output,
        error: runSteps.error,
        finishedAt: runSteps.finishedAt,
        startedAt: runSteps.startedAt,
        stepKey: workflowSteps.key,
        stepName: workflowSteps.name,
      })
      .from(runSteps)
      .innerJoin(workflowSteps, eq(runSteps.workflowStepId, workflowSteps.id))
      .where(eq(workflowSteps.type, "youtube_reply"))
      .as("comment_reply_steps");
    // Input survives failures before AI output exists; only explicit safe report fields leave the API.
    const payload = sql`(${runs.input} || coalesce(${replies.output}, '{}'::jsonb))`;
    const accountId = sql<string>`${payload}->'youtube'->>'accountId'`;
    const videoId = sql<string | null>`${payload}->'youtube'->>'videoId'`;
    const commentId = sql<string | null>`${payload}->>'commentId'`;
    const text = sql<string | null>`${payload}->>'text'`,
      replyText = sql<string | null>`${payload}->>'reply'`;
    const status = sql<string>`case when ${payload}->>'replyStatus' in ('succeeded','already_replied','skipped') then ${payload}->>'replyStatus' else coalesce(${replies.status}::text, ${runs.status}::text) end`;
    const at = sql<Date>`coalesce(${replies.finishedAt}, ${replies.startedAt}, ${runs.createdAt})`;
    const days =
      query.period === "all" ? null : Number.parseInt(query.period, 10);
    const conditions = and(
      eq(workflows.workspaceId, request.auth.workspaceId),
      or(eq(runs.trigger, "youtube_comments"), isNotNull(replies.id)),
      request.auth.workflowIds != null
        ? inArray(workflows.id, request.auth.workflowIds)
        : undefined,
      request.auth.channelIds != null
        ? inArray(accountId, request.auth.channelIds)
        : undefined,
      query.workflowId ? eq(workflows.id, query.workflowId) : undefined,
      query.accountId ? eq(accountId, query.accountId) : undefined,
      query.status ? eq(status, query.status) : undefined,
      days
        ? gte(runs.createdAt, new Date(Date.now() - days * 86400000))
        : undefined,
      query.q
        ? ilike(
            sql`concat_ws(' ', ${text}, ${replyText}, ${videoId}, ${commentId})`,
            `%${query.q.replace(/[\\%_]/g, "\\$&")}%`,
          )
        : undefined,
    );
    const [rows, counts] = await Promise.all([
      db
        .select({
          id: sql<string>`coalesce(${replies.id}, ${runs.id})`,
          runId: runs.id,
          runStatus: runs.status,
          workflowId: workflows.id,
          workflowName: workflows.name,
          accountId,
          accountName: sql<string>`coalesce(${socialAccounts.displayName}, ${socialAccounts.externalAccountId}, 'کانال یوتیوب')`,
          stepKey: replies.stepKey,
          stepName: replies.stepName,
          status,
          commentId,
          videoId,
          text,
          reply: replyText,
          sentiment: sql<string | null>`${payload}->>'sentiment'`,
          reason: sql<string | null>`${payload}->>'reason'`,
          externalUrl: sql<string | null>`${payload}->>'externalUrl'`,
          error: sql<string | null>`${replies.error}->>'message'`,
          retryAt: sql<string | null>`${runs.output}->>'retryAt'`,
          at,
        })
        .from(runs)
        .innerJoin(workflows, eq(runs.workflowId, workflows.id))
        .leftJoin(replies, eq(replies.runId, runs.id))
        .leftJoin(
          socialAccounts,
          and(
            eq(sql`${socialAccounts.id}::text`, accountId),
            eq(socialAccounts.workspaceId, request.auth.workspaceId),
          ),
        )
        .where(conditions)
        .orderBy(desc(runs.createdAt), desc(runs.id), desc(replies.id))
        .limit(query.limit)
        .offset(query.offset),
      db
        .select({
          total: sql<number>`count(*)::int`,
          sent: sql<number>`count(*) filter (where ${status} = 'succeeded')::int`,
          alreadyReplied: sql<number>`count(*) filter (where ${status} = 'already_replied')::int`,
          waitingApproval: sql<number>`count(*) filter (where ${status} = 'waiting_approval')::int`,
          failed: sql<number>`count(*) filter (where ${status} = 'failed')::int`,
        })
        .from(runs)
        .innerJoin(workflows, eq(runs.workflowId, workflows.id))
        .leftJoin(replies, eq(replies.runId, runs.id))
        .where(conditions),
    ]);
    const totals = counts[0];
    return {
      rows,
      totals,
      limit: query.limit,
      offset: query.offset,
      hasMore: query.offset + rows.length < totals.total,
    };
  });
}
