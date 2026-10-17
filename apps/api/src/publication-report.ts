import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import {
  contentItems,
  contentVariants,
  getDb,
  publications,
  workflows,
  youtubeItems,
} from "@socialyar/db";

// Both publishing paths are read directly, including records created before reports supported YouTube.
export async function publicationReport(
  db: ReturnType<typeof getDb>,
  workspaceId: string,
  from?: string,
  to?: string,
) {
  const [standard, videos] = await Promise.all([
    db
      .select({
        publication: publications,
        variant: contentVariants,
        content: contentItems,
      })
      .from(publications)
      .innerJoin(
        contentVariants,
        eq(publications.contentVariantId, contentVariants.id),
      )
      .innerJoin(
        contentItems,
        eq(contentVariants.contentItemId, contentItems.id),
      )
      .where(
        and(
          eq(publications.workspaceId, workspaceId),
          from ? gte(publications.createdAt, new Date(from)) : undefined,
          to ? lte(publications.createdAt, new Date(to)) : undefined,
        ),
      )
      .orderBy(desc(publications.createdAt)),
    db
      .select({ item: youtubeItems, workflowName: workflows.name })
      .from(youtubeItems)
      .innerJoin(workflows, eq(youtubeItems.workflowId, workflows.id))
      .where(
        and(
          eq(youtubeItems.workspaceId, workspaceId),
          eq(workflows.workspaceId, workspaceId),
          inArray(youtubeItems.status, [
            "queued",
            "uploading",
            "processing",
            "published",
            "failed",
            "cancelled",
          ]),
          from ? gte(youtubeItems.createdAt, new Date(from)) : undefined,
          to ? lte(youtubeItems.createdAt, new Date(to)) : undefined,
        ),
      ),
  ]);
  const rows = [
    ...standard.map((row) => ({ ...row, kind: "standard" as const })),
    ...videos.map(({ item, workflowName }) => {
      const uploadedAt = [...item.logs]
        .reverse()
        .find(
          (log) => log.result === "published" && typeof log.time === "string",
        )?.time;
      const publishedAt =
        item.status === "published"
          ? typeof uploadedAt === "string" &&
            Number.isFinite(Date.parse(uploadedAt))
            ? new Date(uploadedAt)
            : item.updatedAt
          : null;
      return {
        kind: "youtube" as const,
        publication: {
          id: item.id,
          status: ["uploading", "processing"].includes(item.status)
            ? "publishing"
            : item.status,
          attempt: Math.max(
            item.videoId ? 1 : 0,
            item.logs.filter((log) => log.result === "upload_started").length,
          ),
          externalUrl: item.videoId
            ? `https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId)}`
            : null,
          error: item.error ? { message: item.error } : null,
          createdAt: item.createdAt,
          publishedAt,
        },
        variant: { id: item.id, channel: "youtube", title: item.title },
        content: { id: item.id, title: item.title, metadata: {} },
        youtube: {
          accountName: item.channelName,
          workflowId: item.workflowId,
          workflowName,
          runId: item.runId,
          videoId: item.videoId,
          rawStatus: item.status,
          actualPrivacy: item.actualPrivacy,
          requestedPrivacy:
            typeof item.settings.privacy === "string"
              ? item.settings.privacy
              : "private",
          scheduledAt: item.scheduledAt,
        },
      };
    }),
  ].sort(
    (a, b) =>
      b.publication.createdAt.getTime() - a.publication.createdAt.getTime(),
  );
  return rows;
}

export function publicationSummary(
  rows: Awaited<ReturnType<typeof publicationReport>>,
) {
  const channels: Record<
    string,
    {
      channel: string;
      total: number;
      published: number;
      failed: number;
      attempts: number;
    }
  > = {};
  let published = 0,
    failed = 0,
    queued = 0,
    totalAttempts = 0;
  for (const row of rows) {
    const p = row.publication,
      key = row.variant.channel;
    const channel = (channels[key] ??= {
      channel: key,
      total: 0,
      published: 0,
      failed: 0,
      attempts: 0,
    });
    channel.total++;
    channel.attempts += p.attempt;
    totalAttempts += p.attempt;
    if (p.status === "published") {
      published++;
      channel.published++;
    }
    if (p.status === "failed") {
      failed++;
      channel.failed++;
    }
    if (["queued", "publishing"].includes(p.status)) queued++;
  }
  return {
    totals: {
      total: rows.length,
      published,
      failed,
      queued,
      totalAttempts,
      successRate: rows.length
        ? Math.round((published / rows.length) * 100)
        : 0,
    },
    byChannel: Object.values(channels).map((channel) => ({
      ...channel,
      successRate: Math.round((channel.published / channel.total) * 100),
    })),
  };
}
