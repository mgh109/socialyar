import { eq } from "drizzle-orm";
import { publishToChannel } from "@socialyar/channels";
import {
  contentVariants,
  getDb,
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
          .where(eq(socialAccounts.id, publication.socialAccountId))
          .limit(1)
      )[0]
    : null;

  if (!account) {
    throw new Error(
      `No social account configured for ${variant.channel}`,
    );
  }

  await db
    .update(publications)
    .set({
      status: "publishing",
      attempt: input.attempt,
      error: null,
      updatedAt: new Date(),
    })
    .where(eq(publications.id, publication.id));

  try {
    const result = await publishToChannel({
      channel: variant.channel,
      title: variant.title,
      content: variant.body,
      credentials: account.credentials,
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
