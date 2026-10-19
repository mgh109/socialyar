import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { getDb, workflows, runs, runSteps, workflowSteps } from "@socialyar/db";
import { instagramCards } from "@socialyar/shared";
export async function instagramWorkflowRoutes(
  app: FastifyInstance,
  db = getDb(),
) {
  app.get("/workflows/:workflowId/instagram", async (request, reply) => {
    const { workflowId } = z
      .object({ workflowId: z.string().uuid() })
      .parse(request.params);
    const { stepKey } = z
      .object({ stepKey: z.string().min(1).max(200) })
      .parse(request.query);
    const [workflow] = await db
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          eq(workflows.id, workflowId),
          eq(workflows.workspaceId, request.auth.workspaceId),
        ),
      );
    if (!workflow) return reply.code(404).send({ error: "جریان پیدا نشد." });
    return db
      .select({
        runId: runs.id,
        type: workflowSteps.type,
        status: runSteps.status,
        output: runSteps.output,
        error: runSteps.error,
        at: runSteps.startedAt,
        costMicros: runSteps.costMicros,
        inputTokens: runSteps.inputTokens,
        outputTokens: runSteps.outputTokens,
        model: runSteps.model,
      })
      .from(runSteps)
      .innerJoin(runs, eq(runs.id, runSteps.runId))
      .innerJoin(workflowSteps, eq(workflowSteps.id, runSteps.workflowStepId))
      .where(
        and(
          eq(runs.workflowId, workflowId),
          eq(workflowSteps.key, stepKey),
          inArray(
            workflowSteps.type,
            instagramCards.map((c) => c.type),
          ),
        ),
      )
      .orderBy(desc(runSteps.startedAt))
      .limit(20);
  });
}
