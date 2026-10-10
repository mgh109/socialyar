import { and, eq, inArray } from "drizzle-orm";
import { assertWorkspaceOperational, connectionChecks, getDb, runConnectionCheck, connectionPolicy, connectionErrorReason, type PublishingTarget, fetchCollectionMedia } from "@socialyar/db";
export async function executeConnectionCheck(id: string) {
  const db = getDb();
  const [check] = await db.update(connectionChecks).set({ status: "running" }).where(and(eq(connectionChecks.id, id), inArray(connectionChecks.status, ["queued", "running"]))).returning();
  if (!check) return;
  const started = Date.now();
  try {
    await assertWorkspaceOperational(db,check.workspaceId);
    if (check.target === "media") {
      await fetchCollectionMedia(check.workspaceId,String(check.config.videoUrl),"video",check.config.connection,true);
      await db.update(connectionChecks).set({ status:"completed",checkedAt:new Date(),result:{ reachable:true,responseMs:Date.now()-started,executor:"publication-worker",authorizationVerified:false } }).where(eq(connectionChecks.id,id));
      return;
    }
    const result = await runConnectionCheck(check.workspaceId, check.target as PublishingTarget, connectionPolicy(check.config));
    await db.update(connectionChecks).set({ status: result.reachable ? "completed" : "failed", result, checkedAt: new Date() }).where(eq(connectionChecks.id, id));
  } catch (error) {
    await db.update(connectionChecks).set({ status: "failed", result: { reachable: false, error: connectionErrorReason(error), responseMs: Date.now() - started, executor: "publication-worker" }, checkedAt: new Date() }).where(eq(connectionChecks.id, id));
  }
}
