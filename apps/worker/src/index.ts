import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { executeRun } from "@socialyar/workflow";

const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

export const workflowQueue = new Queue("workflow-runs", { connection });

new Worker(
  "workflow-runs",
  async (job) => executeRun(job.data),
  { connection },
);

console.log("SocialYar worker is ready");
