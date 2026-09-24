import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { and, eq } from "drizzle-orm";
import { Queue } from "bullmq";
import { XMLParser } from "fast-xml-parser";
import { getDb, newsItems, runEvents, runs, workflowSteps, workflowVersions, workflows } from "@socialyar/db";
import { connection } from "./queue";

const queue = new Queue("workflow-runs", { connection });
const parser = new XMLParser({ ignoreAttributes: false, processEntities: true });
let polling = false;

function stringValue(value: unknown): string {
  if (Array.isArray(value)) return stringValue(value[0]);
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return stringValue(object["#text"] ?? object["@_href"] ?? "");
  }
  return "";
}

function publicFeedUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
    (isIP(url.hostname.replace(/[\[\]]/g, "")) !== 0) || /^(localhost|.*\.local|.*\.internal)$/i.test(url.hostname)) {
    throw new Error("RSS source must be a public HTTPS URL");
  }
  return url;
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const db = getDb();
    const active = await db.select().from(workflows)
      .where(and(eq(workflows.status, "active"), eq(workflows.autonomyMode, "full_auto")));
    for (const workflow of active) {
      try {
        const [version] = await db.select().from(workflowVersions)
          .where(and(eq(workflowVersions.workflowId, workflow.id), eq(workflowVersions.version, workflow.currentVersion))).limit(1);
        if (!version) continue;
        const [source] = await db.select().from(workflowSteps)
          .where(and(eq(workflowSteps.workflowVersionId, version.id), eq(workflowSteps.type, "rss_source"))).limit(1);
        if (!source || typeof source.config.feedUrl !== "string") continue;
        const url = publicFeedUrl(source.config.feedUrl);
        const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: "error" });
        if (!response.ok) throw new Error(`RSS returned ${response.status}`);
        const xml = (await response.text()).slice(0, 2_000_000);
        const feed = parser.parse(xml) as Record<string, any>;
        const entries = feed.rss?.channel?.item ?? feed.feed?.entry ?? [];
        const items = Array.isArray(entries) ? entries.slice(0, 3) : [entries];
        for (const item of items.reverse()) {
          const title = stringValue(item?.title).trim();
          const link = stringValue(item?.link).trim();
          const summary = stringValue(item?.description ?? item?.summary ?? item?.["content:encoded"]).replace(/<[^>]+>/g, " ").trim();
          if (!title || !link) continue;
          const itemKey = createHash("sha256").update(stringValue(item.guid ?? item.id) || link).digest("hex");
          const [claimed] = await db.insert(newsItems).values({ workflowId: workflow.id, itemKey })
            .onConflictDoNothing().returning();
          if (!claimed) continue;
          const [run] = await db.insert(runs).values({ workflowId: workflow.id, workflowVersionId: version.id,
            trigger: "rss", input: { title, text: summary || title, url: link }, status: "queued" }).returning();
          await db.update(newsItems).set({ runId: run.id }).where(eq(newsItems.id, claimed.id));
          await db.insert(runEvents).values({ runId: run.id, type: "run_started", message: "RSS item queued" });
          try {
            await queue.add("execute-workflow", { runId: run.id, workflowId: workflow.id,
              workflowVersionId: version.id }, { jobId: run.id, attempts: 2, removeOnComplete: 1000 });
          } catch (error) {
            await db.update(runs).set({ status: "failed", output: { error: { message: "Queue unavailable" } },
              finishedAt: new Date() }).where(eq(runs.id, run.id));
            await db.delete(newsItems).where(eq(newsItems.id, claimed.id));
            throw error;
          }
        }
      } catch (error) {
        console.error(`RSS poll failed for workflow ${workflow.id}`, error);
      }
    }
  } finally { polling = false; }
}

export function startNewsPoller() {
  void poll().catch(console.error);
  const timer = setInterval(() => void poll().catch(console.error), 5 * 60_000);
  return async () => { clearInterval(timer); await queue.close(); };
}
