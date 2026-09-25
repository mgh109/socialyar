import { and, asc, eq } from "drizzle-orm";
import { generateNewsDraft, type AIConnection } from "@socialyar/ai";
import {
  aiSettings, decryptSecret, getDb, runEvents, runs, runSteps, workflowConnections, workflowSteps, workflows,
} from "@socialyar/db";

type ExecuteRunInput = { runId: string; workflowId: string; workflowVersionId: string };
type Step = typeof workflowSteps.$inferSelect;

function orderedGraph(steps: Step[], connections: Array<typeof workflowConnections.$inferSelect>): Step[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const incoming = new Map(steps.map((step) => [step.id, 0]));
  const outgoing = new Map(steps.map((step) => [step.id, [] as string[]]));
  for (const edge of connections) {
    if (edge.condition && Object.keys(edge.condition).length) throw new Error("Conditional connections are not implemented");
    if (!byId.has(edge.sourceStepId) || !byId.has(edge.targetStepId)) throw new Error("Invalid workflow connection");
    incoming.set(edge.targetStepId, (incoming.get(edge.targetStepId) ?? 0) + 1);
    outgoing.get(edge.sourceStepId)!.push(edge.targetStepId);
  }
  const ready = steps.filter((step) => incoming.get(step.id) === 0).sort((a, b) => a.order - b.order);
  const ordered: Step[] = [];
  while (ready.length) {
    const step = ready.shift()!;
    ordered.push(step);
    for (const target of outgoing.get(step.id)!) {
      const remaining = incoming.get(target)! - 1;
      incoming.set(target, remaining);
      if (remaining === 0) {
        ready.push(byId.get(target)!);
        ready.sort((a, b) => a.order - b.order);
      }
    }
  }
  if (ordered.length !== steps.length) throw new Error("Workflow contains a cycle");
  return ordered;
}

