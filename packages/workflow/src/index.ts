import { and, asc, eq } from "drizzle-orm";
import { generateNewsDraft, generateNewsTitle, type AIConnection } from "@socialyar/ai";
import {
  aiProfiles, aiSettings, decryptSecret, getDb, runEvents, runs, runSteps, workflowConnections, workflowSteps, workflows,
} from "@socialyar/db";

type ExecuteRunInput = { runId: string; workflowId: string; workflowVersionId: string };
type Step = typeof workflowSteps.$inferSelect;
type Edge = typeof workflowConnections.$inferSelect;
type News = { text?: string; title?: string | null; url?: string | null; imageUrl?: string | null; queuedForPublication?: boolean };

function orderedGraph(steps: Step[], edges: Edge[]): Step[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const degree = new Map(steps.map((step) => [step.id, 0]));
  for (const edge of edges) {
    if (!byId.has(edge.sourceStepId) || !byId.has(edge.targetStepId)) throw new Error("Invalid workflow connection");
    degree.set(edge.targetStepId, degree.get(edge.targetStepId)! + 1);
  }
  const ready = steps.filter((step) => !degree.get(step.id));
  const ordered: Step[] = [];
  while (ready.length) {
    ready.sort((a, b) => a.order - b.order);
    const step = ready.shift()!;
    ordered.push(step);
    for (const edge of edges.filter((edge) => edge.sourceStepId === step.id)) {
      const remaining = degree.get(edge.targetStepId)! - 1;
      degree.set(edge.targetStepId, remaining);
      if (remaining === 0) ready.push(byId.get(edge.targetStepId)!);
    }
  }
  if (ordered.length !== steps.length) throw new Error("Workflow contains a cycle");
  return ordered;
}

