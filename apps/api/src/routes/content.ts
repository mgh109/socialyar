import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  approvals,
  contentItems,
  contentVariants,
  getDb,
  runs,
  runSteps,
  workflowSteps,
  workflows,
} from "@socialyar/db";

const canonicalUpdateSchema = z.object({
  title: z.string().nullable().optional(),
  body: z.string().min(1).optional(),

});

const variantUpdateSchema = z.object({
  title: z.string().nullable().optional(),
  body: z.string().min(1).optional(),
  hashtags: z.array(z.string()).optional(),
  settings: z.record(z.unknown()).optional(),

});

function buildVariant(
  channel: "instagram" | "telegram" | "website" | "eitaa",
  title: string,
  body: string,
) {
  if (channel === "instagram") {
    return {
      channel,
      format: "post",
      title,
      body: `${title}\n\n${body}\n\nبرای خبرهای بیشتر هور+ را دنبال کنید.`,
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

  if (channel === "telegram" || channel === "eitaa") {
    return {
      channel,
      format: "news",
      title,
      body: `${title}\n\n${body}`,
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

export async function contentRoutes(app: FastifyInstance, options: { database?: ReturnType<typeof getDb> } = {}) {
  const db = options.database ?? getDb();
  app.addHook("onRequest", app.authenticate);

  app.post("/runs/:runId/content", async (request, reply) => {
    const { runId } = z
      .object({ runId: z.string().uuid() })
      .parse(request.params);

    const [run] = await db
      .select({ run: runs })
      .from(runs)
      .innerJoin(workflows, eq(runs.workflowId, workflows.id))
      .where(and(eq(runs.id, runId), eq(workflows.workspaceId, request.auth.workspaceId)))
      .limit(1);

    if (!run) {
      return reply.code(404).send({ error: "run_not_found" });
    }
    const ownedRun = run.run;

    const [workflow] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, ownedRun.workflowId))
      .limit(1);

    if (!workflow) {
      return reply.code(404).send({ error: "workflow_not_found" });
    }
    const draftRows = await db.select({ key: workflowSteps.key, output: runSteps.output }).from(runSteps)
      .innerJoin(workflowSteps, eq(runSteps.workflowStepId, workflowSteps.id))
      .where(and(eq(runSteps.runId, runId), eq(workflowSteps.workflowVersionId, ownedRun.workflowVersionId),
        eq(workflowSteps.type, "draft"), eq(runSteps.status, "completed"))).orderBy(asc(workflowSteps.order));
    const draft = draftRows.find((item) => typeof item.output?.text === "string" && item.output.text.trim());
    if (!draft) return reply.code(409).send({ error: "run_has_no_draft_output" });

    return db.transaction(async (tx) => {
      // Serialize materialization so simultaneous tabs cannot create duplicate drafts.
      await tx.execute(sql`SELECT id FROM runs WHERE id = ${runId} FOR UPDATE`);
      const existing = await tx
        .select()
        .from(contentItems)
        .where(eq(contentItems.runId, runId))
        .orderBy(asc(contentItems.createdAt));

      let content = existing.find((item) => item.metadata.draftStepKey === draft.key) ??
        existing.find((item) => !item.metadata.draftStepKey && !item.metadata.publishStepKey && !item.metadata.automated);

      if (!content) {
        const generatedBody = draft.output?.text as string;
        if (!generatedBody?.trim()) return reply.code(409).send({ error: "run_has_no_text_output" });

        [content] = await tx
          .insert(contentItems)
          .values({
            workspaceId: workflow.workspaceId,
            runId,
            title: `خروجی ${workflow.name}`,
            body: generatedBody,
            metadata: {
              draftStepKey: draft.key,
              provenance: {
                runId,
                workflowId: workflow.id,
                workflowName: workflow.name,
              },
            },
            status: "generated" as const,
          })
          .returning();

        const title = content.title ?? "خروجی Workflow";
        const variants = [
          buildVariant("instagram", title, content.body),
          buildVariant("telegram", title, content.body),
          buildVariant("eitaa", title, content.body),
          buildVariant("website", title, content.body),
        ];

        const contentId = content.id;
        await tx.insert(contentVariants).values(
          variants.map((variant) => ({
            contentItemId: contentId,
            channel: variant.channel,
            format: variant.format,
            title: variant.title,
            body: variant.body,
            hashtags: variant.hashtags,
            settings: variant.settings,
            status: "generated" as const,
            generatedBy: "system",
          })),
        );
      }

      const variants = await tx
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
      .where(and(eq(contentItems.id, contentItemId), eq(contentItems.workspaceId, request.auth.workspaceId)))
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

    const [owned] = await db.select({ id: contentVariants.id })
      .from(contentVariants)
      .innerJoin(contentItems, eq(contentVariants.contentItemId, contentItems.id))
      .where(and(eq(contentVariants.id, variantId), eq(contentItems.workspaceId, request.auth.workspaceId)))
      .limit(1);
    if (!owned) return reply.code(404).send({ error: "variant_not_found" });

    const [updated] = await db
      .update(contentVariants)
      .set({
        ...input,
        updatedAt: new Date(),
      })
      .where(and(eq(contentVariants.id, variantId), inArray(contentVariants.status, ["draft", "generated", "rejected"])))
      .returning();

    if (!updated) {
      return reply.code(409).send({ error: "variant_locked_for_review_or_publication" });
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

    if (!content || content.workspaceId !== request.auth.workspaceId) {
      return reply.code(404).send({ error: "content_not_found" });
    }
    if (!["draft", "generated", "rejected"].includes(variant.status)) {
      return reply.code(409).send({ error: "variant_already_submitted" });
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