export async function executeRun(input: ExecuteRunInput) {
  const db = getDb();
  const [run] = await db.select().from(runs).where(eq(runs.id, input.runId)).limit(1);
  if (!run || run.workflowId !== input.workflowId || run.workflowVersionId !== input.workflowVersionId) {
    throw new Error("Run does not match workflow version");
  }
  if (run.status === "completed" || run.status === "cancelled" || run.status === "waiting_approval") return;
  const [claimed] = await db.update(runs).set({ status: "running", startedAt: run.startedAt ?? new Date() })
    .where(and(eq(runs.id, run.id), eq(runs.status, run.status))).returning();
  if (!claimed) return;

  try {
    const steps = await db.select().from(workflowSteps)
      .where(eq(workflowSteps.workflowVersionId, run.workflowVersionId)).orderBy(asc(workflowSteps.order));
    const connections = await db.select().from(workflowConnections)
      .where(eq(workflowConnections.workflowVersionId, run.workflowVersionId));
    const ordered = orderedGraph(steps, connections);
    const previous = await db.select().from(runSteps).where(eq(runSteps.runId, run.id));
    const outputs: Record<string, unknown> = { ...(run.output ?? {}) };

    for (const step of ordered) {
      const prior = previous.find((row) => row.workflowStepId === step.id);
      if (prior?.status === "completed") {
        outputs[step.key] = prior.output;
        continue;
      }
      if (prior?.status === "waiting_approval") {
        await db.update(runs).set({ status: "waiting_approval", output: outputs }).where(eq(runs.id, run.id));
        return { runId: run.id, status: "waiting_approval", outputs };
      }
      const [record] = prior
        ? await db.update(runSteps).set({ status: "running", attempt: prior.attempt + 1, startedAt: new Date(), error: null })
          .where(eq(runSteps.id, prior.id)).returning()
        : await db.insert(runSteps).values({ runId: run.id, workflowStepId: step.id, status: "running", attempt: 1,
          input: { runInput: run.input, previous: outputs }, startedAt: new Date() }).returning();
      await db.insert(runEvents).values({ runId: run.id, runStepId: record.id, type: "step_started", message: step.name });
      try {
        if (step.type === "human_approval" || step.type === "approval") {
          const output = { waitingForHuman: true, recommendation: step.config.recommendation ?? null };
          await db.update(runSteps).set({ status: "waiting_approval", output }).where(eq(runSteps.id, record.id));
          await db.update(runs).set({ status: "waiting_approval", output: outputs }).where(eq(runs.id, run.id));
          await db.insert(runEvents).values({ runId: run.id, runStepId: record.id, type: "approval_requested", message: step.name });
          return { runId: run.id, status: "waiting_approval", outputs };
        }
        let output: Record<string, unknown>;
        if (step.type === "source" || step.type === "manual_input" || step.type === "rss_source") {
          const text = run.input.text ?? run.input.prompt;
          if (typeof text !== "string" || !text.trim()) throw new Error("A text input is required");
          output = { text: text.trim(), title: run.input.title ?? null, url: run.input.url ?? null, imageUrl: run.input.imageUrl ?? null };
        } else if (step.type === "ai") {
          const [workflow] = await db.select({ workspaceId: workflows.workspaceId }).from(workflows)
            .where(eq(workflows.id, run.workflowId)).limit(1);
          const [settings] = workflow ? await db.select().from(aiSettings)
            .where(eq(aiSettings.workspaceId, workflow.workspaceId)).limit(1) : [];
          if (!settings) throw new Error("AI token is not configured for this workspace");
          const upstream = [...ordered.slice(0, ordered.indexOf(step))].reverse()
            .map((previous) => outputs[previous.key] as { text?: string; title?: string; url?: string; imageUrl?: string } | undefined)
            .find((value) => typeof value?.text === "string");
          if (!upstream?.text) throw new Error("AI step needs text from the previous step");
          const text = await generateNewsDraft({ provider: settings.provider as AIConnection["provider"],
            model: settings.model, token: decryptSecret(settings.encryptedToken) },
          { title: upstream.title || "خبر", text: upstream.text, url: upstream.url },
          typeof step.config.instructions === "string" ? step.config.instructions : undefined);
          output = { text, title: upstream.title ?? null, url: upstream.url ?? null, imageUrl: upstream.imageUrl ?? null };
        } else if (step.type === "publish") {
          const upstream = [...ordered.slice(0, ordered.indexOf(step))].reverse()
            .map((previous) => outputs[previous.key] as { text?: string; title?: string; url?: string; imageUrl?: string } | undefined)
            .find((value) => typeof value?.text === "string");
          if (!upstream?.text) throw new Error("Publish step needs text from the previous step");
          output = { ...upstream, queuedForPublication: true };
        } else if (step.type === "draft") {
          const source = step.config.sourceKey;
          const key = typeof source === "string" ? source : null;
          const upstream = key ? outputs[key] : [...ordered.slice(0, ordered.indexOf(step))].reverse()
            .map((previous) => outputs[previous.key] as { text?: string } | undefined)
            .find((value) => typeof value?.text === "string");
          const text = upstream && typeof upstream === "object" && "text" in upstream ? upstream.text : null;
          if (typeof text !== "string") throw new Error("Draft requires a text output from the preceding step");
          output = { text, title: typeof step.config.title === "string" ? step.config.title : null };
        } else {
          throw new Error(`Step type ${step.type} is not implemented`);
        }
        outputs[step.key] = output;
        await db.update(runSteps).set({ status: "completed", output, finishedAt: new Date() }).where(eq(runSteps.id, record.id));
        await db.insert(runEvents).values({ runId: run.id, runStepId: record.id, type: "step_completed", message: step.name, payload: output });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown step error";
        await db.update(runSteps).set({ status: "failed", error: { message }, finishedAt: new Date() }).where(eq(runSteps.id, record.id));
        await db.insert(runEvents).values({ runId: run.id, runStepId: record.id, type: "step_failed", message });
        throw error;
      }
    }
    await db.update(runs).set({ status: "completed", output: outputs, finishedAt: new Date() }).where(eq(runs.id, run.id));
    await db.insert(runEvents).values({ runId: run.id, type: "run_completed", message: "Run completed", payload: { outputs } });
    return { runId: run.id, status: "completed", outputs };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown run error";
    await db.update(runs).set({ status: "failed", output: { error: { message } }, finishedAt: new Date() }).where(eq(runs.id, run.id));
    await db.insert(runEvents).values({ runId: run.id, type: "run_failed", message, payload: { message } });
    throw error;
  }
}