export async function executeRun(input: ExecuteRunInput) {
  const db = getDb();
  const [run] = await db.select().from(runs).where(eq(runs.id, input.runId)).limit(1);
  if (!run || run.workflowId !== input.workflowId || run.workflowVersionId !== input.workflowVersionId)
    throw new Error("Run does not match workflow version");
  if (["completed", "cancelled", "waiting_approval"].includes(run.status)) return;
  const [claimed] = await db.update(runs).set({ status: "running", startedAt: run.startedAt ?? new Date() })
    .where(and(eq(runs.id, run.id), eq(runs.status, run.status))).returning();
  if (!claimed) return;

  try {
    const steps = await db.select().from(workflowSteps)
      .where(eq(workflowSteps.workflowVersionId, run.workflowVersionId)).orderBy(asc(workflowSteps.order));
    const edges = await db.select().from(workflowConnections)
      .where(eq(workflowConnections.workflowVersionId, run.workflowVersionId));
    const ordered = orderedGraph(steps, edges);
    const previous = await db.select().from(runSteps).where(eq(runSteps.runId, run.id));
    const records = new Map(previous.map((record) => [record.workflowStepId, record]));
    const outputs: Record<string, unknown> = { ...(run.output ?? {}) };
    const states = new Map<string, string>();
    const selectedSource = typeof run.input.sourceKey === "string" ? run.input.sourceKey :
      ordered.find((step) => ["manual_input", "rss_source", "source"].includes(step.type))?.key;
    let waiting = false;
    let failed = false;

    for (const step of ordered) {
      const prior = records.get(step.id);
      if (prior?.status === "completed") {
        outputs[step.key] = prior.output;
        states.set(step.id, "completed");
        continue;
      }
      if (prior?.status === "skipped" || prior?.status === "failed") {
        states.set(step.id, prior.status);
        if (prior.status === "failed") failed = true;
        continue;
      }
      if (prior?.status === "waiting_approval") {
        states.set(step.id, "waiting_approval"); waiting = true;
        continue;
      }
      if (["rss_source", "manual_input", "source"].includes(step.type) && step.key !== selectedSource) {
        states.set(step.id, "skipped");
        continue;
      }
      const parents = edges.filter((edge) => edge.targetStepId === step.id);
      const activeParent = parents.find((edge) => states.get(edge.sourceStepId) === "completed");
      if (!activeParent && parents.some((edge) => states.get(edge.sourceStepId) === "waiting_approval")) {
        states.set(step.id, "waiting_approval"); waiting = true;
        continue;
      }
      if (parents.length && !activeParent) { states.set(step.id, "skipped"); continue; }
      const parentStep = activeParent && steps.find((item) => item.id === activeParent.sourceStepId);
      const upstream = parentStep ? outputs[parentStep.key] as News | undefined : undefined;
      const [record] = prior
        ? await db.update(runSteps).set({ status: "running", attempt: prior.attempt + 1, startedAt: new Date(), error: null })
          .where(eq(runSteps.id, prior.id)).returning()
        : await db.insert(runSteps).values({ runId: run.id, workflowStepId: step.id, status: "running", attempt: 1,
          input: { runInput: run.input, parentKey: parentStep?.key ?? null }, startedAt: new Date() }).returning();
      await db.insert(runEvents).values({ runId: run.id, runStepId: record.id, type: "step_started", message: step.name });
      try {
        if (step.type === "human_approval" || step.type === "approval") {
          if (!upstream?.text) throw new Error("Approval needs an incoming news item");
          await db.update(runSteps).set({ status: "waiting_approval", output: upstream }).where(eq(runSteps.id, record.id));
          await db.insert(runEvents).values({ runId: run.id, runStepId: record.id, type: "approval_requested", message: step.name });
          states.set(step.id, "waiting_approval"); waiting = true;
          continue;
        }
        let output: News;
        if (["source", "manual_input", "rss_source"].includes(step.type)) {
          const text = run.input.text ?? run.input.prompt;
          if (typeof text !== "string" || !text.trim()) throw new Error("A text input is required");
          output = { text: text.trim(), title: run.input.title as string ?? null,
            url: run.input.url as string ?? null, imageUrl: run.input.imageUrl as string ?? null };
        } else if (step.type === "filter") {
          if (!upstream?.text) throw new Error("Filter needs an incoming news item");
          const words = String(step.config.keywords ?? "").split(/[،,\n]/).map((word) => word.trim().toLocaleLowerCase()).filter(Boolean);
          const text = `${upstream.title ?? ""} ${upstream.text}`.toLocaleLowerCase();
          const matches = words.some((word) => text.includes(word));
          if ((step.config.mode === "exclude" ? !matches : matches) === false) {
            await db.update(runSteps).set({ status: "skipped", output: { matched: false }, finishedAt: new Date() }).where(eq(runSteps.id, record.id));
            states.set(step.id, "skipped");
            continue;
          }
          output = upstream;
        } else if (step.type === "ai") {
          if (!upstream?.text) throw new Error("AI step needs text from a connected step");
          const [workflow] = await db.select({ workspaceId: workflows.workspaceId }).from(workflows)
            .where(eq(workflows.id, run.workflowId)).limit(1);
          const profileId = step.config.profileId;
          const [settings] = workflow ? typeof profileId === "string" && profileId !== "default" ?
            await db.select().from(aiProfiles).where(and(eq(aiProfiles.id, profileId),
              eq(aiProfiles.workspaceId, workflow.workspaceId))).limit(1) :
            await db.select().from(aiSettings).where(eq(aiSettings.workspaceId, workflow.workspaceId)).limit(1) : [];
          if (!settings) throw new Error("Selected AI profile is not available");
          const connection = { provider: settings.provider as AIConnection["provider"],
            model: settings.model, token: decryptSecret(settings.encryptedToken) };
          const instructions = typeof step.config.instructions === "string" ? step.config.instructions : undefined;
          const text = await generateNewsDraft(connection,
            { title: upstream.title || "خبر", text: upstream.text, url: upstream.url ?? undefined }, instructions);
          const titleMode = step.config.titleMode ?? "keep";
          const title = titleMode === "rewrite" ? await generateNewsTitle(connection,
            { title: upstream.title || "خبر", text: upstream.text },
            typeof step.config.titleInstructions === "string" ? step.config.titleInstructions : undefined) :
            titleMode === "custom" ? String(step.config.customTitle).trim() : upstream.title;
          const imageMode = step.config.imageMode ?? "keep";
          const imageUrl = imageMode === "remove" ? null : imageMode === "custom" ?
            String(step.config.customImageUrl).trim() : upstream.imageUrl;
          output = { ...upstream, text, title, imageUrl };
        } else if (step.type === "publish" || step.type === "draft") {
          if (!upstream?.text) throw new Error(`${step.type} needs text from a connected step`);
          output = step.type === "publish" ? { ...upstream, queuedForPublication: true } : upstream;
        } else throw new Error(`Step type ${step.type} is not implemented`);
        outputs[step.key] = output;
        states.set(step.id, "completed");
        await db.update(runSteps).set({ status: "completed", output, finishedAt: new Date() }).where(eq(runSteps.id, record.id));
        await db.insert(runEvents).values({ runId: run.id, runStepId: record.id, type: "step_completed", message: step.name, payload: output });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown step error";
        failed = true;
        states.set(step.id, "failed");
        await db.update(runSteps).set({ status: "failed", error: { message }, finishedAt: new Date() }).where(eq(runSteps.id, record.id));
        await db.insert(runEvents).values({ runId: run.id, runStepId: record.id, type: "step_failed", message });
      }
    }
    const completed = ordered.some((step) => ["publish", "draft"].includes(step.type) && states.get(step.id) === "completed");
    const status = waiting ? "waiting_approval" : failed && !completed ? "failed" : "completed";
    await db.update(runs).set({ status, output: outputs, finishedAt: waiting ? null : new Date() }).where(eq(runs.id, run.id));
    await db.insert(runEvents).values({ runId: run.id, type: status === "failed" ? "run_failed" : status === "completed" ? "run_completed" : "approval_requested",
      message: status, payload: { outputs } });
    return { runId: run.id, status, outputs };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown run error";
    await db.update(runs).set({ status: "failed", output: { error: { message } }, finishedAt: new Date() }).where(eq(runs.id, run.id));
    await db.insert(runEvents).values({ runId: run.id, type: "run_failed", message, payload: { message } });
    throw error;
  }
}
