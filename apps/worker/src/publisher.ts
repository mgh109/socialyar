import { and, eq } from "drizzle-orm";
import { publishToChannel } from "@socialyar/channels";
import {
  contentVariants,
  getDb,
  decryptSecret,
  publications,
  schedules,
  socialAccounts,
} from "@socialyar/db";

export async function executePublication(input: {
  publicationId: string;
  attempt: number;
  maxAttempts: number;
}) {
  const db = getDb();

  const [publication] = await db
    .select()
    .from(publications)
    .where(eq(publications.id, input.publicationId))
    .limit(1);

  if (!publication) {
    throw new Error("Publication not found");
  }
  if (publication.status === "published" || publication.status === "cancelled") return;

  const [variant] = await db
    .select()
    .from(contentVariants)
    .where(eq(contentVariants.id, publication.contentVariantId))
    .limit(1);

  if (!variant) {
    throw new Error("Content variant not found");
  }

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

  await db
    .update(publications)
    .set({
      status: "publishing",
      attempt: publication.attempt + 1,
      error: null,
      socialAccountId: account?.id ?? null,
      updatedAt: new Date(),
    })
    .where(eq(publications.id, publication.id));

  try {
    if (!account) throw new Error(`No active social account configured for ${variant.channel}`);
    const result = await publishToChannel({
      publicationId: publication.id,
      channel: variant.channel,
      title: variant.title,
      content: variant.body,
      imageUrl: variant.channel === "eitaa" && typeof variant.settings.imageUrl === "string" ? variant.settings.imageUrl : null,
      credentials: variant.channel === "eitaa" && typeof account.credentials.botTokenEnc === "string"
        ? { ...account.credentials, botToken: decryptSecret(account.credentials.botTokenEnc) }
        : account.credentials,
      externalAccountId: account.externalAccountId,
    });

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
    const details = {
      message:
        error instanceof Error ? error.message : "Unknown publication error",
      attempt: input.attempt,
      maxAttempts: input.maxAttempts,
    };

    const finalAttempt = input.attempt >= input.maxAttempts;

    await db
      .update(publications)
      .set({
        status: finalAttempt ? "failed" : "queued",
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
  }
}
