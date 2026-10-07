import { and, eq, inArray } from "drizzle-orm";
import { connectionChecks, getDb, runConnectionCheck, connectionPolicy, connectionErrorReason, type PublishingTarget } from "@socialyar/db";
export async function executeConnectionCheck(id: string) {
  const db = getDb();
  const [check] = await db.update(connectionChecks).set({ status: "running" }).where(and(eq(connectionChecks.id, id), inArray(connectionChecks.status, ["queued", "running"]))).returning();
  if (!check) return;
  const started = Date.now();
  try {
    const result = await runConnectionCheck(check.workspaceId, check.target as PublishingTarget, connectionPolicy(check.config));
    await db.update(connectionChecks).set({ status: result.reachable ? "completed" : "failed", result, checkedAt: new Date() }).where(eq(connectionChecks.id, id));
  } catch (error) {
    await db.update(connectionChecks).set({ status: "failed", result: { reachable: false, error: connectionErrorReason(error), responseMs: Date.now() - started, executor: "publication-worker" }, checkedAt: new Date() }).where(eq(connectionChecks.id, id));
  }
}
