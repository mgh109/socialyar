import { reconcileDispatch } from "./dispatch-recovery";
import { Queue, Worker } from "bullmq";
import { closeDb, getDb, ensurePublishingStorage } from "@socialyar/db";
import { executeRun } from "@socialyar/workflow";
import { executePublication } from "./publisher";
import { prepareCollectionVideo } from "./collection-prepare";
import { executeYoutube } from "./youtube";
import { executeConnectionCheck } from "./connection-check";
import { closeAutoPublisher, enqueueAutoPublication } from "./auto-publish";
import { startNewsPoller } from "./news-poller";
import { connection, reservePublicationSlot } from "./queue";
import { startCollectionSheetPoller } from "./collection-sheet-poller";
await ensurePublishingStorage();

const workflowWorker = new Worker(
  "workflow-runs",
  async (job) => {
    const data = job.data as {
      runId: string;
      workflowId: string;
      workflowVersionId: string;
    };

    const result = await executeRun(data);
    await enqueueAutoPublication(data.runId);
    return result;
  },
  {
    connection,
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4),
  },
);

const publicationWorker = new Worker(
  "publication-jobs",
  async (job) => {
    if (job.name === "youtube-prepare") return prepareCollectionVideo(job.data.youtubeItemId, job.data.queueVersion);
    if (job.name === "youtube-publish") return executeYoutube(job.data.youtubeItemId, undefined, job.data.queueVersion ?? 0);
    const data = job.data as { publicationId: string };
    const maxAttempts = Number(job.opts.attempts ?? 1);

    return executePublication({
      publicationId: data.publicationId,
      attempt: job.attemptsMade + 1,
      maxAttempts,
      queueVersion: job.data.queueVersion ?? 0,
    });
  },
  {
    connection,
    concurrency: Number(process.env.PUBLISHER_CONCURRENCY ?? 2),
  },
);

// Database queued rows are durable dispatch intents; Redis may be unavailable
// immediately after an approval transaction commits.
const recoveryQueue = new Queue("workflow-runs", { connection });
const publicationRecoveryQueue = new Queue("publication-jobs", { connection });
let recovering = false;
async function recoverDispatch() {
  if (recovering) return;
  recovering = true;
  try {
    await reconcileDispatch({ database: getDb(), workflowQueue: recoveryQueue, publicationQueue: publicationRecoveryQueue,
      prepare: enqueueAutoPublication, recover: executePublication, reserveSlot: reservePublicationSlot });
  } catch (error) { console.error("بازیابی صف اجرا ناموفق بود", error); }
  finally { recovering = false; }
}
const recoveryTimer = setInterval(() => void recoverDispatch(), 30000);
void recoverDispatch();

const stopCollectionSheetPoller = startCollectionSheetPoller();
const stopNewsPoller = startNewsPoller();
const connectionCheckWorker = new Worker("connection-checks", (job) => executeConnectionCheck(job.data.checkId), { connection, concurrency: 2 });

workflowWorker.on("completed", (job) => {
  console.log(`Run job ${job.id} completed`);
});

workflowWorker.on("failed", (job, error) => {
  console.error(`Run job ${job?.id ?? "unknown"} failed`, error);
});

publicationWorker.on("completed", (job) => {
  console.log(`Publication job ${job.id} completed`);
});

publicationWorker.on("failed", (job, error) => {
  console.error(
    `Publication job ${job?.id ?? "unknown"} failed after attempt ${job?.attemptsMade ?? 0}`,
    error,
  );
});

const shutdown = async () => {
  clearInterval(recoveryTimer);
  stopCollectionSheetPoller();
  await Promise.all([
    recoveryQueue.close(),
    publicationRecoveryQueue.close(),
    workflowWorker.close(),
    publicationWorker.close(),
    connectionCheckWorker.close(),
    closeAutoPublisher(),
    stopNewsPoller(),
  ]);
  await connection.quit();
  await closeDb();
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

console.log("SocialYar workflow + publisher workers are ready");
