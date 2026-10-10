import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { and, eq, inArray } from "drizzle-orm";
import { Queue } from "bullmq";
import { XMLParser } from "fast-xml-parser";
import { assertWorkspaceOperational, apiConnections, decryptSecret, ensureCommentStorage, getDb, newsItems, runEvents, runs, workflowSteps, workflowVersions, workflows } from "@socialyar/db";
import { readApiComments } from "@socialyar/workflow/api-client";
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
  const candidates = [item["media:content"], item["media:thumbnail"], item.enclosure, item.image,
    item["media:group"]?.["media:content"], item["media:group"]?.["media:thumbnail"]];
  for (const candidate of candidates) {
    for (const entry of Array.isArray(candidate) ? candidate : [candidate]) {
      const mediaType = entry?.["@_type"] ?? entry?.type;
      if (typeof mediaType === "string" && !mediaType.startsWith("image/")) continue;
      const value = stringValue(entry?.["@_url"] ?? entry?.url ?? entry);
      try { if (new URL(value).protocol === "https:") return value; }
      catch { /* Try the next media field. */ }
    }
  }
  const html = stringValue(item["content:encoded"] ?? item.description ?? item.summary);
  const embedded = html.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
  if (embedded) try { const url = new URL(embedded.replace(/&amp;/g, "&")); if (url.protocol === "https:") return url.href; }
  catch { /* No usable embedded image. */ }
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
  link: string, imageUrl: string | null, legacyId?: string, uniqueId?: string, sourceKey?: string,
  videoUrl?: string | null, videoUnavailable?: boolean, commentId?: string, context?: string,
  comments?: Array<{ id: string; text: string }>): Promise<boolean> {
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
    trigger: comments ? "api_feedback" : commentId ? "api_comments" : "rss", input: { title, text: summary || title, url: link, imageUrl, videoUrl,
      videoUnavailable: videoUnavailable === true, sourceKey, commentId, context, comments }, status: "queued" }).returning();
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

type NewsCandidate = { title: string; text: string; url: string; imageUrl: string | null;
  videoUrl?: string | null; videoUnavailable?: boolean; legacyId?: string; uniqueId?: string;
  commentId?: string; context?: string; comments?: Array<{ id: string; text: string }> };

type SourceStats = { rawCount: number; matchedCount: number; selectedCount: number; validCount: number;
  pagesFetched?: number; capped?: boolean };
