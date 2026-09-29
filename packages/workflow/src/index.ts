import { and, asc, eq, sql } from "drizzle-orm";
import { analyzeCommentFeedback, decideComment, generateNewsDraft, generateNewsTitle, type AIRequestUsage, type AIConnection } from "@socialyar/ai";
import { apiRequest } from "./api-client";
import {
  aiUsageEvents, ensureAIUsageStorage, aiProfiles, aiSettings, apiConnections, commentActions, decryptSecret, ensureCommentStorage, getDb, runEvents, runs, runSteps, workflowConnections, workflowSteps, workflows,
} from "@socialyar/db";

type ExecuteRunInput = { runId: string; workflowId: string; workflowVersionId: string };
type Step = typeof workflowSteps.$inferSelect;
type Edge = typeof workflowConnections.$inferSelect;
type News = { text?: string; title?: string | null; url?: string | null; imageUrl?: string | null;
  videoUrl?: string | null; queuedForPublication?: boolean; commentId?: string; context?: string;
  decision?: "approve" | "reject" | "reply" | "review"; reply?: string; reason?: string;
  comments?: Array<{ id: string; text: string }>; feedback?: { positive: number; negative: number; neutral: number; total: number; themes: string[] } };

function transientAIError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /\(429\)|\(50[0234]\)|\(52\d\)|timeout|timed out|fetch failed|network/i.test(message);
}

