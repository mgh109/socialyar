import type { FastifyInstance } from "fastify";
import { and, desc, eq, gt } from "drizzle-orm";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { getDb, socialAccounts, youtubeItems, youtubeOAuthStates, youtubeConfig, googleJson,
  encryptSecret, decryptSecret, youtubeToken, workflows, storeYoutubeMedia, readYoutubeMedia, fetchYoutubeMedia, validateConnectionPolicy, secretConfigurationProblem } from "@socialyar/db";
import { publicationQueue } from "../queue";
import { policySchema } from "./proxies";

const metadata = z.object({ title: z.string().trim().min(1).max(100), description: z.string().max(5000),
  privacy: z.enum(["public", "unlisted", "private"]), tags: z.array(z.string().max(100)).max(50),
  madeForKids: z.boolean(), videoType: z.enum(["video", "shorts"]).default("video"), playlist: z.string().max(150).default(""), scheduledAt: z.string().datetime().nullable().optional(), connection: policySchema.optional() });
export async function youtubeRoutes(app: FastifyInstance) {
  const db = getDb();
  app.get("/youtube/oauth/callback", async (request, reply) => {
    const query = z.object({ state: z.string(), code: z.string().optional(), error: z.string().optional() }).parse(request.query);
    const [state] = await db.delete(youtubeOAuthStates).where(and(eq(youtubeOAuthStates.id, query.state),
      gt(youtubeOAuthStates.expiresAt, new Date()))).returning();
    if (!state) return reply.code(400).send({ error: "oauth_state_expired" });
    if (query.error || !query.code) return reply.code(400).send({ error: "google_authorization_denied" });
    const config = youtubeConfig();
    const tokens = await googleJson(await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret,
        redirect_uri: config.redirectUri, code: query.code, code_verifier: decryptSecret(state.verifierEnc), grant_type: "authorization_code" }),
      signal: AbortSignal.timeout(15000),
    }));
    const channels = await googleJson(await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
      headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(15000),
    }));
    const channel = channels.items?.[0];
    if (!channel) return reply.code(400).send({ error: "google_account_has_no_youtube_channel" });
    const [existing] = await db.select().from(socialAccounts).where(and(eq(socialAccounts.workspaceId, state.workspaceId),
      eq(socialAccounts.channel, "youtube"), eq(socialAccounts.externalAccountId, channel.id)));
    const refreshTokenEnc = tokens.refresh_token ? encryptSecret(tokens.refresh_token) : existing?.credentials.refreshTokenEnc;
    if (!refreshTokenEnc) return reply.code(400).send({ error: "google_refresh_token_missing_reconnect" });
    const credentials = { refreshTokenEnc, accessTokenEnc: encryptSecret(tokens.access_token), expiresAt: Date.now() + tokens.expires_in * 1000 };
    await db.insert(socialAccounts).values({ workspaceId: state.workspaceId, channel: "youtube", externalAccountId: channel.id,
      displayName: channel.snippet.title, credentials }).onConflictDoUpdate({
      target: [socialAccounts.workspaceId, socialAccounts.channel, socialAccounts.externalAccountId],
      set: { credentials, displayName: channel.snippet.title, isActive: true, updatedAt: new Date() },
    });
    return reply.redirect(`${process.env.YOUTUBE_WEB_ORIGIN ?? "http://localhost:3000"}/connections?youtube=connected`);
  });
  app.register(async (secured) => {
    secured.addHook("onRequest", secured.authenticate);
    secured.get("/youtube/config", async () => ({ configured: Boolean(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET && process.env.YOUTUBE_REDIRECT_URI),
      privateOnly: process.env.YOUTUBE_PROJECT_VERIFIED !== "true", maxUploadBytes: 250_000_000 }));
    secured.post("/youtube/health", async () => {
      const checks = await Promise.all([
        ["google", "https://oauth2.googleapis.com/token"],
        ["youtube", "https://www.googleapis.com/youtube/v3/channels?part=id"],
        ["upload", "https://www.googleapis.com/upload/youtube/v3/videos"],
      ].map(async ([service, url]) => {
        try {
          const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15000) });
          // 400/401/403/405 without credentials confirms HTTPS reachability, not account authorization.
          return { service, reachable: response.status < 500, status: response.status };
        } catch (error) { return { service, reachable: false, error: error instanceof Error ? error.message : "Network failure" }; }
      }));
      return { ok: checks.every((check) => check.reachable), checks };
    });
    secured.post("/youtube/connect", async (request, reply) => {
      if (!process.env.YOUTUBE_CLIENT_ID || !process.env.YOUTUBE_CLIENT_SECRET || !process.env.YOUTUBE_REDIRECT_URI)
        return reply.code(503).send({ error: "تنظیمات OAuth یوتیوب در سرور کامل نیست؛ YOUTUBE_CLIENT_ID، YOUTUBE_CLIENT_SECRET و YOUTUBE_REDIRECT_URI را تنظیم کنید." });
      if (secretConfigurationProblem()) return reply.code(503).send({ error: "کلید رمزگذاری HOOR_SECRET_KEY در سرور تنظیم نشده یا معتبر نیست." });
      const config = youtubeConfig(); const state = randomBytes(32).toString("base64url"); const verifier = randomBytes(48).toString("base64url");
      await db.insert(youtubeOAuthStates).values({ id: state, workspaceId: request.auth.workspaceId,
        verifierEnc: encryptSecret(verifier), expiresAt: new Date(Date.now() + 600000) });
      const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: "code",
        access_type: "offline", prompt: "consent", state, scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.force-ssl",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
      return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` };
    });
    secured.post("/youtube/accounts/:id/disconnect", async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const [account] = await db.select().from(socialAccounts).where(and(eq(socialAccounts.id, id), eq(socialAccounts.workspaceId, request.auth.workspaceId), eq(socialAccounts.channel, "youtube")));
      if (!account) return reply.code(404).send({ error: "channel_not_found" });
      if (account.credentials.refreshTokenEnc) {
        const response = await fetch("https://oauth2.googleapis.com/revoke", { method: "POST",
          body: new URLSearchParams({ token: decryptSecret(String(account.credentials.refreshTokenEnc)) }), signal: AbortSignal.timeout(15000) });
        if (!response.ok && response.status !== 400) return reply.code(502).send({ error: "google_revocation_failed" });
      }
      await db.update(socialAccounts).set({ credentials: {}, isActive: false, updatedAt: new Date() }).where(eq(socialAccounts.id, id));
      await db.update(youtubeItems).set({ status: "cancelled", updatedAt: new Date() }).where(and(eq(youtubeItems.accountId, id), eq(youtubeItems.status, "queued")));
      return { ok: true };
    });
    secured.post("/youtube/accounts/:id/test", async (request) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { token } = await youtubeToken(id, request.auth.workspaceId);
      const channels = await googleJson(await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) }));
      return { ok: true, google: true, youtube: true, channel: channels.items?.[0]?.snippet?.title };
    });
    secured.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: 250_000_000 }, (_request, body, done) => done(null, body));
    secured.post("/youtube/media", { bodyLimit: 250_000_000 }, async (request, reply) => {
      return storeYoutubeMedia(request.auth.workspaceId, request.body as Buffer);
    });
    secured.get("/youtube/media/:id", async (request, reply) => {
      const { id } = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).parse(request.params);
      const { bytes, type } = await readYoutubeMedia(request.auth.workspaceId, id);
      return reply.type(type).header("Cache-Control", "private, no-store").send(bytes);
    });
    secured.get("/youtube/items", async (request) => {
      const query = z.object({ workflowId: z.string().uuid().optional() }).parse(request.query);
      const rows = await db.select().from(youtubeItems).where(and(eq(youtubeItems.workspaceId, request.auth.workspaceId),
        query.workflowId ? eq(youtubeItems.workflowId, query.workflowId) : undefined)).orderBy(desc(youtubeItems.createdAt)).limit(1000);
      return rows.map(({ sessionEnc, ...row }) => row);
    });
    secured.post("/youtube/items", async (request, reply) => {
      const input = metadata.extend({ workflowId: z.string().uuid(), stepKey: z.string(), accountId: z.string().uuid(),
        videoMediaId: z.string().regex(/^[a-f0-9]{64}$/).optional(), coverMediaId: z.string().regex(/^[a-f0-9]{64}$/).optional() }).parse(request.body);
      const [workflow] = await db.select().from(workflows).where(and(eq(workflows.id, input.workflowId), eq(workflows.workspaceId, request.auth.workspaceId)));
      const [account] = await db.select().from(socialAccounts).where(and(eq(socialAccounts.id, input.accountId), eq(socialAccounts.workspaceId, request.auth.workspaceId), eq(socialAccounts.channel, "youtube"), eq(socialAccounts.isActive, true)));
      if (!workflow || !account) return reply.code(404).send({ error: "workflow_or_channel_not_found" });
      await validateConnectionPolicy(request.auth.workspaceId, input.connection);
      if (input.videoMediaId) await readYoutubeMedia(request.auth.workspaceId, input.videoMediaId, "video");
      if (input.coverMediaId) await readYoutubeMedia(request.auth.workspaceId, input.coverMediaId, "image");
      const [item] = await db.insert(youtubeItems).values({ workspaceId: request.auth.workspaceId, workflowId: workflow.id, stepKey: input.stepKey,
        itemKey: input.videoMediaId ?? randomUUID(), accountId: account.id, channelName: account.displayName ?? account.externalAccountId,
        title: input.title, description: input.description, settings: input,
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null, status: input.videoMediaId ? "waiting_approval" : "waiting_video" }).onConflictDoNothing().returning();
      return reply.code(item ? 201 : 409).send(item ?? { error: "duplicate_video" });
    });
    secured.patch("/youtube/items/:id/media", async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const input = z.object({ videoMediaId: z.string().regex(/^[a-f0-9]{64}$/), coverMediaId: z.string().regex(/^[a-f0-9]{64}$/).optional() }).parse(request.body);
      await readYoutubeMedia(request.auth.workspaceId, input.videoMediaId, "video");
      if (input.coverMediaId) await readYoutubeMedia(request.auth.workspaceId, input.coverMediaId, "image");
      const [current] = await db.select().from(youtubeItems).where(and(eq(youtubeItems.id, id), eq(youtubeItems.workspaceId, request.auth.workspaceId), eq(youtubeItems.status, "waiting_video")));
      if (!current) return reply.code(409).send({ error: "item_not_waiting_video" });
      const [duplicate] = await db.select().from(youtubeItems).where(and(eq(youtubeItems.workflowId, current.workflowId), eq(youtubeItems.stepKey, current.stepKey), eq(youtubeItems.itemKey, input.videoMediaId)));
      if (duplicate) return reply.code(409).send({ error: "duplicate_video" });
      const [item] = await db.update(youtubeItems).set({ settings: { ...current.settings, ...input }, itemKey: input.videoMediaId,
        status: "waiting_approval", updatedAt: new Date() }).where(and(eq(youtubeItems.id, id), eq(youtubeItems.status, "waiting_video"))).returning();
      return item ? { ok: true } : reply.code(409).send({ error: "item_state_conflict" });
    });
    secured.post("/youtube/items/:id/resolve", async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const input = z.object({ action: z.enum(["approve", "reject"]), title: z.string().trim().min(1).max(100).optional(), description: z.string().max(5000).optional() }).parse(request.body);
      const [current] = await db.select().from(youtubeItems).where(and(eq(youtubeItems.id, id), eq(youtubeItems.workspaceId, request.auth.workspaceId)));
      if (!current) return reply.code(404).send({ error: "item_not_found" });
      if (current.status !== "waiting_approval") return reply.code(409).send({ error: "item_not_waiting_approval" });
      if (input.action === "approve") {
        if (current.scheduledAt && current.scheduledAt.getTime() <= Date.now()) return reply.code(409).send({ error: "زمان انتشار گذشته؛ نیازمند تعیین تکلیف. زمان جدید تعیین کنید." });
        await readYoutubeMedia(request.auth.workspaceId, String(current.settings.videoMediaId), "video");
        if (current.settings.coverMediaId) await readYoutubeMedia(request.auth.workspaceId, String(current.settings.coverMediaId), "image");
      }
      const [item] = await db.update(youtubeItems).set({ status: input.action === "approve" ? "queued" : "rejected",
        logs: [...current.logs, { channel: current.channelName, time: new Date().toISOString(), result: input.action === "approve" ? "approved_and_queued" : "rejected", userId: request.auth.userId }],
        ...(input.action === "approve" ? { approvedBy: request.auth.userId, approvedAt: new Date() } : {}),
        ...(input.title ? { title: input.title } : {}), ...(input.description !== undefined ? { description: input.description } : {}), updatedAt: new Date() })
        .where(and(eq(youtubeItems.id, id), eq(youtubeItems.workspaceId, request.auth.workspaceId), eq(youtubeItems.status, "waiting_approval"))).returning();
      if (!item) return reply.code(409).send({ error: "item_not_waiting_approval" });
      if (input.action === "approve") {
        try { await enqueue(item); } catch { await db.update(youtubeItems).set({ status: "failed", error: "Publication queue unavailable" }).where(eq(youtubeItems.id, id)); return reply.code(503).send({ error: "queue_unavailable_retry" }); }
      }
      return { ok: true };
    });
    secured.post("/youtube/items/:id/:action", async (request, reply) => {
      const { id, action } = z.object({ id: z.string().uuid(), action: z.enum(["cancel", "retry"]) }).parse(request.params);
      const [current] = await db.select().from(youtubeItems).where(and(eq(youtubeItems.id, id), eq(youtubeItems.workspaceId, request.auth.workspaceId)));
      if (action === "retry" && current?.status === "failed" && current.settings.collectionId && !current.approvedAt) {
        await publicationQueue.add("youtube-prepare", { youtubeItemId: id, queueVersion: current.queueVersion },
          { jobId: `youtube-prepare-retry-${id}-${Date.now()}`, attempts: 1, removeOnComplete: 100, removeOnFail: 100 });
        return { ok: true, approvalRequired: true };
      }
      if (action === "retry" && current?.status === "failed" && !current.approvedAt && typeof current.settings.sourceVideoUrl === "string") {
        const video = await fetchYoutubeMedia(current.settings.sourceVideoUrl, 250_000_000, "video");
        const { mediaId: videoMediaId } = await storeYoutubeMedia(request.auth.workspaceId, video.bytes);
        let coverMediaId: string | undefined;
        if (typeof current.settings.sourceCoverUrl === "string" && current.settings.sourceCoverUrl) {
          const cover = await fetchYoutubeMedia(current.settings.sourceCoverUrl, 2_000_000, "image");
          coverMediaId = (await storeYoutubeMedia(request.auth.workspaceId, cover.bytes)).mediaId;
        }
        const [duplicate] = await db.select().from(youtubeItems).where(and(eq(youtubeItems.workflowId, current.workflowId), eq(youtubeItems.stepKey, current.stepKey), eq(youtubeItems.itemKey, videoMediaId)));
        if (duplicate) return reply.code(409).send({ error: "duplicate_video" });
        await db.update(youtubeItems).set({ status: "waiting_approval", error: null, itemKey: videoMediaId,
          settings: { ...current.settings, videoMediaId, coverMediaId }, updatedAt: new Date() })
          .where(and(eq(youtubeItems.id, id), eq(youtubeItems.status, "failed")));
        return { ok: true, approvalRequired: true };
      }
      if (action === "retry" && !current?.approvedAt) return reply.code(409).send({ error: "approval_required" });
      const [item] = await db.update(youtubeItems).set({ status: action === "cancel" ? "cancelled" : "queued", error: null, updatedAt: new Date(),
        logs: [...(current?.logs ?? []), { channel: current?.channelName, time: new Date().toISOString(), result: action === "cancel" ? "cancelled" : "retry_queued" }] })
        .where(and(eq(youtubeItems.id, id), eq(youtubeItems.workspaceId, request.auth.workspaceId),
          eq(youtubeItems.status, action === "cancel" ? "queued" : "failed"))).returning();
      if (!item) return reply.code(409).send({ error: "item_state_conflict" });
      if (action === "retry") {
        if (!item.approvedAt) return reply.code(409).send({ error: "approval_required" });
        try { await enqueue(item); } catch { await db.update(youtubeItems).set({ status: "failed", error: "Publication queue unavailable" }).where(eq(youtubeItems.id, id)); return reply.code(503).send({ error: "queue_unavailable" }); }
      }
      return { ok: true };
    });
  });
}
async function enqueue(item: typeof youtubeItems.$inferSelect) {
  const jobId = `youtube-${item.id}`; const old = await publicationQueue.getJob(jobId);
  if (old) { const state = await old.getState(); if (state === "active") throw new Error("Job is active"); await old.remove(); }
  await publicationQueue.add("youtube-publish", { youtubeItemId: item.id, queueVersion: item.queueVersion }, { jobId,
    delay: Math.max(0, (item.scheduledAt?.getTime() ?? Date.now()) - Date.now()), attempts: 1, removeOnComplete: 1000, removeOnFail: 1000 });
}
