import { asc, eq } from "drizzle-orm";
import {
  getDb,
  runEvents,
  runs,
  runSteps,
  workflowConnections,
  workflowSteps,
} from "@socialyar/db";

type ExecuteRunInput = {
  runId: string;
  workflowId: string;
  workflowVersionId: string;
};

async function emitEvent(input: {
  runId: string;
  runStepId?: string;
  type:
    | "run_started"
    | "step_started"
    | "step_completed"
    | "step_failed"
    | "retry"
    | "fallback"
    | "approval_requested"
    | "approval_resolved"
    | "run_completed"
    | "run_failed";
  message?: string;
  payload?: Record<string, unknown>;
}) {
  const db = getDb();
  await db.insert(runEvents).values({
    runId: input.runId,
    runStepId: input.runStepId ?? null,
    type: input.type,
    message: input.message ?? null,
    payload: input.payload ?? {},
  });
}

async function executeStep(input: {
  runId: string;
  stepId: string;
  stepType: string;
  stepName: string;
  config: Record<string, unknown>;
}) {
  const db = getDb();

  const [runStep] = await db
    .insert(runSteps)
    .values({
      runId: input.runId,
      workflowStepId: input.stepId,
      status: "running",
      attempt: 1,
      input: { config: input.config },
      startedAt: new Date(),
    })
    .returning();

  await emitEvent({
    runId: input.runId,
    runStepId: runStep.id,
    type: "step_started",
    message: `${input.stepName} started`,
    payload: {
      stepType: input.stepType,
      workflowStepId: input.stepId,
    },
  });

  try {
    let output: Record<string, unknown>;

    switch (input.stepType) {
      case "approval":
      case "human_approval":
        output = {
          waitingForHuman: true,
          recommendation: input.config.recommendation ?? null,
        };

        await db
          .update(runSteps)
          .set({
            status: "waiting_approval",
            output,
            finishedAt: new Date(),
          })
          .where(eq(runSteps.id, runStep.id));

        await db
          .update(runs)
          .set({ status: "waiting_approval" })
          .where(eq(runs.id, input.runId));

        await emitEvent({
          runId: input.runId,
          runStepId: runStep.id,
          type: "approval_requested",
          message: `${input.stepName} requires human approval`,
          payload: output,
        });

        return { state: "waiting_approval" as const, output };

      default:
        output = {
          ok: true,
          stepType: input.stepType,
          stepName: input.stepName,
          executedAt: new Date().toISOString(),
        };
    }

    await db
      .update(runSteps)
      .set({
        status: "completed",
        output,
        finishedAt: new Date(),
      })
      .where(eq(runSteps.id, runStep.id));

    await emitEvent({
      runId: input.runId,
      runStepId: runStep.id,
      type: "step_completed",
      message: `${input.stepName} completed`,
      payload: output,
    });

    return { state: "completed" as const, output };
  } catch (error) {
    const details = {
      message: error instanceof Error ? error.message : "Unknown step error",
    };

    await db
      .update(runSteps)
      .set({
        status: "failed",
        error: details,
        finishedAt: new Date(),
      })
      .where(eq(runSteps.id, runStep.id));

    await emitEvent({
      runId: input.runId,
      runStepId: runStep.id,
      type: "step_failed",
      message: `${input.stepName} failed`,
      payload: details,
    });

    throw error;
  }
}

export async function executeRun(input: ExecuteRunInput) {
  const db = getDb();

  await db
    .update(runs)
    .set({
      status: "running",
      startedAt: new Date(),
    })
    .where(eq(runs.id, input.runId));

  await emitEvent({
    runId: input.runId,
    type: "run_started",
    message: "Worker started run execution",
    payload: {
      workflowId: input.workflowId,
      workflowVersionId: input.workflowVersionId,
    },
  });

  try {
    const steps = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.workflowVersionId, input.workflowVersionId))
      .orderBy(asc(workflowSteps.order));

    await db
      .select()
      .from(workflowConnections)
      .where(eq(workflowConnections.workflowVersionId, input.workflowVersionId));

    const outputs: Record<string, unknown> = {};

    for (const step of steps) {
      const result = await executeStep({
        runId: input.runId,
        stepId: step.id,
        stepType: step.type,
        stepName: step.name,
        config: step.config,
      });

      outputs[step.key] = result.output;

      if (result.state === "waiting_approval") {
        return {
          runId: input.runId,
          status: "waiting_approval" as const,
          outputs,
        };
      }
    }

    await db
      .update(runs)
      .set({
        status: "completed",
        output: outputs,
        finishedAt: new Date(),
      })
      .where(eq(runs.id, input.runId));

    await emitEvent({
      runId: input.runId,
      type: "run_completed",
      message: "Run completed",
      payload: { outputs },
    });

    return {
      runId: input.runId,
      status: "completed" as const,
      outputs,
    };
  } catch (error) {
    const details = {
      message: error instanceof Error ? error.message : "Unknown run error",
    };

    await db
      .update(runs)
      .set({
        status: "failed",
        output: { error: details },
        finishedAt: new Date(),
      })
      .where(eq(runs.id, input.runId));

    await emitEvent({
      runId: input.runId,
      type: "run_failed",
      message: "Run failed",
      payload: details,
    });

    throw error;
  }
}
