import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  approvals,
  contentItems,
  contentVariants,
  getDb,
  runs,
  workflows,
} from "@socialyar/db";

const canonicalUpdateSchema = z.object({
  title: z.string().nullable().optional(),
  body: z.string().min(1).optional(),
  status: z
    .enum([
      "draft",
      "generated",
      "waiting_approval",
      "approved",
      "rejected",
      "scheduled",
      "published",
      "failed",
    ])
    .optional(),
});

const variantUpdateSchema = z.object({
  title: z.string().nullable().optional(),
  body: z.string().min(1).optional(),
  hashtags: z.array(z.string()).optional(),
  settings: z.record(z.unknown()).optional(),
  status: z
    .enum([
      "draft",
      "generated",
      "waiting_approval",
      "approved",
      "rejected",
      "scheduled",
      "published",
      "failed",
    ])
    .optional(),
});

function buildVariant(
  channel: "instagram" | "telegram" | "website",
  title: string,
  body: string,
) {
  if (channel === "instagram") {
    return {
      channel,
      format: "post",
      title,
      body: `${title}\n\n${body}\n\nبرای خبرهای بیشتر SocialYar را دنبال کنید.`,
      hashtags: ["#هوش_مصنوعی", "#AI", "#تکنولوژی"],
      settings: {
        tone: "news",
        emoji: "low",
        hashtagCount: 3,
        cta: "auto",
        length: "medium",
        linkPosition: "bio",
      },
    };
  }

  if (channel === "telegram") {
    return {
      channel,
      format: "news",
      title,
      body: `${title}\n\n${body}\n\nمنبع: خروجی Workflow`,
      hashtags: [],
      settings: {
        tone: "news",
        emoji: "off",
        hashtagCount: 0,
        cta: "off",
        length: "long",
        linkPosition: "end",
      },
    };
  }

  return {
    channel,
    format: "article",
    title,
    body,
    hashtags: [],
    settings: {
      tone: "formal",
      emoji: "off",
      hashtagCount: 0,
      cta: "off",
      length: "long",
      linkPosition: "end",
      seo: true,
    },
  };
}

export async function contentRoutes(app: FastifyInstance) {
  const db = getDb();

  app.post("/runs/:runId/content", async (request, reply) => {
    const { runId } = z
      .object({ runId: z.string().uuid() })
      .parse(request.params);

    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);

    if (!run) {
      return reply.code(404).send({ error: "run_not_found" });
    }

    const [workflow] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, run.workflowId))
      .limit(1);

    if (!workflow) {
      return reply.code(404).send({ error: "workflow_not_found" });
    }

    let [content] = await db
      .select()
      .from(contentItems)
      .where(eq(contentItems.runId, runId))
      .orderBy(asc(contentItems.createdAt))
      .limit(1);

    if (!content) {
      const prompt =
        typeof run.input === "object" &&
        run.input &&
        "prompt" in run.input &&
        typeof run.input.prompt === "string"
          ? run.input.prompt
          : null;

      const generatedBody =
        run.output && Object.keys(run.output).length > 0
          ? "این پیش‌نویس از اجرای Workflow ساخته شده و آماده ویرایش نهایی است."
          : prompt ??
            "این پیش‌نویس از اجرای Workflow ساخته شده و آماده ویرایش نهایی است.";

      [content] = await db
        .insert(contentItems)
        .values({
          workspaceId: workflow.workspaceId,
          runId,
          title: `خروجی ${workflow.name}`,
          body: generatedBody,
          metadata: {
            provenance: {
              runId,
              workflowId: workflow.id,
              workflowName: workflow.name,
            },
          },
          status: "generated",
        })
        .returning();

      const title = content.title ?? "خروجی Workflow";
      const variants = [
        buildVariant("instagram", title, content.body),
        buildVariant("telegram", title, content.body),
        buildVariant("website", title, content.body),
      ];

      await db.insert(contentVariants).values(
        variants.map((variant) => ({
          contentItemId: content.id,
          channel: variant.channel,
          format: variant.format,
          title: variant.title,
          body: variant.body,
          hashtags: variant.hashtags,
          settings: variant.settings,
          status: "generated",
          generatedBy: "system",
        })),
      );
    }

    const variants = await db
      .select()
      .from(contentVariants)
      .where(eq(contentVariants.contentItemId, content.id))
      .orderBy(asc(contentVariants.createdAt));

    return {
      content,
      variants,
      provenance: {
        runId,
        workflowId: workflow.id,
        workflowName: workflow.name,
      },
    };
  });

  app.patch("/content/:contentItemId", async (request, reply) => {
    const { contentItemId } = z
      .object({ contentItemId: z.string().uuid() })
      .parse(request.params);
    const input = canonicalUpdateSchema.parse(request.body);

    const [updated] = await db
      .update(contentItems)
      .set({
        ...input,
        updatedAt: new Date(),
      })
      .where(eq(contentItems.id, contentItemId))
      .returning();

    if (!updated) {
      return reply.code(404).send({ error: "content_not_found" });
    }

    return updated;
  });

  app.patch("/content-variants/:variantId", async (request, reply) => {
    const { variantId } = z
      .object({ variantId: z.string().uuid() })
      .parse(request.params);
    const input = variantUpdateSchema.parse(request.body);

    const [updated] = await db
      .update(contentVariants)
      .set({
        ...input,
        updatedAt: new Date(),
      })
      .where(eq(contentVariants.id, variantId))
      .returning();

    if (!updated) {
      return reply.code(404).send({ error: "variant_not_found" });
    }

    return updated;
  });

  app.post("/content-variants/:variantId/approval", async (request, reply) => {
    const { variantId } = z
      .object({ variantId: z.string().uuid() })
      .parse(request.params);

    const input = z
      .object({
        reason: z.string().nullable().optional(),
        agentRecommendation: z.string().nullable().optional(),
      })
      .parse(request.body ?? {});

    const [variant] = await db
      .select()
      .from(contentVariants)
      .where(eq(contentVariants.id, variantId))
      .limit(1);

    if (!variant) {
      return reply.code(404).send({ error: "variant_not_found" });
    }

    const [content] = await db
      .select()
      .from(contentItems)
      .where(eq(contentItems.id, variant.contentItemId))
      .limit(1);

    if (!content) {
      return reply.code(404).send({ error: "content_not_found" });
    }

    const [existing] = await db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.contentVariantId, variantId),
          eq(approvals.status, "pending"),
        ),
      )
      .limit(1);

    const approval =
      existing ??
      (
        await db
          .insert(approvals)
          .values({
            workspaceId: content.workspaceId,
            contentVariantId: variantId,
            runId: content.runId,
            status: "pending",
            reason: input.reason ?? "نیاز به بررسی انسانی",
            agentRecommendation:
              input.agentRecommendation ??
              "این نسخه قبل از انتشار یک‌بار بررسی شود.",
            requestedBy: "content_studio",
          })
          .returning()
      )[0];

    await db
      .update(contentVariants)
      .set({
        status: "waiting_approval",
        updatedAt: new Date(),
      })
      .where(eq(contentVariants.id, variantId));

    await db
      .update(contentItems)
      .set({
        status: "waiting_approval",
        updatedAt: new Date(),
      })
      .where(eq(contentItems.id, content.id));

    return reply.code(existing ? 200 : 201).send(approval);
  });
}
