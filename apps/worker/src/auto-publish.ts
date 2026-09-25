import { and, eq } from "drizzle-orm";
import { Queue } from "bullmq";
import { contentItems, contentVariants, getDb, publications, runs, socialAccounts, workflowSteps, workflows } from "@socialyar/db";
import { connection } from "./queue";

const publicationQueue = new Queue("publication-jobs", { connection });

function sourceLink(value: string): string {
  try {
    const url = new URL(value);
    if (url.hostname === "tasnimnews.ir" || url.hostname === "www.tasnimnews.ir") {
      const match = url.pathname.match(/^(\/fa\/news\/\d{4}\/\d{2}\/\d{2}\/\d+)(?:\/.*)?$/);
      if (match) return `${url.origin}${match[1]}`;
    }
  } catch { /* Preserve the original value when it is not a URL. */ }
  return value;
}

export async function enqueueAutoPublication(runId: string) {
  const db = getDb();
  const [row] = await db.select({ run: runs, workspaceId: workflows.workspaceId })
    .from(runs).innerJoin(workflows, eq(runs.workflowId, workflows.id))
    .where(eq(runs.id, runId)).limit(1);
  if (!row || row.run.status !== "completed") return;
  const [publishStep] = await db.select().from(workflowSteps)
    .where(and(eq(workflowSteps.workflowVersionId, row.run.workflowVersionId), eq(workflowSteps.type, "publish"))).limit(1);
  if (!publishStep) return;
  const accountId = publishStep.config.accountId;
  if (typeof accountId !== "string") throw new Error("Publish step needs an Eitaa account");
  const [account] = await db.select().from(socialAccounts)
    .where(and(eq(socialAccounts.id, accountId), eq(socialAccounts.workspaceId, row.workspaceId),
      eq(socialAccounts.channel, "eitaa"), eq(socialAccounts.isActive, true))).limit(1);
  if (!account) throw new Error("Eitaa account is no longer active");
  const generated = row.run.output?.[publishStep.key] as { text?: string; title?: string; url?: string } | undefined;
  if (!generated?.text) throw new Error("Run has no AI generated content");

  let [content] = await db.select().from(contentItems).where(eq(contentItems.runId, runId)).limit(1);
  if (!content) {
    [content] = await db.insert(contentItems).values({ workspaceId: row.workspaceId, runId,
      title: generated.title ?? "خبر جدید", body: generated.text,
      metadata: { sourceUrl: generated.url ?? null, automated: true }, status: "approved" }).returning();
  }
  let [variant] = await db.select().from(contentVariants).where(and(
    eq(contentVariants.contentItemId, content.id), eq(contentVariants.channel, "eitaa"))).limit(1);
  if (!variant) {
    [variant] = await db.insert(contentVariants).values({ contentItemId: content.id, channel: "eitaa",
      title: content.title, body: generated.url ? `${generated.text}\n\nمنبع: ${sourceLink(generated.url)}` : generated.text,
      status: "approved", generatedBy: "ai" }).returning();
  }
  let [publication] = await db.select().from(publications)
    .where(eq(publications.contentVariantId, variant.id)).limit(1);
  if (!publication) {
    [publication] = await db.insert(publications).values({ workspaceId: row.workspaceId,
      contentVariantId: variant.id, socialAccountId: account.id, status: "queued" }).returning();
  }
  if (publication.status === "published" || publication.status === "publishing") return;
  await publicationQueue.add("publish-content", { publicationId: publication.id }, {
    jobId: `publication-${publication.id}`, attempts: 1, removeOnComplete: 1000,
  });
}

export async function closeAutoPublisher() { await publicationQueue.close(); }
