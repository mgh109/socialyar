import { and, eq } from "drizzle-orm";
import { publishToChannel } from "@socialyar/channels";
import { setTimeout as pause } from "node:timers/promises";
import { reservePublicationSlot } from "./queue";
import {
  ExecutionOwnershipError, withExecutionLock, contentItems,
  contentVariants,
  getDb,
  decryptSecret,
  publications,
  runs,
  schedules,
  socialAccounts,
  publishingTransport,
  publicationConnectionEvents,
  AmbiguousDeliveryError,
  isConnectionError,
  connectionErrorReason,
  definitelyNotSent,
  fetchCollectionMedia,
} from "@socialyar/db";

export async function executePublication(input: {
  publicationId: string;
  attempt: number;
  maxAttempts: number;
  queueVersion?: number;
}, db = getDb(), lock = withExecutionLock) {
  return lock(`publication:${input.publicationId}`, (assertOwned) => executeClaimedPublication(input, db, assertOwned));
}

async function executeClaimedPublication(input: { publicationId: string; attempt: number; maxAttempts: number; queueVersion?: number }, db = getDb(), assertOwned: () => Promise<void> = async () => {}) {

  const [publication] = await db
    .select()
    .from(publications)
    .where(eq(publications.id, input.publicationId))
    .limit(1);

  if (!publication) {
    throw new Error("Publication not found");
  }
  if (publication.status === "published" || publication.status === "cancelled") return;
  if (publication.queueVersion !== (input.queueVersion ?? 0)) return;
  if (publication.externalId) {
    await db.transaction(async (tx) => {
      await tx.update(publications).set({ status: "published", error: null, updatedAt: new Date() }).where(eq(publications.id, publication.id));
      await tx.update(contentVariants).set({ status: "published", updatedAt: new Date() }).where(eq(contentVariants.id, publication.contentVariantId));
      if (publication.scheduleId) await tx.update(schedules).set({ status: "completed", updatedAt: new Date() }).where(eq(schedules.id, publication.scheduleId));
    });
    return;
  } // A confirmed remote send is repaired locally, never replayed.
  if (publication.status === "publishing") {
    // Exclusive ownership proves the former sender is gone. Once sending began,
    // its remote result cannot be inferred from a missing local success record.
    if (publication.sendStartedAt) {
      await db.transaction(async (tx) => {
        await tx.update(publications).set({ status: "failed", error: { message: "ارسال قبلی متوقف شده و نتیجه مقصد نامعلوم است؛ پیش از تلاش مجدد مقصد را بررسی کنید.", deliveryUnknown: true }, updatedAt: new Date() }).where(eq(publications.id, publication.id));
        await tx.update(contentVariants).set({ status: "failed", updatedAt: new Date() }).where(eq(contentVariants.id, publication.contentVariantId));
        if (publication.scheduleId) await tx.update(schedules).set({ status: "failed", updatedAt: new Date() }).where(eq(schedules.id, publication.scheduleId));
      });
      return;
    }
    await db.update(publications).set({ status: "queued", updatedAt: new Date() }).where(eq(publications.id, publication.id));
  }


  const [variant] = await db
    .select()
    .from(contentVariants)
    .where(eq(contentVariants.id, publication.contentVariantId))
    .limit(1);

  if (!variant) {
    throw new Error("Content variant not found");
  }
  if (!["approved", "scheduled"].includes(variant.status)) return;

  const account = publication.socialAccountId
    ? (
        await db
          .select()
          .from(socialAccounts)
          .where(and(eq(socialAccounts.id, publication.socialAccountId), eq(socialAccounts.workspaceId, publication.workspaceId), eq(socialAccounts.channel, variant.channel), eq(socialAccounts.isActive, true)))
          .limit(1)
      )[0]
    : (
        await db
          .select()
          .from(socialAccounts)
          .where(
            and(
              eq(socialAccounts.workspaceId, publication.workspaceId),
              eq(socialAccounts.channel, variant.channel),
              eq(socialAccounts.isActive, true),
            ),
          )
          .limit(1)
      )[0];

  // Auto publications share a channel-wide interval, including across different workflows and workers.
  let interval = variant.settings.publishIntervalSeconds;
  if (interval === undefined && publication.scheduleId === null) {
    // Pace auto publications that entered the queue before this setting was introduced.
    const [source] = await db.select({ trigger: runs.trigger }).from(contentItems)
      .innerJoin(runs, eq(contentItems.runId, runs.id))
      .where(eq(contentItems.id, variant.contentItemId)).limit(1);
    if (source?.trigger === "rss") interval = 30;
  }
  if (account && variant.settings.pacedInQueue !== true && typeof interval === "number" &&
    Number.isInteger(interval) && interval >= 30 && interval <= 300) {
    const waitMs = await reservePublicationSlot(account.id, interval);
    if (waitMs) await pause(waitMs);
  }

  const [claimed] = await db
    .update(publications)
    .set({
      status: "publishing",
      sendStartedAt: null,
      attempt: publication.attempt + 1,
      error: null,
      socialAccountId: account?.id ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(publications.id, publication.id), eq(publications.status, "queued"), eq(publications.queueVersion, input.queueVersion ?? 0))).returning();
  if (!claimed) return;

  let transport: Awaited<ReturnType<typeof publishingTransport>> | undefined;
  let sendAttempted=false;
  let confirmed: Awaited<ReturnType<typeof publishToChannel>> | undefined;
  try {
    if (!account) throw new Error(`No active social account configured for ${variant.channel}`);
    if (variant.channel === "telegram" || variant.channel === "instagram") {
      transport = await publishingTransport(publication.workspaceId, variant.settings.connection, variant.channel, async (event) => {
        await db.insert(publicationConnectionEvents).values({ workspaceId: publication.workspaceId, publicationId: publication.id, ...event });
      });
    }
    let media:Blob|undefined;
    const mediaUrl=variant.settings.videoUrl || variant.settings.imageUrl;
    if(variant.settings.collectionId && variant.channel!=="instagram" && ["eitaa","bale","telegram"].includes(variant.channel) && typeof mediaUrl==="string"){
      const file=await fetchCollectionMedia(publication.workspaceId,mediaUrl,variant.settings.videoUrl?"video":"image",variant.settings.mediaConnection);
      if(file.bytes.length>(variant.channel==="eitaa" ? variant.settings.videoUrl?20_000_000:5_000_000 : 50_000_000))throw new Error("حجم فایل برای مقصد بیش از حد مجاز است.");
      media=new Blob([new Uint8Array(file.bytes)],{type:file.type});
    }
    let providerState = { ...variant.settings };
    await assertOwned();
    await db.update(publications).set({ sendStartedAt: new Date() }).where(eq(publications.id, publication.id));
    await assertOwned();
    sendAttempted=true;
    const result = await publishToChannel({
      media,providerState:variant.settings,
      saveProviderState:async(state)=>{providerState={...providerState,...state};await db.update(contentVariants).set({settings:providerState}).where(eq(contentVariants.id,variant.id));},
      fetch: transport?.fetch,
      publicationId: publication.id,
      channel: variant.channel,
      title: variant.title,
      content: variant.body,
      imageUrl: typeof variant.settings.imageUrl === "string" ? variant.settings.imageUrl : null,
      videoUrl: typeof variant.settings.videoUrl === "string" ? variant.settings.videoUrl : null,
      instagramType: typeof variant.settings.instagramType === "string" ? variant.settings.instagramType : undefined,
      instagramImages: Array.isArray(variant.settings.instagramImages) ? variant.settings.instagramImages as string[] : undefined,
      credentials: typeof account.credentials.botTokenEnc === "string"
        ? { ...account.credentials, botToken: decryptSecret(account.credentials.botTokenEnc) }
        : typeof account.credentials.accessTokenEnc === "string" ? {...account.credentials,accessToken:decryptSecret(account.credentials.accessTokenEnc)} : account.credentials,
      externalAccountId: account.externalAccountId,
    });
    confirmed = result;
    if (transport) await db.insert(publicationConnectionEvents).values({ workspaceId: publication.workspaceId, publicationId: publication.id,
      ...transport.getRoute(), result: "published" });

    await db.transaction(async (tx) => {
      await tx
        .update(publications)
        .set({
          status: "published",
          externalId: result.externalId,
          externalUrl: result.externalUrl ?? null,
          publishedAt: new Date(result.publishedAt),
          error: null,
          updatedAt: new Date(),
        })
        .where(eq(publications.id, publication.id));

      await tx
        .update(contentVariants)
        .set({
          status: "published",
          updatedAt: new Date(),
        })
        .where(eq(contentVariants.id, variant.id));

      if (publication.scheduleId) {
        await tx
          .update(schedules)
          .set({
            status: "completed",
            updatedAt: new Date(),
          })
          .where(eq(schedules.id, publication.scheduleId));
      }
    });

    return result;
  } catch (error) {
    if (error instanceof ExecutionOwnershipError) throw error;
    const unknown = error instanceof AmbiguousDeliveryError || (error as { code?: string })?.code === "DELIVERY_UNKNOWN" ||
      Boolean(sendAttempted && isConnectionError(error) && !definitelyNotSent(error));
    const details = {
      message:
        unknown ? new AmbiguousDeliveryError().message : isConnectionError(error) ? connectionErrorReason(error) : error instanceof Error ? error.message : "Unknown publication error",
      deliveryUnknown: unknown,
      attempt: input.attempt,
      maxAttempts: input.maxAttempts,
    };

    // Telegram has no sendMessage idempotency key or API to confirm a lost response.
    // Hold unknown deliveries for manual destination review instead of blindly retrying.
    const finalAttempt = input.attempt >= input.maxAttempts || unknown || Boolean(confirmed);
    if (transport) await db.insert(publicationConnectionEvents).values({ workspaceId: publication.workspaceId, publicationId: publication.id,
      ...transport.getRoute(), result: unknown ? "delivery_unknown" : "failed", error: details.message }).catch(() => {});

    await db
      .update(publications)
      .set({
        status: confirmed ? "published" : finalAttempt ? "failed" : "queued",
        ...(!unknown && !confirmed ? { sendStartedAt: null } : {}),
        ...(confirmed ? { externalId: confirmed.externalId, externalUrl: confirmed.externalUrl ?? null, publishedAt: new Date(confirmed.publishedAt) } : {}),
        error: confirmed ? null : details,
        updatedAt: new Date(),
      })
      .where(eq(publications.id, publication.id));

    if (finalAttempt) {
      await db
        .update(contentVariants)
        .set({
          status: confirmed ? "published" : "failed",
          updatedAt: new Date(),
        })
        .where(eq(contentVariants.id, variant.id));

      if (publication.scheduleId) {
        await db
          .update(schedules)
          .set({
            status: confirmed ? "completed" : "failed",
            updatedAt: new Date(),
          })
          .where(eq(schedules.id, publication.scheduleId));
      }
    }

    if (confirmed) return confirmed;
    throw error;
  } finally { await transport?.close(); }
}
