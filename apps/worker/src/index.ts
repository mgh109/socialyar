import { Worker } from "bullmq";
import { closeDb } from "@socialyar/db";
import { executeRun } from "@socialyar/workflow";
import { connection } from "./queue";

const worker = new Worker(
  "workflow-runs",
  async (job) => {
    const data = job.data as {
      runId: string;
      workflowId: string;
      workflowVersionId: string;
    };

    return executeRun(data);
  },
  {
    connection,
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4),
  },
);

worker.on("completed", (job) => {
  console.log(`Run job ${job.id} completed`);
});

worker.on("failed", (job, error) => {
  console.error(`Run job ${job?.id ?? "unknown"} failed`, error);
});

const shutdown = async () => {
  await worker.close();
  await connection.quit();
  await closeDb();
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

console.log("SocialYar workflow worker is ready");
