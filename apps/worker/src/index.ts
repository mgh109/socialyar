import { Worker } from "bullmq";
import { closeDb } from "@socialyar/db";
import { executeRun } from "@socialyar/workflow";
import { executePublication } from "./publisher";
import { closeAutoPublisher, enqueueAutoPublication } from "./auto-publish";
import { startNewsPoller } from "./news-poller";
import { connection } from "./queue";

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
    const data = job.data as { publicationId: string };
    const maxAttempts = Number(job.opts.attempts ?? 1);

    return executePublication({
      publicationId: data.publicationId,
      attempt: job.attemptsMade + 1,
      maxAttempts,
    });
  },
  {
    connection,
    concurrency: Number(process.env.PUBLISHER_CONCURRENCY ?? 2),
  },
);

const stopNewsPoller = startNewsPoller();

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
  await Promise.all([
    workflowWorker.close(),
    publicationWorker.close(),
    closeAutoPublisher(),
    stopNewsPoller(),
  ]);
  await connection.quit();
  await closeDb();
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

console.log("SocialYar workflow + publisher workers are ready");
