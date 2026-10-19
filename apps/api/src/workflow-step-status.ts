import { and, asc, desc, eq } from "drizzle-orm";
import { getDb, runs, runSteps, workflowSteps } from "@socialyar/db";

/** Last actual execution per card, scoped to the currently displayed graph. */
export function latestWorkflowStepStates(db: ReturnType<typeof getDb>, workflowId: string, versionId: string) {
  return db.selectDistinctOn([workflowSteps.key], {
    stepKey: workflowSteps.key,
    status: runSteps.status,
    startedAt: runSteps.startedAt,
  }).from(runSteps)
    .innerJoin(runs, eq(runSteps.runId, runs.id))
    .innerJoin(workflowSteps, eq(runSteps.workflowStepId, workflowSteps.id))
    .where(and(eq(runs.workflowId, workflowId), eq(runs.workflowVersionId, versionId),
      eq(workflowSteps.workflowVersionId, versionId)))
    .orderBy(asc(workflowSteps.key), desc(runSteps.startedAt), desc(runSteps.id));
}
