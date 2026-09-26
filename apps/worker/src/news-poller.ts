import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { and, eq, inArray } from "drizzle-orm";
import { Queue } from "bullmq";
import { XMLParser } from "fast-xml-parser";
import { getDb, newsItems, runEvents, runs, workflowSteps, workflowVersions, workflows } from "@socialyar/db";
import { connection } from "./queue";
import { channelHandle, fetchEitaaPosts } from "./eitaa-source";
import { baleHandle, fetchBalePosts } from "./bale-source";

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

function imageFromEntry(item: Record<string, any>): string | null {
  const candidates = [item["media:content"], item["media:thumbnail"], item.enclosure, item.image];
  for (const candidate of candidates) {
    const entry = Array.isArray(candidate) ? candidate[0] : candidate;
    const mediaType = entry?.["@_type"] ?? entry?.type;
    if (typeof mediaType === "string" && !mediaType.startsWith("image/")) continue;
    const value = stringValue(entry?.["@_url"] ?? entry?.url ?? entry);
    try {
      if (new URL(value).protocol === "https:") return value;
    } catch { /* No usable image in this field. */ }
  }
  return null;
}

function publicFeedUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
    (isIP(url.hostname.replace(/[\[\]]/g, "")) !== 0) || /^(localhost|.*\.local|.*\.internal)$/i.test(url.hostname)) {
    throw new Error("RSS source must be a public HTTPS URL");
  }
  return url;
}

async function queueItem(workflowId: string, versionId: string, title: string, summary: string,
  link: string, imageUrl: string | null, legacyId?: string, uniqueId?: string, sourceKey?: string): Promise<boolean> {
  const db = getDb();
  const itemKey = createHash("sha256").update(uniqueId ?? link).digest("hex");
  const legacyKey = createHash("sha256").update(legacyId || link).digest("hex");
  if (legacyKey !== itemKey) {
    const [seen] = await db.select({ id: newsItems.id }).from(newsItems)
      .where(and(eq(newsItems.workflowId, workflowId), inArray(newsItems.itemKey, [itemKey, legacyKey]))).limit(1);
    if (seen) return false;
  }
  const [claimed] = await db.insert(newsItems).values({ workflowId, itemKey }).onConflictDoNothing().returning();
  if (!claimed) return false;
  const [run] = await db.insert(runs).values({ workflowId, workflowVersionId: versionId,
    trigger: "rss", input: { title, text: summary || title, url: link, imageUrl, sourceKey }, status: "queued" }).returning();
  await db.update(newsItems).set({ runId: run.id }).where(eq(newsItems.id, claimed.id));
  await db.insert(runEvents).values({ runId: run.id, type: "run_started", message: "Source item queued" });
  try {
    await queue.add("execute-workflow", { runId: run.id, workflowId,
      workflowVersionId: versionId }, { jobId: run.id, attempts: 2, removeOnComplete: 1000 });
  } catch (error) {
    await db.update(runs).set({ status: "failed", output: { error: { message: "Queue unavailable" } },
      finishedAt: new Date() }).where(eq(runs.id, run.id));
    await db.delete(newsItems).where(eq(newsItems.id, claimed.id));
    throw error;
  }
  return true;
}

type NewsCandidate = { title: string; text: string; url: string; imageUrl: string | null; legacyId?: string; uniqueId?: string };

async function sourceCandidates(source: typeof workflowSteps.$inferSelect): Promise<NewsCandidate[]> {
  const kind = source.config.sourceKind;
  const urls = kind === "rss" ? [source.config.feedUrl] :
    Array.isArray(source.config.feedUrls) ? source.config.feedUrls : [source.config.feedUrl];
  const eitaa = kind === "eitaa" ? [source.config.channel] :
    Array.isArray(source.config.eitaaChannels) ? source.config.eitaaChannels : [];
  const bale = kind === "bale" ? [source.config.channel] :
    Array.isArray(source.config.baleChannels) ? source.config.baleChannels : [];
  const candidates: NewsCandidate[] = [];
  for (const feedUrl of urls.slice(0, 10)) {
    if (typeof feedUrl !== "string" || !feedUrl.trim()) continue;
    try {
      const response = await fetch(publicFeedUrl(feedUrl), { signal: AbortSignal.timeout(15000), redirect: "error" });
      if (!response.ok) throw new Error(`RSS returned ${response.status}`);
      const feed = parser.parse((await response.text()).slice(0, 2_000_000)) as Record<string, any>;
      const entries = feed.rss?.channel?.item ?? feed.feed?.entry ?? [];
      const items = Array.isArray(entries) ? entries.slice(0, 10) : [entries];
      for (const item of items.reverse()) {
        const title = stringValue(item?.title).trim(), url = stringValue(item?.link).trim();
        if (!title || !url) continue;
        candidates.push({ title, url, text: stringValue(item?.description ?? item?.summary ?? item?.["content:encoded"])
          .replace(/<[^>]+>/g, " ").trim(), imageUrl: imageFromEntry(item), legacyId: stringValue(item.guid ?? item.id) });
      }
    } catch (error) { console.error(`RSS poll failed for ${feedUrl}`, error); }
  }
  for (const input of eitaa.slice(0, 10)) {
    if (typeof input !== "string") continue;
    try {
      const posts = await fetchEitaaPosts(channelHandle(input));
      candidates.push(...posts.map((post) => ({ ...post })));
    } catch (error) { console.error(`Eitaa poll failed for ${input}`, error); }
  }
  for (const input of bale.slice(0, 10)) {
    if (typeof input !== "string") continue;
    try {
      const handle = baleHandle(input), posts = await fetchBalePosts(handle);
      candidates.push(...posts.map((post) => ({ ...post, uniqueId: `bale:${handle}:${post.id}` })));
    } catch (error) { console.error(`Bale poll failed for ${input}`, error); }
  }
  return candidates;
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
        const sources = await db.select().from(workflowSteps)
          .where(and(eq(workflowSteps.workflowVersionId, version.id), eq(workflowSteps.type, "rss_source")));
        if (!sources.length) continue;
        const configured = Number(version.snapshot.pollIntervalMinutes ?? 5);
        const intervalMinutes = [1, 2, 5, 10, 15].includes(configured) ? configured : 5;
        const reserved = await connection.set(`news-poll:${workflow.id}:${version.id}`, String(Date.now()), "EX", intervalMinutes * 60, "NX");
        if (reserved !== "OK") continue;
        const rotation = Math.floor(Date.now() / (intervalMinutes * 60_000)) % sources.length;
        const ordered = [...sources.slice(rotation), ...sources.slice(0, rotation)];
        const batches = await Promise.all(ordered.map(async (source) => ({ source, items: await sourceCandidates(source) })));
        let queuedCount = 0;
        // Round robin keeps one busy source from starving the others.
        for (let index = 0; index < 10 && queuedCount < 15; index++) {
          for (const batch of batches) {
            const item = batch.items[index];
            if (!item || queuedCount >= 15) continue;
            try {
              if (await queueItem(workflow.id, version.id, item.title, item.text, item.url,
                item.imageUrl, item.legacyId, item.uniqueId, batch.source.key)) queuedCount++;
            } catch (error) { console.error(`Queue failed for ${workflow.id}`, error); }
          }
        }
      } catch (error) { console.error(`News poll failed for workflow ${workflow.id}`, error); }
    }
  } finally { polling = false; }
}

export function startNewsPoller() {
  void poll().catch(console.error);
  const timer = setInterval(() => void poll().catch(console.error), 60_000);
  return async () => { clearInterval(timer); await queue.close(); };
}
