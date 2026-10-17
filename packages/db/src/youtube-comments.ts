import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./client";
import { socialAccounts, youtubeCommentReplies } from "./schema";
import { youtubeToken } from "./youtube";

const api = "https://www.googleapis.com/youtube/v3";
export type YoutubeComment = { id: string; threadId: string; text: string; videoId: string; authorChannelId: string; url: string };
type YoutubeReplyContext = { videoId?: string; threadId?: string };
export function youtubeDay(now = new Date()) { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" }).format(now); }
export function nextYoutubeDay(now = new Date()) {
  const day = youtubeDay(now);
  return new Date(new Date(`${day}T00:00:00+03:30`).getTime() + 86400000);
}
export class YoutubeDailyLimitError extends Error { constructor() { super("سقف پاسخ روزانه کانال پر شده؛ ادامه در روز بعد انجام می‌شود."); } }
let storage: Promise<void> | undefined;
export async function ensureYoutubeCommentStorage() {
  storage ??= getDb().execute(sql`CREATE TABLE IF NOT EXISTS youtube_comment_replies (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    account_id uuid NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
    workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
    comment_id text NOT NULL, video_id text NOT NULL, reply text NOT NULL, status text NOT NULL,
    external_id text, error text, day text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT youtube_comment_replies_once UNIQUE(account_id, comment_id))`).then(() => undefined);
  try { await storage; } catch (error) { storage = undefined; throw error; }
}
class YoutubeCommentApiError extends Error { constructor(message:string, readonly status:number, readonly reason?:string) { super(message); } }
async function commentJson(response: Response) {
  let data: any;
  try { data = await response.json(); } catch { throw new Error("پاسخ یوتیوب قابل خواندن نیست؛ نتیجه ارسال را بررسی کنید."); }
  if (!response.ok) {
    const reason = data?.error?.errors?.[0]?.reason;
    const messages: Record<string, string> = { commentsDisabled:"کامنت‌های این ویدئو غیرفعال است.", quotaExceeded:"سهمیه API یوتیوب تمام شده؛ تنظیم سهمیه را بررسی کنید.", forbidden:"مجوز خواندن یا پاسخ به کامنت موجود نیست؛ اتصال کانال را دوباره برقرار کنید.", insufficientPermissions:"مجوز پاسخ به کامنت موجود نیست؛ اتصال کانال را دوباره برقرار کنید.", commentNotFound:"کامنت پیدا نشد یا حذف شده است.", commentThreadNotFound:"کامنت پیدا نشد یا حذف شده است.", videoNotFound:"ویدئو پیدا نشد.", channelNotFound:"کانال پیدا نشد.", operationNotSupported:"این کامنت قابل پاسخ نیست." };
    throw new YoutubeCommentApiError(messages[reason] ?? `درخواست یوتیوب ناموفق بود (کد ${response.status})؛ اتصال و مجوزهای کانال را بررسی کنید.`, response.status, reason);
  }
  if (!data || typeof data !== "object") throw new Error("پاسخ یوتیوب معتبر نیست؛ نتیجه ارسال را بررسی کنید.");
  return data;
}
async function get(token: string, resource: string, params: Record<string, string>, request: typeof fetch) {
  return commentJson(await request(`${api}/${resource}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) }));
}
export async function readYoutubeComments(token: string, channelId: string, options: { videoId?: string; limit: number; after?: string }, request: typeof fetch = fetch) {
  if (options.videoId) {
    const video = await get(token, "videos", { part: "snippet", id: options.videoId }, request);
    if (video.items?.[0]?.snippet?.channelId !== channelId) throw new Error("ویدئو متعلق به کانال انتخاب‌شده نیست.");
  }
  const comments: YoutubeComment[] = []; let pageToken = "", pages = 0, rawCount = 0;
  const seen = new Set<string>();
  do {
    const data = await get(token, "commentThreads", { part: "snippet", textFormat: "plainText", order: "time", maxResults: String(Math.min(100, options.limit - rawCount)),
      ...(options.videoId ? { videoId: options.videoId } : { allThreadsRelatedToChannelId: channelId }), ...(pageToken ? { pageToken } : {}) }, request);
    pages++;
    for (const thread of data.items ?? []) {
      rawCount++;
      const top = thread.snippet?.topLevelComment, snippet = top?.snippet, videoId = thread.snippet?.videoId;
      // videoId belongs to the thread; textOriginal is only guaranteed to the comment's author.
      const text = typeof snippet?.textOriginal === "string" && snippet.textOriginal.trim() ? snippet.textOriginal : snippet?.textDisplay;
      if (!thread.id || !top?.id || !videoId || typeof text !== "string" || !text.trim() || thread.snippet?.canReply === false || snippet.authorChannelId?.value === channelId || seen.has(top.id)) continue;
      if (options.after && new Date(snippet.publishedAt).getTime() < new Date(options.after).getTime()) continue;
      seen.add(top.id); comments.push({ id: top.id, threadId: thread.id, text, videoId,
        authorChannelId: snippet.authorChannelId?.value ?? "", url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&lc=${encodeURIComponent(top.id)}` });
    }
    pageToken = data.nextPageToken ?? "";
  } while (pageToken && rawCount < options.limit && pages < 10);
  return { comments, rawCount, pagesFetched: pages, capped: Boolean(pageToken) };
}
async function findYoutubeReplyThread(token: string, commentId: string, context: YoutubeReplyContext, request: typeof fetch) {
  try {
    const data = await get(token, "commentThreads", { part: "snippet", id: context.threadId || commentId, textFormat: "plainText" }, request);
    const thread = data.items?.find((item: any) => item.snippet?.topLevelComment?.id === commentId);
    if (thread) return thread;
  } catch (error) {
    // Some threads do not support lookup by ID. Only a definite lookup miss may fall back to listing.
    if (!(error instanceof YoutubeCommentApiError) || !["commentThreadNotFound", "operationNotSupported"].includes(error.reason ?? "")) throw error;
  }
  // Older queued runs store videoId but not threadId. Recover the actual thread without trusting the saved association.
  if (context.videoId) {
    let pageToken = "", pages = 0;
    do {
      const data = await get(token, "commentThreads", { part: "snippet", videoId: context.videoId, textFormat: "plainText", maxResults: "100", order: "time", ...(pageToken ? { pageToken } : {}) }, request);
      const thread = data.items?.find((item: any) => item.snippet?.topLevelComment?.id === commentId);
      if (thread) return thread;
      pageToken = data.nextPageToken ?? ""; pages++;
    } while (pageToken && pages < 20);
    if (pageToken) throw new Error("تعداد کامنت‌های ویدئو بیش از سقف بررسی است؛ کامنت مقصد را دستی بررسی کنید.");
  }
  throw new Error("کامنت اصلی پیدا نشد یا قابل پاسخ نیست.");
}
export async function inspectYoutubeReply(token: string, channelId: string, commentId: string, context: YoutubeReplyContext = {}, request: typeof fetch = fetch) {
  const thread = await findYoutubeReplyThread(token, commentId, context, request);
  const videoId = thread.snippet?.videoId, snippet = thread.snippet?.topLevelComment?.snippet;
  if (typeof videoId !== "string" || !videoId || !snippet || snippet.parentId) throw new Error("کامنت اصلی پیدا نشد یا قابل پاسخ نیست.");
  if (context.videoId && context.videoId !== videoId) throw new Error("کامنت متعلق به ویدئوی انتخاب‌شده نیست.");
  const video = await get(token, "videos", { part: "snippet", id: videoId }, request);
  if (video.items?.[0]?.snippet?.channelId !== channelId) throw new Error("کامنت متعلق به ویدئوی این کانال نیست.");
  if (snippet.authorChannelId?.value === channelId) return { videoId, existingId: "own-comment" };
  let pageToken = ""; let pages = 0;
  do {
    const data = await get(token, "comments", { part: "snippet", parentId: commentId, maxResults: "100", ...(pageToken ? { pageToken } : {}) }, request);
    const own = data.items?.find((item: any) => item.snippet?.authorChannelId?.value === channelId);
    if (own) return { videoId, existingId: String(own.id) };
    pageToken = data.nextPageToken ?? ""; pages++;
  } while (pageToken && pages < 20);
  if (pageToken) throw new Error("پاسخ‌های این کامنت بیش از سقف بررسی است؛ مقصد را دستی بررسی کنید.");
  if (thread.snippet.canReply === false) throw new Error("امکان پاسخ به این کامنت در یوتیوب غیرفعال است.");
  return { videoId, existingId: null };
}
export async function insertYoutubeReply(token: string, commentId: string, reply: string, request: typeof fetch = fetch) {
  if (!reply.trim() || reply.length > 3000) throw new Error("پاسخ باید بین ۱ تا ۳۰۰۰ نویسه باشد.");
  const response = await request(`${api}/comments?part=snippet`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ snippet: { parentId: commentId, textOriginal: reply } }), signal: AbortSignal.timeout(30000) });
  const data = await commentJson(response);
  if (typeof data.id !== "string") throw new Error("نتیجه ارسال نامعلوم است؛ کامنت مقصد را بررسی کنید.");
  return data.id as string;
}
export async function claimYoutubeReply(db: ReturnType<typeof getDb>, input: { workspaceId: string; accountId: string; workflowId: string; runId: string; commentId: string; videoId: string; reply: string; dailyLimit: number }, now = new Date()) {
  if (!Number.isInteger(input.dailyLimit) || input.dailyLimit < 1 || input.dailyLimit > 100 || !input.reply.trim() || input.reply.length > 3000) throw new Error("سقف روزانه یا متن پاسخ معتبر نیست.");
  return db.transaction(async tx => {
    const [account] = await tx.select().from(socialAccounts).where(and(eq(socialAccounts.id, input.accountId), eq(socialAccounts.workspaceId, input.workspaceId), eq(socialAccounts.channel, "youtube"), eq(socialAccounts.isActive, true))).for("update");
    if (!account) throw new Error("حساب یوتیوب فعال و معتبر نیست.");
    const [prior] = await tx.select().from(youtubeCommentReplies).where(and(eq(youtubeCommentReplies.accountId, input.accountId), eq(youtubeCommentReplies.commentId, input.commentId)));
    if (prior && prior.status !== "failed") return { claim: prior, fresh: false };
    const day = youtubeDay(now);
    const [count] = await tx.select({ value: sql<number>`count(*)::int` }).from(youtubeCommentReplies).where(and(eq(youtubeCommentReplies.accountId, input.accountId), eq(youtubeCommentReplies.day, day), inArray(youtubeCommentReplies.status, ["sending", "succeeded", "uncertain"])));
    if (count.value >= input.dailyLimit) throw new YoutubeDailyLimitError();
    const [claim] = prior ? await tx.update(youtubeCommentReplies).set({ reply:input.reply, runId:input.runId, workflowId:input.workflowId, day, status:"sending", error:null, updatedAt:now }).where(eq(youtubeCommentReplies.id,prior.id)).returning() : await tx.insert(youtubeCommentReplies).values({ ...input, day, status: "sending" }).returning();
    return { claim, fresh: true };
  });
}
export async function sendYoutubeCommentReply(input: { workspaceId: string; accountId: string; workflowId: string; runId: string; commentId: string; reply: string; dailyLimit: number } & YoutubeReplyContext, assertAllowed: () => Promise<void>) {
  await ensureYoutubeCommentStorage();
  const db = getDb();
  const { token, account } = await youtubeToken(input.accountId, input.workspaceId);
  const { videoId, threadId, ...replyInput } = input;
  const inspected = await inspectYoutubeReply(token, account.externalAccountId, input.commentId, { videoId, threadId });
  if (inspected.existingId) return { replyStatus: "already_replied", externalUrl: `https://www.youtube.com/watch?v=${inspected.videoId}&lc=${encodeURIComponent(inspected.existingId === "own-comment" ? input.commentId : inspected.existingId)}` };
  await assertAllowed();
  const { claim, fresh } = await claimYoutubeReply(db, { ...replyInput, videoId: inspected.videoId });
  if (!fresh) {
    if (claim.status !== "succeeded") throw new Error("نتیجه ارسال قبلی نامعلوم است؛ پیش از تلاش دوباره کامنت مقصد را بررسی کنید.");
    return { replyStatus: "succeeded", externalUrl: `https://www.youtube.com/watch?v=${claim.videoId}&lc=${encodeURIComponent(claim.externalId!)}` };
  }
  try { await assertAllowed(); } catch (error) {
    // No request has been sent; releasing this claim is safe.
    await db.delete(youtubeCommentReplies).where(and(eq(youtubeCommentReplies.id,claim.id),eq(youtubeCommentReplies.status,"sending")));
    throw error;
  }
  try {
    const id = await insertYoutubeReply(token, input.commentId, input.reply);
    await db.update(youtubeCommentReplies).set({ status: "succeeded", externalId: id, updatedAt: new Date() }).where(eq(youtubeCommentReplies.id, claim.id));
    return { replyStatus: "succeeded", externalUrl: `https://www.youtube.com/watch?v=${claim.videoId}&lc=${encodeURIComponent(id)}` };
  } catch (error) {
    const definiteRejection = error instanceof YoutubeCommentApiError && error.status >= 400 && error.status < 500 && error.status !== 408;
    await db.update(youtubeCommentReplies).set({ status: definiteRejection ? "failed" : "uncertain", error: definiteRejection ? error.message : "ارسال تأیید نشد؛ مقصد را بررسی کنید.", updatedAt: new Date() }).where(eq(youtubeCommentReplies.id, claim.id));
    throw error;
  }
}
