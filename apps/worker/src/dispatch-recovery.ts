import { and, eq, lt, lte, inArray, sql, asc, or, isNull } from "drizzle-orm";
import type { Queue } from "bullmq";
import { getDb, runs, publications, schedules, contentVariants } from "@socialyar/db";

export type DispatchRecoveryOptions = {
  database: ReturnType<typeof getDb>;
  workflowQueue: Pick<Queue, "getJob" | "add">;
  publicationQueue: Pick<Queue, "getJob" | "add">;
  prepare: (runId: string) => Promise<unknown>;
  recover: (input: { publicationId: string; queueVersion: number; attempt: number; maxAttempts: number }) => Promise<unknown>;
  reserveSlot: (accountId: string, intervalSeconds: number) => Promise<number>;
};

/** Reconcile durable database intent with versioned Redis jobs. */
export async function reconcileDispatch(options: DispatchRecoveryOptions, now = new Date()) {
  const { database: db, workflowQueue, publicationQueue, prepare, recover, reserveSlot } = options;
    const queued = await db.select().from(runs).where(and(eq(runs.status, "queued"), lt(runs.createdAt, new Date(now.getTime() - 10000)))).orderBy(asc(runs.createdAt)).limit(100);
    for (const run of queued) {
      const jobId = `run-${run.id}-dispatch-${run.dispatchVersion}`;
      const prior = await workflowQueue.getJob(jobId);
      if (prior) {
        const state = await prior.getState();
        if (state === "failed" || state === "completed") await prior.remove();
        else continue;
      }
      await workflowQueue.add("execute-workflow", { runId: run.id, workflowId: run.workflowId, workflowVersionId: run.workflowVersionId },
        { jobId, attempts: 3, backoff: { type: "exponential", delay: 2000 }, removeOnComplete: 1000 });
    }
    const unprepared = await db.select().from(runs).where(and(inArray(runs.status, ["completed", "failed"]),
      sql`${runs.output}->>'publicationPrepared' IS DISTINCT FROM 'true'`,
      sql`EXISTS (SELECT 1 FROM jsonb_each(COALESCE(${runs.output}, '{}'::jsonb)) entry WHERE entry.value->>'queuedForPublication' = 'true')`)).orderBy(asc(runs.finishedAt)).limit(50);
    for (const run of unprepared) await prepare(run.id);
    const pendingPublications = await db.select({ publication: publications, schedule: schedules, variant: contentVariants }).from(publications)
      .innerJoin(contentVariants, eq(contentVariants.id, publications.contentVariantId))
      .leftJoin(schedules, eq(schedules.id, publications.scheduleId))
      .where(and(eq(publications.status, "queued"), inArray(contentVariants.status, ["approved", "scheduled"]),
        or(isNull(schedules.id), lte(schedules.scheduledAt, now)),
        lt(publications.createdAt, new Date(now.getTime() - 60000))))
      .orderBy(asc(publications.createdAt)).limit(100);
    for (const { publication, schedule, variant } of pendingPublications) {
      if (!["approved", "scheduled"].includes(variant.status)) continue;
      const jobId = publication.queueVersion ? `publication-${publication.id}-v${publication.queueVersion}` : `publication-${publication.id}`;
      const prior = await publicationQueue.getJob(jobId);
      if (prior) {
        const state = await prior.getState();
        if (state === "failed" || state === "completed") await prior.remove();
        else continue;
      }
      const interval = Number(variant.settings.publishIntervalSeconds ?? 30);
      const pace = variant.settings.pacedInQueue === true && publication.socialAccountId && Number.isInteger(interval) && interval >= 30 && interval <= 604800
        ? await reserveSlot(publication.socialAccountId, interval) : 0;
      await publicationQueue.add("publish-content", { publicationId: publication.id, queueVersion: publication.queueVersion },
        { jobId, delay: Math.max(pace, (schedule?.scheduledAt.getTime() ?? now.getTime()) - now.getTime()), attempts: variant.channel === "instagram" ? 10 : 3,
          backoff: { type: variant.channel === "instagram" ? "fixed" : "exponential", delay: variant.channel === "instagram" ? 60000 : 5000 }, removeOnComplete: 1000 });
    }
    const interrupted = await db.select().from(publications).where(and(eq(publications.status, "publishing"), lt(publications.updatedAt, new Date(now.getTime() - 60000)))).orderBy(asc(publications.updatedAt)).limit(50);
    for (const publication of interrupted) {
      // The exclusive session lock rejects a live sender. A disconnected owner
      // can be recovered safely before send, or held as delivery unknown after.
      try { await recover({ publicationId: publication.id, queueVersion: publication.queueVersion, attempt: publication.attempt + 1, maxAttempts: 3 }); }
      catch { /* Live ownership or a failed send is handled by the next pass/job. */ }
    }
}