async function sourceCandidates(source: typeof workflowSteps.$inferSelect, workspaceId: string): Promise<{ items: NewsCandidate[]; stats?: SourceStats }> {
  if (source.type === "api_source") {
    await ensureCommentStorage();
    const db = getDb();
    const [connection] = await db.select().from(apiConnections).where(and(eq(apiConnections.id, String(source.config.connectionId)),
      eq(apiConnections.workspaceId, workspaceId))).limit(1);
    if (!connection) throw new Error("اتصال API منبع پیدا نشد");
    const inspected = await readApiComments({ ...connection, token: decryptSecret(connection.encryptedToken) },
      String(source.config.path), {
      itemsPath: String(source.config.itemsPath), idField: String(source.config.idField),
      textField: String(source.config.textField), contextField: String(source.config.contextField || "context"),
      readMode: String(source.config.readMode ?? "single"), postId: String(source.config.postId ?? ""),
      postIdField: String(source.config.postIdField || "postId"), batchLimit: Number(source.config.batchLimit ?? 10),
      readAll: source.config.readAll === true,
    });
    const mode = String(source.config.readMode ?? "single");
    const postId = String(source.config.postId ?? "").trim();
    const limit = source.config.readAll === true ? 5000 : Number(source.config.batchLimit ?? 10);
    const parsed = inspected.comments.map((item): NewsCandidate => ({ title: `کامنت ${item.id}`, text: item.text,
      url: "", imageUrl: null, uniqueId: `api:${connection.id}:${item.id}`, commentId: item.id, context: item.context }));
    const stats = { rawCount: inspected.rawCount, matchedCount: inspected.matchedCount,
      selectedCount: inspected.selectedCount, validCount: inspected.validCount,
      pagesFetched: inspected.pagesFetched, capped: inspected.capped };
    if (mode === "single") return { items: parsed.reverse(), stats };
    if (!parsed.length) return { items: [], stats };
    const allComments = parsed.map((item) => ({ id: item.commentId!, text: item.text.slice(0, 600) }));
    const groupId = mode === "post" ? `post:${postId}` : `recent:${limit}`;
    const context = parsed.find((item) => item.context)?.context ?? "";
    const groups: NewsCandidate[] = [];
    for (let offset = 0; offset < allComments.length; offset += 50) {
      const comments = allComments.slice(offset, offset + 50);
      const fingerprint = createHash("sha256").update(JSON.stringify(comments.map((item) =>
        [item.id, item.text]).sort((a, b) => a[0].localeCompare(b[0])))).digest("hex");
      groups.push({ title: mode === "post" ? `بازخورد نوشتهٔ ${postId} (${offset + 1} تا ${offset + comments.length})` :
        `بازخورد کامنت‌های اخیر (${offset + 1} تا ${offset + comments.length})`,
        text: comments.map((item, index) => `${offset + index + 1}. ${item.text}`).join("\n"), url: "", imageUrl: null,
        uniqueId: `api-feedback:${connection.id}:${source.key}:${groupId}:${fingerprint}`,
        context, comments });
    }
    return { items: source.config.includeIndividual === true ? [...groups, ...parsed.reverse()] : groups, stats };
  }
  const kind = source.config.sourceKind;
  const urls = kind === "rss" ? [source.config.feedUrl] :
    Array.isArray(source.config.feedUrls) ? source.config.feedUrls : [source.config.feedUrl];
  const eitaa = kind === "eitaa" ? [source.config.channel] :
    Array.isArray(source.config.eitaaChannels) ? source.config.eitaaChannels : [];
  const bale = kind === "bale" ? [source.config.channel] :
    Array.isArray(source.config.baleChannels) ? source.config.baleChannels : [];
  const candidates: NewsCandidate[] = [];
  const sourceErrors: Error[] = [];
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
    } catch (error) { console.error(`RSS poll failed for ${feedUrl}`, error);
      sourceErrors.push(error instanceof Error ? error : new Error(String(error))); }
  }
  for (const input of eitaa.slice(0, 10)) {
    if (typeof input !== "string") continue;
    try {
      const posts = await fetchEitaaPosts(channelHandle(input));
      candidates.push(...posts.map((post) => ({ ...post })));
    } catch (error) { console.error(`Eitaa poll failed for ${input}`, error);
      sourceErrors.push(error instanceof Error ? error : new Error(String(error))); }
  }
  for (const input of bale.slice(0, 10)) {
    if (typeof input !== "string") continue;
    try {
      const handle = baleHandle(input), posts = await fetchBalePosts(handle);
      candidates.push(...posts.map((post) => ({ ...post, uniqueId: `bale:${handle}:${post.id}` })));
    } catch (error) { console.error(`Bale poll failed for ${input}`, error);
      sourceErrors.push(error instanceof Error ? error : new Error(String(error))); }
  }
  if (sourceErrors.length && !candidates.length) throw sourceErrors[0];
  return { items: candidates };
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
        await assertWorkspaceOperational(db, workflow.workspaceId);
        const [version] = await db.select().from(workflowVersions)
          .where(and(eq(workflowVersions.workflowId, workflow.id), eq(workflowVersions.version, workflow.currentVersion))).limit(1);
        if (!version) continue;
        const sources = await db.select().from(workflowSteps)
          .where(and(eq(workflowSteps.workflowVersionId, version.id), inArray(workflowSteps.type, ["rss_source", "api_source"])));
        if (!sources.length) continue;
        const configured = Number(version.snapshot.pollIntervalMinutes ?? 5);
        const intervalMinutes = Number.isInteger(configured) && configured >= 1 && configured <= 10080 ? configured : 5;
        const reserved = await connection.set(`news-poll:${workflow.id}:${version.id}`, String(Date.now()), "EX", intervalMinutes * 60, "NX");
        if (reserved !== "OK") continue;
        const rotation = Math.floor(Date.now() / (intervalMinutes * 60_000)) % sources.length;
        const ordered = [...sources.slice(rotation), ...sources.slice(0, rotation)];
        const batches = await Promise.all(ordered.map(async (source) => {
          const liveKey = `source-live:${workflow.id}:${version.id}:${source.key}`;
          await connection.set(liveKey, JSON.stringify({ status: "reading", at: new Date().toISOString() }), "EX", 45);
          try { const result = await sourceCandidates(source, workflow.workspaceId);
            await connection.set(liveKey, JSON.stringify({ status: "read", at: new Date().toISOString(), count: result.items.length }), "EX", 12);
            return { source, ...result, queued: 0, queueError: "", polled: true }; }
          catch (error) {
            console.error(`Source poll failed for ${source.key}`, error);
            await connection.set(liveKey, JSON.stringify({ status: "error", at: new Date().toISOString() }), "EX", 12);
            if (source.type === "api_source") await connection.set(`source-health:${workflow.id}:${version.id}:${source.key}`,
              JSON.stringify({ checkedAt: new Date().toISOString(), status: "error",
                error: error instanceof Error ? error.message : String(error) }), "EX", 604800);
            return { source, items: [] as NewsCandidate[], queued: 0, queueError: "", polled: false };
          }
        }));
        let queuedCount = 0;
        const commentCap = 60;
        // Round robin keeps one busy source from starving the others.
        for (let index = 0; index < 100 && queuedCount < commentCap + 15; index++) {
          for (const batch of batches) {
            const item = batch.items[index];
            if (!item || batch.queued >= (batch.source.type === "api_source" ? commentCap : 15)) continue;
            try {
              if (await queueItem(workflow.id, version.id, item.title, item.text, item.url,
                item.imageUrl, item.legacyId, item.uniqueId, batch.source.key,
                item.videoUrl, item.videoUnavailable, item.commentId, item.context, item.comments)) {
                queuedCount++; batch.queued++;
              }
            } catch (error) {
              console.error(`Queue failed for ${workflow.id}`, error);
              batch.queueError = error instanceof Error ? error.message : String(error);
            }
          }
        }
        for (const batch of batches) {
          if (batch.polled) {
            await connection.set(`source-live:${workflow.id}:${version.id}:${batch.source.key}`,
              JSON.stringify({ status: batch.queueError ? "error" : batch.queued ? "queued" : "no_new",
                at: new Date().toISOString(), count: batch.items.length, queuedCount: batch.queued }), "EX", 20);
          }
          if (batch.source.type !== "api_source" || !("stats" in batch) || !batch.stats) continue;
          await connection.set(`source-health:${workflow.id}:${version.id}:${batch.source.key}`,
            JSON.stringify({ checkedAt: new Date().toISOString(), status: batch.queueError ? "error" : "ok",
              ...batch.stats, queuedCount: batch.queued, ...(batch.queueError ? { error: `خطا در صف: ${batch.queueError}` } : {}) }), "EX", 604800);
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
