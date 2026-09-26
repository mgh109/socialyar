import { and, eq } from "drizzle-orm";
import { Queue } from "bullmq";
import { contentItems, contentVariants, getDb, publications, runEvents, runs, runSteps, socialAccounts, workflowSteps, workflows } from "@socialyar/db";
import { connection } from "./queue";

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
    if (!generated?.text) continue;
    try {
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
    if (typeof publishIntervalSeconds !== "number" || ![30, 60, 120, 300].includes(publishIntervalSeconds))
      throw new Error("Invalid publication interval");
    if (typeof accountId !== "string") throw new Error("Publish step needs an Eitaa account");
    const [account] = await db.select().from(socialAccounts)
      .where(and(eq(socialAccounts.id, accountId), eq(socialAccounts.workspaceId, row.workspaceId),
        eq(socialAccounts.channel, "eitaa"), eq(socialAccounts.isActive, true))).limit(1);
    if (!account) throw new Error("Eitaa account is no longer active");

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
      eq(contentVariants.contentItemId, content.id), eq(contentVariants.channel, "eitaa"))).limit(1);
    if (!variant) {
      [variant] = await db.insert(contentVariants).values({ contentItemId: content.id, channel: "eitaa",
        title: content.title, body: generated.text,
        settings: { imageUrl: generated.imageUrl ?? null, videoUrl: generated.videoUrl ?? null,
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
    if (publication.status === "published" || publication.status === "publishing") continue;
    await publicationQueue.add("publish-content", { publicationId: publication.id }, {
      jobId: `publication-${publication.id}`, attempts: 3, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 1000,
    });
    } catch (error) {
      console.error(`Publication branch ${publishStep.key} failed for run ${runId}`, error);
      await db.insert(runEvents).values({ runId, type: "step_failed", message: `انتشار ${publishStep.name}: ${error instanceof Error ? error.message : "خطا"}` });
    }
  }
}

export async function closeAutoPublisher() { await publicationQueue.close(); }
