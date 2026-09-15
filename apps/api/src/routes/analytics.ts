import { and, desc, eq, gte, lte } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  analyticsEvents,
  contentItems,
  contentVariants,
  getDb,
  publications,
} from "@socialyar/db";

const rangeQuery = z.object({
  workspaceId: z.string().uuid(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

function rangeCondition(
  workspaceId: string,
  from?: string,
  to?: string,
) {
  const conditions = [eq(publications.workspaceId, workspaceId)];

  if (from) {
    conditions.push(gte(publications.createdAt, new Date(from)));
  }

  if (to) {
    conditions.push(lte(publications.createdAt, new Date(to)));
  }

  return and(...conditions);
}

export async function analyticsRoutes(app: FastifyInstance) {
  const db = getDb();

  app.get("/analytics/summary", async (request) => {
    const query = rangeQuery.parse(request.query);

    const publicationRows = await db
      .select({
        publication: publications,
        variant: contentVariants,
      })
      .from(publications)
      .innerJoin(
        contentVariants,
        eq(publications.contentVariantId, contentVariants.id),
      )
      .where(rangeCondition(query.workspaceId, query.from, query.to))
      .orderBy(desc(publications.createdAt));

    const eventRows = await db
      .select()
      .from(analyticsEvents)
      .where(eq(analyticsEvents.workspaceId, query.workspaceId));

    const total = publicationRows.length;
    const published = publicationRows.filter(
      (row) => row.publication.status === "published",
    ).length;
    const failed = publicationRows.filter(
      (row) => row.publication.status === "failed",
    ).length;
    const queued = publicationRows.filter(
      (row) =>
        row.publication.status === "queued" ||
        row.publication.status === "publishing",
    ).length;

    const byChannel = Object.values(
      publicationRows.reduce<
        Record<
          string,
          {
            channel: string;
            total: number;
            published: number;
            failed: number;
            attempts: number;
          }
        >
      >((acc, row) => {
        const key = row.variant.channel;
        acc[key] ??= {
          channel: key,
          total: 0,
          published: 0,
          failed: 0,
          attempts: 0,
        };

        acc[key].total += 1;
        acc[key].attempts += row.publication.attempt ?? 0;

        if (row.publication.status === "published") {
          acc[key].published += 1;
        }

        if (row.publication.status === "failed") {
          acc[key].failed += 1;
        }

        return acc;
      }, {}),
    ).map((item) => ({
      ...item,
      successRate:
        item.total > 0 ? Math.round((item.published / item.total) * 100) : 0,
    }));

    const eventTotals = Object.values(
      eventRows.reduce<Record<string, { type: string; value: number }>>(
        (acc, event) => {
          acc[event.type] ??= { type: event.type, value: 0 };
          acc[event.type].value += event.value;
          return acc;
        },
        {},
      ),
    );

    return {
      totals: {
        total,
        published,
        failed,
        queued,
        successRate:
          total > 0 ? Math.round((published / total) * 100) : 0,
        totalAttempts: publicationRows.reduce(
          (sum, row) => sum + (row.publication.attempt ?? 0),
          0,
        ),
      },
      byChannel,
      events: eventTotals,
    };
  });

  app.get("/publications", async (request) => {
    const query = rangeQuery
      .extend({
        status: z
          .enum(["queued", "publishing", "published", "failed", "cancelled"])
          .optional(),
      })
      .parse(request.query);

    const rows = await db
      .select({
        publication: publications,
        variant: contentVariants,
        content: contentItems,
      })
      .from(publications)
      .innerJoin(
        contentVariants,
        eq(publications.contentVariantId, contentVariants.id),
      )
      .innerJoin(
        contentItems,
        eq(contentVariants.contentItemId, contentItems.id),
      )
      .where(rangeCondition(query.workspaceId, query.from, query.to))
      .orderBy(desc(publications.createdAt));

    return query.status
      ? rows.filter((row) => row.publication.status === query.status)
      : rows;
  });

  app.post("/analytics/events", async (request, reply) => {
    const input = z
      .object({
        workspaceId: z.string().uuid(),
        publicationId: z.string().uuid().nullable().optional(),
        channel: z.enum([
          "instagram",
          "telegram",
          "website",
          "x",
          "linkedin",
        ]),
        type: z.string().min(1),
        value: z.number().int().default(1),
        dimensions: z.record(z.unknown()).default({}),
        recordedAt: z.string().datetime().optional(),
      })
      .parse(request.body);

    const [event] = await db
      .insert(analyticsEvents)
      .values({
        workspaceId: input.workspaceId,
        publicationId: input.publicationId ?? null,
        channel: input.channel,
        type: input.type,
        value: input.value,
        dimensions: input.dimensions,
        recordedAt: input.recordedAt
          ? new Date(input.recordedAt)
          : new Date(),
      })
      .returning();

    return reply.code(201).send(event);
  });
}
