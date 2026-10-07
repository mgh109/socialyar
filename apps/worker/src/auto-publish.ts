import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Queue } from "bullmq";
import { contentItems, contentVariants, getDb, publications, runEvents, runs, runSteps, socialAccounts, workflowSteps, workflows, youtubeItems, fetchYoutubeMedia, storeYoutubeMedia } from "@socialyar/db";
import { connection, reservePublicationSlot } from "./queue";

const publicationQueue = new Queue("publication-jobs", { connection });

export async function enqueueAutoPublication(runId: string) {
  const db = getDb();
  const [row] = await db.select({ run: runs, workspaceId: workflows.workspaceId })
    .from(runs).innerJoin(workflows, eq(runs.workflowId, workflows.id))
    .where(eq(runs.id, runId)).limit(1);
  if (!row || !["completed", "waiting_approval", "failed"].includes(row.run.status)) return;
  const publishSteps = await db.select().from(workflowSteps)
    .where(and(eq(workflowSteps.workflowVersionId, row.run.workflowVersionId), eq(workflowSteps.type, "publish")));
  const steps = await db.select().from(workflowSteps)
    .where(eq(workflowSteps.workflowVersionId, row.run.workflowVersionId));
  const executed = await db.select().from(runSteps).where(eq(runSteps.runId, runId));
  const stepByKey = new Map(steps.map((step) => [step.key, step]));
  const parentByKey = new Map(executed.map((record) => {
    const step = steps.find((item) => item.id === record.workflowStepId);
    return [step?.key, record.input.parentKey] as const;
  }));
  for (const publishStep of publishSteps) {
    const generated = row.run.output?.[publishStep.key] as { text?: string; title?: string; url?: string;
      imageUrl?: string; videoUrl?: string } | undefined;
    const [youtubeAccount] = typeof publishStep.config.accountId === "string" ? await db.select().from(socialAccounts)
      .where(and(eq(socialAccounts.id, publishStep.config.accountId), eq(socialAccounts.workspaceId, row.workspaceId), eq(socialAccounts.channel, "youtube"), eq(socialAccounts.isActive, true))).limit(1) : [];
    try {
    if (youtubeAccount) {
      if (!generated) continue; // Respect upstream filters and approval gates.
      const videoUrl = generated?.videoUrl ?? publishStep.config.videoUrl;
      let videoMediaId: string | undefined; let coverMediaId: string | undefined;
      if (typeof videoUrl === "string" && videoUrl) {
        const video = await fetchYoutubeMedia(videoUrl, 250_000_000, "video");
        videoMediaId = (await storeYoutubeMedia(row.workspaceId, video.bytes)).mediaId;
      }
      const coverUrl = publishStep.config.coverUrl ?? generated?.imageUrl;
      if (typeof coverUrl === "string" && coverUrl) {
        const cover = await fetchYoutubeMedia(coverUrl, 2_000_000, "image");
        coverMediaId = (await storeYoutubeMedia(row.workspaceId, cover.bytes)).mediaId;
      }
      const itemKey = videoMediaId ?? createHash("sha256").update(`missing:${runId}`).digest("hex");
      const inserted = await db.insert(youtubeItems).values({ workspaceId: row.workspaceId, workflowId: row.run.workflowId, runId,
        stepKey: publishStep.key, itemKey, accountId: youtubeAccount.id,
        channelName: youtubeAccount.displayName ?? youtubeAccount.externalAccountId,
        title: String(publishStep.config.youtubeTitle || generated?.title || "ویدئوی جدید"),
        description: String(publishStep.config.youtubeDescription ?? generated?.text ?? ""),
        settings: { videoMediaId, coverMediaId, connection: publishStep.config.connection,
          privacy: publishStep.config.privacy ?? "private", tags: publishStep.config.tags ?? [], madeForKids: publishStep.config.madeForKids === true },
        scheduledAt: typeof publishStep.config.scheduledAt === "string" && publishStep.config.scheduledAt ? new Date(publishStep.config.scheduledAt) : null,
        status: videoMediaId ? "waiting_approval" : "waiting_video",
      }).onConflictDoNothing().returning({ id: youtubeItems.id });
      if (!inserted.length) {
        await db.insert(runEvents).values({ runId, type: "step_completed", message: "یوتیوب: این ویدئو قبلاً ثبت شده است؛ آپلود تکراری انجام نمی‌شود.",
          payload: { stepKey: publishStep.key, channel: youtubeAccount.displayName, itemKey, result: "duplicate_skipped" } });
      }
      continue;
    }
    if (!generated?.text) continue;
    const path: string[] = [];
    const visited = new Set<string>();
    let key: unknown = publishStep.key;
    while (typeof key === "string" && !visited.has(key)) {
      visited.add(key);
      const step = stepByKey.get(key);
      if (step) path.unshift(step.name);
      key = parentByKey.get(key);
    }
    const accountId = publishStep.config.accountId;
    const publishIntervalSeconds = publishStep.config.publishIntervalSeconds ?? 30;
    if (typeof publishIntervalSeconds !== "number" || !Number.isInteger(publishIntervalSeconds) ||
      publishIntervalSeconds < 30 || publishIntervalSeconds > 604800)
      throw new Error("Invalid publication interval");
    if (typeof accountId !== "string") throw new Error("مقصد انتشار انتخاب نشده است");
    const [account] = await db.select().from(socialAccounts)
      .where(and(eq(socialAccounts.id, accountId), eq(socialAccounts.workspaceId, row.workspaceId),
        eq(socialAccounts.isActive, true))).limit(1);
    if (!account || !["eitaa", "telegram", "website"].includes(account.channel))
      throw new Error("مقصد انتشار معتبر یا فعال نیست");

    const existing = await db.select().from(contentItems).where(eq(contentItems.runId, runId));
    let content = existing.find((item) => item.metadata.publishStepKey === publishStep.key) ??
      (publishSteps.length === 1 ? existing.find((item) => !item.metadata.publishStepKey) : undefined);
    if (!content) {
      [content] = await db.insert(contentItems).values({ workspaceId: row.workspaceId, runId,
        title: generated.title ?? "خبر جدید", body: generated.text,
        metadata: { sourceUrl: generated.url ?? null, imageUrl: generated.imageUrl ?? null,
          videoUrl: generated.videoUrl ?? null, automated: true, publishStepKey: publishStep.key,
          routePath: path }, status: "approved" }).returning();
    }
    let [variant] = await db.select().from(contentVariants).where(and(
      eq(contentVariants.contentItemId, content.id), eq(contentVariants.channel, account.channel))).limit(1);
    if (!variant) {
      [variant] = await db.insert(contentVariants).values({ contentItemId: content.id, channel: account.channel,
        title: content.title, body: generated.text,
        settings: { imageUrl: generated.imageUrl ?? null, videoUrl: generated.videoUrl ?? null, connection: publishStep.config.connection,
          publishIntervalSeconds }, status: "approved", generatedBy: "ai" }).returning();
    } else if (variant.settings.publishIntervalSeconds !== publishIntervalSeconds) {
      [variant] = await db.update(contentVariants).set({ settings: { ...variant.settings, publishIntervalSeconds } })
        .where(eq(contentVariants.id, variant.id)).returning();
    }
    let [publication] = await db.select().from(publications)
      .where(eq(publications.contentVariantId, variant.id)).limit(1);
    if (!publication) {
      [publication] = await db.insert(publications).values({ workspaceId: row.workspaceId,
        contentVariantId: variant.id, socialAccountId: account.id, status: "queued" }).returning();
    }
    if (["published", "publishing", "cancelled", "failed"].includes(publication.status) || publication.queueVersion > 0) continue;
    if (await publicationQueue.getJob(`publication-${publication.id}`)) continue;
    const delay = await reservePublicationSlot(account.id, publishIntervalSeconds);
    await db.update(contentVariants).set({ settings: { ...variant.settings, pacedInQueue: true } })
      .where(eq(contentVariants.id, variant.id));
    await publicationQueue.add("publish-content", { publicationId: publication.id }, {
      jobId: `publication-${publication.id}`, delay, attempts: 3,
      backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 1000,
    });
    } catch (error) {
      if (youtubeAccount && generated) {
        const message = error instanceof Error ? error.message : "Video preparation failed";
        await db.insert(youtubeItems).values({ workspaceId: row.workspaceId, workflowId: row.run.workflowId, runId,
          stepKey: publishStep.key, itemKey: `preparation:${runId}`, accountId: youtubeAccount.id,
          channelName: youtubeAccount.displayName ?? youtubeAccount.externalAccountId,
          title: String(publishStep.config.youtubeTitle || generated.title || "ویدئوی جدید"),
          description: String(publishStep.config.youtubeDescription || generated.text || ""), status: "failed", error: message,
          settings: { connection: publishStep.config.connection, sourceVideoUrl: generated.videoUrl ?? publishStep.config.videoUrl,
            sourceCoverUrl: publishStep.config.coverUrl ?? generated.imageUrl,
            privacy: publishStep.config.privacy ?? "private", tags: publishStep.config.tags ?? [], madeForKids: publishStep.config.madeForKids === true },
          scheduledAt: typeof publishStep.config.scheduledAt === "string" && publishStep.config.scheduledAt ? new Date(publishStep.config.scheduledAt) : null,
          logs: [{ channel: youtubeAccount.displayName, time: new Date().toISOString(), result: "preparation_failed", error: message }],
        }).onConflictDoNothing();
      }
      console.error(`Publication branch ${publishStep.key} failed for run ${runId}`, error);
      await db.insert(runEvents).values({ runId, type: "step_failed", message: `انتشار ${publishStep.name}: ${error instanceof Error ? error.message : "خطا"}` });
    }
  }
}

export async function closeAutoPublisher() { await publicationQueue.close(); }
