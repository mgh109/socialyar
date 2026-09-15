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
} from "@socialyar/db";

const resolveApprovalSchema = z.object({
  action: z.enum(["approve", "reject", "changes_requested"]),
  note: z.string().nullable().optional(),
  resolvedBy: z.string().uuid().nullable().optional(),
});

const scheduleSchema = z.object({
  scheduledAt: z.string().datetime(),
  timezone: z.string().min(1).default("UTC"),
  socialAccountId: z.string().uuid().nullable().optional(),
  smartSchedule: z.boolean().default(false),
});

export async function approvalRoutes(app: FastifyInstance) {
  const db = getDb();

  app.get("/approvals", async (request) => {
    const query = z
      .object({
        workspaceId: z.string().uuid(),
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
              eq(approvals.workspaceId, query.workspaceId),
              eq(approvals.status, query.status),
            )
          : eq(approvals.workspaceId, query.workspaceId),
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
      .where(eq(approvals.id, approvalId))
      .limit(1);

    if (!current) {
      return reply.code(404).send({ error: "approval_not_found" });
    }

    const nextApprovalStatus =
      input.action === "approve"
        ? "approved"
        : input.action === "reject"
          ? "rejected"
          : "changes_requested";

    const nextContentStatus =
      input.action === "approve"
        ? "approved"
        : input.action === "reject"
          ? "rejected"
          : "draft";

    const result = await db.transaction(async (tx) => {
      const [approval] = await tx
        .update(approvals)
        .set({
          status: nextApprovalStatus,
          resolvedBy: input.resolvedBy ?? null,
          resolutionNote: input.note ?? null,
          resolvedAt: new Date(),
        })
        .where(eq(approvals.id, approvalId))
        .returning();

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

    if (!content) {
      return reply.code(404).send({ error: "content_not_found" });
    }

    const [schedule] = await db
      .insert(schedules)
      .values({
        workspaceId: content.workspaceId,
        contentVariantId: variant.id,
        socialAccountId: input.socialAccountId ?? null,
        scheduledAt: new Date(input.scheduledAt),
        timezone: input.timezone,
        smartSchedule: input.smartSchedule,
      })
      .returning();

    await db
      .update(contentVariants)
      .set({
        status: "scheduled",
        updatedAt: new Date(),
      })
      .where(eq(contentVariants.id, variant.id));

    return reply.code(201).send(schedule);
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
      .where(eq(schedules.workspaceId, query.workspaceId))
      .orderBy(asc(schedules.scheduledAt));
  });

  app.post("/schedules/:scheduleId/publish-now", async (request, reply) => {
    const { scheduleId } = z
      .object({ scheduleId: z.string().uuid() })
      .parse(request.params);

    const [schedule] = await db
      .select()
      .from(schedules)
      .where(eq(schedules.id, scheduleId))
      .limit(1);

    if (!schedule) {
      return reply.code(404).send({ error: "schedule_not_found" });
    }

    const [publication] = await db
      .insert(publications)
      .values({
        workspaceId: schedule.workspaceId,
        contentVariantId: schedule.contentVariantId,
        scheduleId: schedule.id,
        socialAccountId: schedule.socialAccountId,
        status: "queued",
      })
      .returning();

    await db
      .update(schedules)
      .set({
        status: "processing",
        updatedAt: new Date(),
      })
      .where(eq(schedules.id, schedule.id));

    return reply.code(202).send(publication);
  });
}
