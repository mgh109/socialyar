import type { RunStatus } from "@socialyar/shared";

export type WorkflowRun = {
  id: string;
  workflowId: string;
  status: RunStatus;
  startedAt: string;
};

export function createRun(workflowId: string): WorkflowRun {
  return {
    id: crypto.randomUUID(),
    workflowId,
    status: "queued",
    startedAt: new Date().toISOString(),
  };
}

export async function executeRun(input: { runId: string; workflowId: string }) {
  return {
    ...input,
    status: "completed" as const,
    finishedAt: new Date().toISOString(),
  };
}
