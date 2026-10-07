import { and, eq } from "drizzle-orm";
import { publishToChannel } from "@socialyar/channels";
import { setTimeout as pause } from "node:timers/promises";
import { reservePublicationSlot } from "./queue";
import {
  contentItems,
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
} from "@socialyar/db";

export async function executePublication(input: {
  publicationId: string;
  attempt: number;
  maxAttempts: number;
  queueVersion?: number;
}, db = getDb()) {

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
  if (publication.externalId) return; // A confirmed remote send must never be replayed after a local write failure.

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
      attempt: publication.attempt + 1,
      error: null,
      socialAccountId: account?.id ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(publications.id, publication.id), eq(publications.status, "queued"), eq(publications.queueVersion, input.queueVersion ?? 0))).returning();
  if (!claimed) return;

  let transport: Awaited<ReturnType<typeof publishingTransport>> | undefined;
  let confirmed: Awaited<ReturnType<typeof publishToChannel>> | undefined;
  try {
    if (!account) throw new Error(`No active social account configured for ${variant.channel}`);
    if (variant.channel === "telegram" || variant.channel === "instagram") {
      transport = await publishingTransport(publication.workspaceId, variant.settings.connection, variant.channel, async (event) => {
        await db.insert(publicationConnectionEvents).values({ workspaceId: publication.workspaceId, publicationId: publication.id, ...event });
      });
    }
    const result = await publishToChannel({
      fetch: transport?.fetch,
      publicationId: publication.id,
      channel: variant.channel,
      title: variant.title,
      content: variant.body,
      imageUrl: variant.channel === "eitaa" && typeof variant.settings.imageUrl === "string" ? variant.settings.imageUrl : null,
      videoUrl: variant.channel === "eitaa" && typeof variant.settings.videoUrl === "string" ? variant.settings.videoUrl : null,
      credentials: variant.channel === "eitaa" && typeof account.credentials.botTokenEnc === "string"
        ? { ...account.credentials, botToken: decryptSecret(account.credentials.botTokenEnc) }
        : account.credentials,
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
    const unknown = error instanceof AmbiguousDeliveryError || (error as { code?: string })?.code === "DELIVERY_UNKNOWN" ||
      Boolean(transport && isConnectionError(error) && !definitelyNotSent(error));
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
      ...transport.getRoute(), result: unknown ? "delivery_unknown" : "failed", error: details.message });

    await db
      .update(publications)
      .set({
        status: finalAttempt ? "failed" : "queued",
        ...(confirmed ? { externalId: confirmed.externalId, externalUrl: confirmed.externalUrl ?? null, publishedAt: new Date(confirmed.publishedAt) } : {}),
        error: details,
        updatedAt: new Date(),
      })
      .where(eq(publications.id, publication.id));

    if (finalAttempt) {
      await db
        .update(contentVariants)
        .set({
          status: "failed",
          updatedAt: new Date(),
        })
        .where(eq(contentVariants.id, variant.id));

      if (publication.scheduleId) {
        await db
          .update(schedules)
          .set({
            status: "failed",
            updatedAt: new Date(),
          })
          .where(eq(schedules.id, publication.scheduleId));
      }
    }

    throw error;
  } finally { await transport?.close(); }
}