async function retryAI<T>(operation: () => Promise<T>, onRetry: (attempt: number, error: unknown) => Promise<void>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= 3 || !transientAIError(error)) throw error;
      await onRetry(attempt + 1, error);
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }
}

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
      ordered.find((step) => ["manual_input", "rss_source", "api_source", "source"].includes(step.type))?.key;
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
      if (["rss_source", "api_source", "manual_input", "source"].includes(step.type) && step.key !== selectedSource) {
        states.set(step.id, "skipped");
        continue;
      }
      const parents = edges.filter((edge) => edge.targetStepId === step.id);
      const activeParent = parents.find((edge) => {
        if (states.get(edge.sourceStepId) !== "completed") return false;
        const condition = edge.condition as { decision?: string } | null;
        if (!condition?.decision) return true;
        const source = steps.find((item) => item.id === edge.sourceStepId);
        return source && (outputs[source.key] as News | undefined)?.decision === condition.decision;
      });
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
      const accountUsage = async (usage: AIRequestUsage) => {
        await ensureAIUsageStorage();
        const [workflow] = await db.select({ workspaceId: workflows.workspaceId }).from(workflows)
          .where(eq(workflows.id, run.workflowId)).limit(1);
        if (!workflow) throw new Error("Workflow not found for AI usage");
        await db.transaction(async (tx) => {
          await tx.insert(aiUsageEvents).values({ workspaceId: workflow.workspaceId, workflowId: run.workflowId,
            runId: run.id, runStepId: record.id, ...usage });
          await tx.update(runSteps).set({ provider: usage.provider, model: usage.model,
            inputTokens: sql`${runSteps.inputTokens} + ${usage.inputTokens ?? 0}`,
            outputTokens: sql`${runSteps.outputTokens} + ${usage.outputTokens ?? 0}`,
            costMicros: sql`${runSteps.costMicros} + ${usage.costMicros ?? 0}` }).where(eq(runSteps.id, record.id));
          await tx.update(runs).set({
            totalInputTokens: sql`${runs.totalInputTokens} + ${usage.inputTokens ?? 0}`,
            totalOutputTokens: sql`${runs.totalOutputTokens} + ${usage.outputTokens ?? 0}`,
            totalCostMicros: sql`${runs.totalCostMicros} + ${usage.costMicros ?? 0}` }).where(eq(runs.id, run.id));
        });
      };
      try {
        if (step.type === "human_approval" || step.type === "approval") {
          if (!upstream?.text) throw new Error("Approval needs an incoming news item");
          await db.update(runSteps).set({ status: "waiting_approval", output: upstream }).where(eq(runSteps.id, record.id));
          await db.insert(runEvents).values({ runId: run.id, runStepId: record.id, type: "approval_requested", message: step.name });
          states.set(step.id, "waiting_approval"); waiting = true;
          continue;
        }
        let output: News;
        if (["source", "manual_input", "rss_source", "api_source"].includes(step.type)) {
          if (run.input.videoUnavailable === true) {
            throw new Error("این پست ویدیو دارد، اما صفحهٔ عمومی ایتا فایل ویدیو را در اختیار نمی‌گذارد. انتشار بدون ویدیو متوقف شد.");
          }
          const text = run.input.text ?? run.input.prompt;
          if (typeof text !== "string" || !text.trim()) throw new Error("A text input is required");
          output = { text: text.trim(), title: run.input.title as string ?? null,
            url: run.input.url as string ?? null, imageUrl: run.input.imageUrl as string ?? null,
            videoUrl: run.input.videoUrl as string ?? null,
            commentId: run.input.commentId as string | undefined, context: run.input.context as string | undefined,
            comments: Array.isArray(run.input.comments) ? run.input.comments as Array<{ id: string; text: string }> : undefined };
        } else if (step.type === "filter") {
          if (!upstream?.text) throw new Error("Filter needs an incoming news item");
          const words = String(step.config.keywords ?? "").split(/[،,\n]/).map((word) => word.trim().toLocaleLowerCase()).filter(Boolean);
          const text = `${upstream.title ?? ""} ${upstream.text}`.toLocaleLowerCase();
          const matches = words.some((word) => text.includes(word));
          if ((step.config.mode === "exclude" ? !matches : matches) === false) {
            await db.update(runSteps).set({ status: "skipped", output: { matched: false, title: upstream.title ?? null }, finishedAt: new Date() }).where(eq(runSteps.id, record.id));
            states.set(step.id, "skipped");
            continue;
          }
          output = upstream;
        } else if (step.type === "ai") {
          if (!upstream?.text) throw new Error("AI step needs text from a connected step");
          const sourceText = upstream.text;
          const [workflow] = await db.select({ workspaceId: workflows.workspaceId }).from(workflows)
            .where(eq(workflows.id, run.workflowId)).limit(1);
          const profileId = step.config.profileId;
          const [settings] = workflow ? typeof profileId === "string" && profileId !== "default" ?
            await db.select().from(aiProfiles).where(and(eq(aiProfiles.id, profileId),
              eq(aiProfiles.workspaceId, workflow.workspaceId))).limit(1) :
            await db.select().from(aiSettings).where(eq(aiSettings.workspaceId, workflow.workspaceId)).limit(1) : [];
          if (!settings) throw new Error("Selected AI profile is not available");
          const connection = { provider: settings.provider as AIConnection["provider"],
            model: settings.model, token: decryptSecret(settings.encryptedToken), onUsage: accountUsage };
          const instructions = typeof step.config.instructions === "string" ? step.config.instructions : undefined;
          const retry = async (attempt: number, error: unknown) => {
            await db.update(runSteps).set({ status: "retrying", attempt }).where(eq(runSteps.id, record.id));
            await db.insert(runEvents).values({ runId: run.id, runStepId: record.id, type: "retry",
              message: `${step.name}: تلاش ${attempt} از ۳ پس از خطای موقت سرویس هوش مصنوعی`,
              payload: { error: error instanceof Error ? error.message : String(error), attempt } });
          };
          if (step.config.aiMode === "feedback") {
            if (!upstream.comments?.length) throw new Error("برای تحلیل بازخورد، منبع API را روی حالت گروهی یا یک نوشته بگذار");
            const report = await retryAI(() => analyzeCommentFeedback(connection, upstream.comments!, upstream.context ?? "", instructions), retry);
            output = { ...upstream, text: report.text, feedback: { ...report.counts, total: report.total, themes: report.themes } };
          } else {
          if (upstream.comments?.length) throw new Error("برای گروه کامنت‌ها، حالت کارت AI را «تحلیل بازخورد» انتخاب کن");
          const text = await retryAI(() => generateNewsDraft(connection,
            { title: upstream.title || "خبر", text: sourceText, url: upstream.url ?? undefined }, instructions), retry);
          const titleMode = step.config.titleMode ?? "keep";
          const title = titleMode === "rewrite" ? await retryAI(() => generateNewsTitle(connection,
            { title: upstream.title || "خبر", text: sourceText },
            typeof step.config.titleInstructions === "string" ? step.config.titleInstructions : undefined), retry) :
            titleMode === "custom" ? String(step.config.customTitle).trim() : upstream.title;
          const imageMode = step.config.imageMode ?? "keep";
          const imageUrl = imageMode === "remove" ? null : imageMode === "custom" ?
            String(step.config.customImageUrl).trim() : upstream.imageUrl;
          output = { ...upstream, text, title, imageUrl };
          }
        } else if (step.type === "comment_decision") {
          if (!upstream?.commentId || !upstream.text) throw new Error("تصمیم کامنت به ورودی کامنت نیاز دارد");
          const [workflow] = await db.select({ workspaceId: workflows.workspaceId }).from(workflows).where(eq(workflows.id, run.workflowId)).limit(1);
          const profileId = step.config.profileId;
          const [settings] = workflow ? typeof profileId === "string" && profileId !== "default" ?
            await db.select().from(aiProfiles).where(and(eq(aiProfiles.id, profileId), eq(aiProfiles.workspaceId, workflow.workspaceId))).limit(1) :
            await db.select().from(aiSettings).where(eq(aiSettings.workspaceId, workflow.workspaceId)).limit(1) : [];
          if (!settings) throw new Error("مدل AI انتخاب‌شده در دسترس نیست");
          const connection = { provider: settings.provider as AIConnection["provider"], model: settings.model,
            token: decryptSecret(settings.encryptedToken), onUsage: accountUsage };
          const decision = await retryAI(() => decideComment(connection, upstream.text!, upstream.context ?? "",
            String(step.config.rules ?? "")), async (attempt, error) => {
            await db.insert(runEvents).values({ runId: run.id, runStepId: record.id, type: "retry",
              message: `تلاش ${attempt} برای تصمیم کامنت`, payload: { error: String(error) } });
          });
          if (!edges.some((edge) => edge.sourceStepId === step.id &&
            (edge.condition as { decision?: string } | null)?.decision === decision.decision))
            throw new Error(`برای تصمیم ${decision.decision} مسیر خروجی تعریف نشده است`);
          output = { ...upstream, ...decision };
        } else if (step.type === "api_action") {
          if (!upstream?.commentId) throw new Error("شناسهٔ کامنت در ورودی اقدام نیست");
          const action = String(step.config.action);
          if (!["approve", "reject", "reply"].includes(action)) throw new Error("اقدام API معتبر نیست");
          if (action === "reply" && !upstream.reply) throw new Error("متن پاسخ برای کامنت موجود نیست");
          await ensureCommentStorage();
          const [workflow] = await db.select({ workspaceId: workflows.workspaceId }).from(workflows).where(eq(workflows.id, run.workflowId)).limit(1);
          if (!workflow) throw new Error("جریان پیدا نشد");
          const [connection] = await db.select().from(apiConnections).where(and(eq(apiConnections.id, String(step.config.connectionId)),
            eq(apiConnections.workspaceId, workflow.workspaceId))).limit(1);
          if (!connection) throw new Error("اتصال API در دسترس نیست");
          const actionItemId = `${selectedSource ?? ""}:${upstream.commentId}`;
          const [claim] = await db.insert(commentActions).values({ workspaceId: workflow.workspaceId, workflowId: run.workflowId,
            runId: run.id, stepKey: step.key, commentId: actionItemId, status: "pending" }).onConflictDoNothing().returning();
          if (!claim) {
            const [previousAction] = await db.select().from(commentActions).where(and(eq(commentActions.workflowId, run.workflowId),
              eq(commentActions.stepKey, step.key), eq(commentActions.commentId, actionItemId))).limit(1);
            if (previousAction?.status !== "succeeded") throw new Error("وضعیت اقدام قبلی نامشخص است؛ پیش از ارسال دوباره بررسی کن");
          } else {
            try {
              const idField = String(step.config.idField || "commentId");
              const numericId = /^\d+$/.test(upstream.commentId) ? Number(upstream.commentId) : NaN;
              const commentId = Number.isSafeInteger(numericId) ? numericId : upstream.commentId;
              const body: Record<string, unknown> = { [idField]: commentId };
              if (action === "reply") body[String(step.config.replyField || "reply")] = upstream.reply;
              else body[String(step.config.statusField || "status")] = action === "approve" ?
                String(step.config.approveValue || "approved") : String(step.config.rejectValue || "rejected");
              await apiRequest({ ...connection, token: decryptSecret(connection.encryptedToken) }, String(step.config.path),
                step.config.method === "PATCH" ? "PATCH" : "POST", body, claim.id);
              await db.update(commentActions).set({ status: "succeeded", detail: { action }, updatedAt: new Date() })
                .where(eq(commentActions.id, claim.id));
            } catch (error) {
              await db.update(commentActions).set({ status: "uncertain", detail: { error: String(error) }, updatedAt: new Date() })
                .where(eq(commentActions.id, claim.id));
              throw error;
            }
          }
          output = { ...upstream };
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
    const completed = ordered.some((step) => ["publish", "draft", "api_action"].includes(step.type) && states.get(step.id) === "completed");
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
