import { Queue } from "bullmq";
import IORedis from "ioredis";

const connection = new IORedis(
  process.env.REDIS_URL ?? "redis://localhost:6379",
  { maxRetriesPerRequest: null },
);

export const workflowQueue = new Queue("workflow-runs", { connection });
export const publicationQueue = new Queue("publication-jobs", { connection });

export async function closeQueue() {
  await Promise.all([
    workflowQueue.close(),
    publicationQueue.close(),
  ]);
  await connection.quit();
}
