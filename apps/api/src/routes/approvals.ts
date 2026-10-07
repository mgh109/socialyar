import { and, asc, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  approvals,
  contentItems,
  contentVariants,
  getDb,
  publications,
  schedules,
  socialAccounts,
} from "@socialyar/db";
import { mutateCalendarItem } from "./calendar";

const resolveApprovalSchema = z.object({
  action: z.enum(["approve", "reject", "changes_requested"]),
  note: z.string().nullable().optional(),
});

const scheduleSchema = z.object({
  scheduledAt: z.string().datetime(),
  timezone: z.string().min(1).default("UTC"),
  socialAccountId: z.string().uuid(),
  smartSchedule: z.boolean().default(false),
});

export async function approvalRoutes(app: FastifyInstance) {
  const db = getDb();
  app.addHook("onRequest", app.authenticate);

  app.get("/approvals", async (request) => {
    const query = z
      .object({
        workspaceId: z.string().uuid().optional(),
        status: z
          .enum(["pending", "approved", "rejected", "changes_requested"])
          .optional(),
      })
      .parse(request.query);

    const rows = await db
      .select({
        approval: approvals,
        variant: contentVariants,
        content: contentItems,
      })
      .from(approvals)
      .innerJoin(
        contentVariants,
        eq(approvals.contentVariantId, contentVariants.id),
      )
      .innerJoin(
        contentItems,
        eq(contentVariants.contentItemId, contentItems.id),
      )
      .where(
        query.status
          ? and(
              eq(approvals.workspaceId, request.auth.workspaceId),
              eq(approvals.status, query.status),
            )
          : eq(approvals.workspaceId, request.auth.workspaceId),
      )
      .orderBy(desc(approvals.createdAt));

    return rows;
  });

  app.post("/approvals/:approvalId/resolve", async (request, reply) => {
    const { approvalId } = z
      .object({ approvalId: z.string().uuid() })
      .parse(request.params);
    const input = resolveApprovalSchema.parse(request.body);

    const [current] = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, approvalId), eq(approvals.workspaceId, request.auth.workspaceId)))
      .limit(1);

    if (!current) {
      return reply.code(404).send({ error: "approval_not_found" });
    }

    if (current.status !== "pending") return reply.code(409).send({ error: "approval_already_resolved" });
    if (input.action === "approve" || input.action === "reject") {
      const [variant] = await db.select().from(contentVariants).where(eq(contentVariants.id, current.contentVariantId));
      if (!variant) return reply.code(404).send({ error: "variant_not_found" });
      const result = await mutateCalendarItem(db, request.auth, { kind: "variant", id: variant.id }, { action: input.action, version: variant.calendarVersion });
      if (result.status !== 200) return reply.code(result.status).send(result.body);
      const [resolved] = await db.select().from(approvals).where(eq(approvals.id, current.id));
      const [updated] = await db.select().from(contentVariants).where(eq(contentVariants.id, variant.id));
      return { approval: resolved, variant: updated };
    }

    const nextApprovalStatus = "changes_requested" as const;
    const nextContentStatus = "draft" as const;

    const result = await db.transaction(async (tx) => {
      const [approval] = await tx
        .update(approvals)
        .set({
          status: nextApprovalStatus,
          resolvedBy: request.auth.userId,
          resolutionNote: input.note ?? null,
          resolvedAt: new Date(),
        })
        .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")))
        .returning();
      if (!approval) return null;

      const [variant] = await tx
        .update(contentVariants)
        .set({
          status: nextContentStatus,
          updatedAt: new Date(),
        })
        .where(eq(contentVariants.id, current.contentVariantId))
        .returning();

      return { approval, variant };
    });
    if (!result) return reply.code(409).send({ error: "approval_already_resolved" });

    return result;
  });

  app.post("/content-variants/:variantId/schedules", async (request, reply) => {
    const { variantId } = z
      .object({ variantId: z.string().uuid() })
      .parse(request.params);
    const input = scheduleSchema.parse(request.body);

    const [variant] = await db
      .select()
      .from(contentVariants)
      .where(eq(contentVariants.id, variantId))
      .limit(1);

    if (!variant) {
      return reply.code(404).send({ error: "variant_not_found" });
    }

    if (variant.status !== "approved") {
      return reply.code(409).send({ error: "variant_not_approved" });
    }

    const [content] = await db
      .select()
      .from(contentItems)
      .where(eq(contentItems.id, variant.contentItemId))
      .limit(1);

    if (!content || content.workspaceId !== request.auth.workspaceId) {
      return reply.code(404).send({ error: "content_not_found" });
    }

    if (input.socialAccountId) {
      const [account] = await db.select().from(socialAccounts)
        .where(and(eq(socialAccounts.id, input.socialAccountId), eq(socialAccounts.workspaceId, request.auth.workspaceId), eq(socialAccounts.channel, variant.channel), eq(socialAccounts.isActive, true))).limit(1);
      if (!account) return reply.code(400).send({ error: "channel_account_not_found" });
    }

    const scheduledAt = new Date(input.scheduledAt);
    if (scheduledAt.getTime() <= Date.now()) return reply.code(400).send({ error: "schedule_must_be_in_future" });

    const result = await mutateCalendarItem(db, request.auth, { kind: "variant", id: variant.id }, {
      action: "schedule", version: variant.calendarVersion, scheduledAt: input.scheduledAt, timezone: input.timezone, accountId: input.socialAccountId,
    });
    if (result.status !== 200) return reply.code(result.status).send(result.body);
    const [publication] = await db.select().from(publications).where(eq(publications.contentVariantId, variant.id)).orderBy(desc(publications.createdAt)).limit(1);
    const [schedule] = publication?.scheduleId ? await db.select().from(schedules).where(eq(schedules.id, publication.scheduleId)) : [];
    return reply.code(201).send({ schedule, publication });
  });

  app.get("/calendar", async (request) => {
    const query = z
      .object({ workspaceId: z.string().uuid() })
      .parse(request.query);

    return db
      .select({
        schedule: schedules,
        variant: contentVariants,
        content: contentItems,
        publication: publications,
      })
      .from(schedules)
      .innerJoin(
        contentVariants,
        eq(schedules.contentVariantId, contentVariants.id),
      )
      .innerJoin(
        contentItems,
        eq(contentVariants.contentItemId, contentItems.id),
      )
      .leftJoin(publications, eq(publications.scheduleId, schedules.id))
      .where(eq(schedules.workspaceId, request.auth.workspaceId))
      .orderBy(asc(schedules.scheduledAt));
  });

  app.post("/schedules/:scheduleId/publish-now", async (request, reply) => {
    const { scheduleId } = z
      .object({ scheduleId: z.string().uuid() })
      .parse(request.params);

    const [schedule] = await db
      .select()
      .from(schedules)
      .where(and(eq(schedules.id, scheduleId), eq(schedules.workspaceId, request.auth.workspaceId)))
      .limit(1);

    if (!schedule) {
      return reply.code(404).send({ error: "schedule_not_found" });
    }

    if (schedule.status === "completed" || schedule.status === "cancelled") return reply.code(409).send({ error: "schedule_not_publishable" });

    let [publication] = await db
      .select()
      .from(publications)
      .where(eq(publications.scheduleId, schedule.id))
      .orderBy(desc(publications.createdAt))
      .limit(1);

    if (!publication) {
      [publication] = await db
        .insert(publications)
        .values({
          workspaceId: schedule.workspaceId,
          contentVariantId: schedule.contentVariantId,
          scheduleId: schedule.id,
          socialAccountId: schedule.socialAccountId,
          status: "queued",
        })
        .returning();
    }
    if (publication.status === "published" || publication.status === "publishing") {
      return reply.code(409).send({ error: "publication_already_in_progress_or_published" });
    }
    if (publication.externalId || publication.error?.deliveryUnknown === true) {
      return reply.code(409).send({ error: "delivery_already_confirmed_or_unknown_check_destination_before_retry" });
    }

    const [variant] = await db.select().from(contentVariants).where(eq(contentVariants.id, schedule.contentVariantId));
    if (!variant) return reply.code(404).send({ error: "variant_not_found" });
    const result = await mutateCalendarItem(db, request.auth, { kind: "variant", id: variant.id }, {
      action: publication.status === "failed" ? "retry" : "schedule", version: variant.calendarVersion,
      publicationId: publication.id, scheduledAt: new Date(Date.now() + 1000).toISOString(),
      accountId: schedule.socialAccountId ?? publication.socialAccountId, timezone: schedule.timezone,
    });
    return reply.code(result.status === 200 ? 202 : result.status).send(result.body);
  });
}
