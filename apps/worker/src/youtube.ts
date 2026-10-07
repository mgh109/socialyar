import { and, eq } from "drizzle-orm";
import { setTimeout as pause } from "node:timers/promises";
import { getDb, youtubeItems, youtubeToken, fetchYoutubeMedia, googleJson, encryptSecret, decryptSecret, readYoutubeMedia, uploadYoutubeVideo, publishingTransport, publicationConnectionEvents } from "@socialyar/db";

export async function executeYoutube(id: string, db = getDb(), queueVersion = 0) {
  let [item] = await db.select().from(youtubeItems).where(eq(youtubeItems.id, id));
  if (!item || !item.approvedAt || !["queued", "uploading", "processing"].includes(item.status)) return;
  if (item.queueVersion !== queueVersion) return;
  const [claimed] = await db.update(youtubeItems).set({ status: item.videoId ? "processing" : "uploading", error: null, updatedAt: new Date() })
    .where(and(eq(youtubeItems.id, id), eq(youtubeItems.status, item.status), eq(youtubeItems.queueVersion, queueVersion))).returning();
  if (!claimed) return;
  item = claimed;
  const log = async (result: string, extra: Record<string, unknown> = {}) => {
    const entry = { channel: item.channelName, time: new Date().toISOString(), result, ...extra };
    item.logs = [...item.logs, entry];
    await db.update(youtubeItems).set({ logs: item.logs, updatedAt: new Date() }).where(eq(youtubeItems.id, id));
  };
  let transport: Awaited<ReturnType<typeof publishingTransport>> | undefined;
  try {
    transport = await publishingTransport(item.workspaceId, item.settings.connection, "youtube", async (event) => {
      await db.insert(publicationConnectionEvents).values({ workspaceId: item.workspaceId, youtubeItemId: item.id, ...event });
      await log("connection", event);
    });
    const request = transport.fetch;
    const { token, privateOnly } = await youtubeToken(item.accountId, item.workspaceId, request);
    const headers = { Authorization: `Bearer ${token}` };
    const media = async (kind: "video" | "image") => {
      const mediaId = item.settings[kind === "video" ? "videoMediaId" : "coverMediaId"];
      if (typeof mediaId === "string") return readYoutubeMedia(item.workspaceId, mediaId, kind);
      const url = item.settings[kind === "video" ? "videoUrl" : "coverUrl"];
      if (typeof url !== "string") throw new Error("Video is missing");
      return fetchYoutubeMedia(url, kind === "video" ? 250_000_000 : 2_000_000, kind);
    };
    if (!item.videoId) {
      const video = await media("video");
      await log("upload_started", { privateOnly, requestedPrivacy: item.settings.privacy });
      item.videoId = await uploadYoutubeVideo({ bytes: video.bytes, type: video.type, token,
        session: item.sessionEnc ? decryptSecret(item.sessionEnc) : undefined,
        metadata: { snippet: { title: item.title, description: item.description, tags: item.settings.tags ?? [], categoryId: "22" },
          status: { privacyStatus: privateOnly ? "private" : item.settings.privacy ?? "private", selfDeclaredMadeForKids: item.settings.madeForKids === true } },
        saveSession: async (session) => { await db.update(youtubeItems).set({ sessionEnc: encryptSecret(session) }).where(eq(youtubeItems.id, id)); },
        saveProgress: async (progress, videoId) => { await db.update(youtubeItems).set({ progress, ...(videoId ? { videoId } : {}), updatedAt: new Date() }).where(eq(youtubeItems.id, id)); },
      }, request);
      await db.update(youtubeItems).set({ status: "processing", progress: 100, videoId: item.videoId, updatedAt: new Date() }).where(eq(youtubeItems.id, id));
    }
    if (item.settings.coverMediaId || item.settings.coverUrl) {
      const cover = await media("image");
      await googleJson(await request(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(item.videoId!)}&uploadType=media`, {
        method: "POST", headers: { ...headers, "Content-Type": cover.type }, body: new Uint8Array(cover.bytes), signal: AbortSignal.timeout(30000) }));
    }
    for (let poll = 0; poll < 60; poll++) {
      const data = await googleJson(await request(`https://www.googleapis.com/youtube/v3/videos?part=status,processingDetails&id=${encodeURIComponent(item.videoId!)}`, {
        headers, signal: AbortSignal.timeout(15000) }));
      const result = data.items?.[0]; if (!result) throw new Error("Uploaded video is not visible to the connected channel");
      const status = result.status; const processing = result.processingDetails?.processingStatus;
      await db.update(youtubeItems).set({ actualPrivacy: status.privacyStatus, updatedAt: new Date() }).where(eq(youtubeItems.id, id));
      if (["failed", "terminated"].includes(processing) || ["failed", "rejected", "deleted"].includes(status.uploadStatus))
        throw new Error(`YouTube processing failed: ${status.rejectionReason ?? status.failureReason ?? result.processingDetails?.processingFailureReason ?? processing}`);
      if (status.uploadStatus === "processed" && processing !== "processing") {
        await db.update(youtubeItems).set({ status: "published", actualPrivacy: status.privacyStatus, error: null, updatedAt: new Date() }).where(eq(youtubeItems.id, id));
        await log("published", { videoUrl: `https://www.youtube.com/watch?v=${item.videoId}`, actualPrivacy: status.privacyStatus,
          privateOnly, privacyRestricted: status.privacyStatus !== item.settings.privacy }); return;
      }
      await pause(10000);
    }
    throw new Error("YouTube is still processing; retry to check this same video without reuploading");
  } catch (error) {
    const message = error instanceof Error ? error.message : "YouTube publication failed";
    await db.update(youtubeItems).set({ status: "failed", error: message, updatedAt: new Date() }).where(eq(youtubeItems.id, id));
    await log("failed", { error: message, videoUrl: item.videoId ? `https://www.youtube.com/watch?v=${item.videoId}` : null });
    throw error;
  } finally { await transport?.close(); }
}
