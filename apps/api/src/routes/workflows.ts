import { and, asc, desc, eq } from "drizzle-orm";
import { isIP } from "node:net";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getDb,
  aiSettings,
  socialAccounts,
  workflowConnections,
  workflowSteps,
  workflowVersions,
  workflows,
} from "@socialyar/db";

const stepSchema = z.object({
  key: z.string().min(1),
  type: z.string().min(1),
  name: z.string().min(1),
  config: z.record(z.unknown()).default({}),
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
  order: z.number().int().default(0),
});

const connectionSchema = z.object({
  sourceKey: z.string().min(1),
  targetKey: z.string().min(1),
  condition: z.record(z.unknown()).nullable().optional(),
});

const createWorkflowSchema = z.object({
  name: z.string().min(1),
  status: z.enum(["draft", "active"]).default("draft"),
  description: z.string().nullable().optional(),
  autonomyMode: z.enum(["manual", "assisted", "semi_auto", "full_auto"]).default("assisted"),
  prompt: z.string().nullable().optional(),
  steps: z.array(stepSchema).default([]),
  connections: z.array(connectionSchema).default([]),
});

const updateWorkflowSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  autonomyMode: z.enum(["manual", "assisted", "semi_auto", "full_auto"]).optional(),
  status: z.enum(["draft", "active", "paused", "archived"]).optional(),
  prompt: z.string().nullable().optional(),
  steps: z.array(stepSchema),
  connections: z.array(connectionSchema).default([]),
});

async function insertGraph(
  tx: ReturnType<typeof getDb>,
  workflowVersionId: string,
  steps: z.infer<typeof stepSchema>[],
  connections: z.infer<typeof connectionSchema>[],
) {
  if (!steps.length) return;

  const insertedSteps = await tx
    .insert(workflowSteps)
    .values(
      steps.map((step) => ({
        workflowVersionId,
        key: step.key,
        type: step.type,
        name: step.name,
        config: step.config,
        position: step.position,
        order: step.order,
      })),
    )
    .returning({ id: workflowSteps.id, key: workflowSteps.key });

  const stepIds = new Map(insertedSteps.map((step) => [step.key, step.id]));

  if (connections.length) {
    await tx.insert(workflowConnections).values(
      connections.map((connection) => {
        const sourceStepId = stepIds.get(connection.sourceKey);
        const targetStepId = stepIds.get(connection.targetKey);

        if (!sourceStepId || !targetStepId) {
          throw new Error(
            `Invalid connection ${connection.sourceKey} -> ${connection.targetKey}`,
          );
        }

        return {
          workflowVersionId,
          sourceStepId,
          targetStepId,
          condition: connection.condition ?? null,
        };
      }),
    );
  }
}

async function autoWorkflowProblem(steps: z.infer<typeof stepSchema>[], workspaceId: string): Promise<string | null> {
  const sorted = [...steps].sort((a, b) => a.order - b.order);
  const types = sorted.map((step) => step.type);
  const source = sorted.find((step) => step.type === "rss_source");
  const publisher = sorted.find((step) => step.type === "publish");
  if (!source || !publisher || ["rss_source", "ai", "publish"].some((type) => types.filter((item) => item === type).length !== 1) ||
    types.some((type) => !["rss_source", "ai", "human_approval", "draft", "publish"].includes(type)) ||
    types.indexOf("rss_source") >= types.indexOf("ai") || types.indexOf("ai") >= types.indexOf("publish") ||
    (types.includes("human_approval") && (types.indexOf("human_approval") < types.indexOf("ai") || types.indexOf("human_approval") > types.indexOf("publish")))) {
    return "auto_workflow_requires_rss_ai_and_eitaa_in_order";
  }
  try {
    const url = new URL(String(source.config.feedUrl));
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
      isIP(url.hostname.replace(/[\[\]]/g, "")) !== 0 ||
      /^(localhost|.*\.local|.*\.internal)$/i.test(url.hostname)) return "invalid_rss_url";
  } catch { return "invalid_rss_url"; }
  const accountId = publisher.config.accountId;
  if (typeof accountId !== "string" || !z.string().uuid().safeParse(accountId).success) return "eitaa_account_required";
  const db = getDb();
  const [account] = await db.select().from(socialAccounts)
    .where(and(eq(socialAccounts.id, accountId), eq(socialAccounts.workspaceId, workspaceId),
      eq(socialAccounts.channel, "eitaa"), eq(socialAccounts.isActive, true))).limit(1);
  if (!account) return "eitaa_account_not_found";
  const [settings] = await db.select().from(aiSettings)
    .where(eq(aiSettings.workspaceId, workspaceId)).limit(1);
  return settings ? null : "ai_token_not_configured";
}

export async function workflowRoutes(app: FastifyInstance) {
  const db = getDb();
  app.addHook("onRequest", app.authenticate);

  app.post("/workflows", async (request, reply) => {
    const input = createWorkflowSchema.parse(request.body);
    if (input.status === "active" && input.autonomyMode === "full_auto") {
      const problem = await autoWorkflowProblem(input.steps, request.auth.workspaceId);
      if (problem) return reply.code(409).send({ error: problem });
    }

    const result = await db.transaction(async (tx) => {
      const [workflow] = await tx
        .insert(workflows)
        .values({
          workspaceId: request.auth.workspaceId,
          name: input.name,
          description: input.description ?? null,
          autonomyMode: input.autonomyMode,
          status: input.status,
          createdBy: request.auth.userId,
          currentVersion: 1,
        })
        .returning();

      const [version] = await tx
        .insert(workflowVersions)
        .values({
          workflowId: workflow.id,
          version: 1,
          prompt: input.prompt ?? null,
          snapshot: {
            autonomyMode: input.autonomyMode,
            stepCount: input.steps.length,
            connectionCount: input.connections.length,
          },
          createdBy: request.auth.userId,
        })
        .returning();

      await insertGraph(
        tx as unknown as ReturnType<typeof getDb>,
        version.id,
        input.steps,
        input.connections,
      );

      return { workflow, version };
    });

    return reply.code(201).send(result);
  });

  app.get("/workflows", async (request) => {
    return db
      .select()
      .from(workflows)
      .where(eq(workflows.workspaceId, request.auth.workspaceId))
      .orderBy(desc(workflows.updatedAt));
  });

  app.get("/workflows/:workflowId", async (request, reply) => {
    const { workflowId } = z
      .object({ workflowId: z.string().uuid() })
      .parse(request.params);

    const [workflow] = await db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.id, workflowId),
          eq(workflows.workspaceId, request.auth.workspaceId),
        ),
      )
      .limit(1);

    if (!workflow) {
      return reply.code(404).send({ error: "workflow_not_found" });
    }

    const [version] = await db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.workflowId, workflowId))
      .orderBy(desc(workflowVersions.version))
      .limit(1);

    if (!version) {
      return { workflow, version: null, steps: [], connections: [] };
    }

    const steps = await db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.workflowVersionId, version.id))
      .orderBy(asc(workflowSteps.order));

    const connections = await db
      .select()
      .from(workflowConnections)
      .where(eq(workflowConnections.workflowVersionId, version.id));

    return { workflow, version, steps, connections };
  });

  app.put("/workflows/:workflowId", async (request, reply) => {
    const { workflowId } = z
      .object({ workflowId: z.string().uuid() })
      .parse(request.params);
    const input = updateWorkflowSchema.parse(request.body);

    const [existing] = await db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.id, workflowId),
          eq(workflows.workspaceId, request.auth.workspaceId),
        ),
      )
      .limit(1);

    if (!existing) {
      return reply.code(404).send({ error: "workflow_not_found" });
    }
    if ((input.status ?? existing.status) === "active" && (input.autonomyMode ?? existing.autonomyMode) === "full_auto") {
      const problem = await autoWorkflowProblem(input.steps, request.auth.workspaceId);
      if (problem) return reply.code(409).send({ error: problem });
    }

    const nextVersion = existing.currentVersion + 1;

    const result = await db.transaction(async (tx) => {
      const [workflow] = await tx
        .update(workflows)
        .set({
          name: input.name ?? existing.name,
          description:
            input.description === undefined ? existing.description : input.description,
          autonomyMode: input.autonomyMode ?? existing.autonomyMode,
          status: input.status ?? existing.status,
          currentVersion: nextVersion,
          updatedAt: new Date(),
        })
        .where(eq(workflows.id, workflowId))
        .returning();

      const [version] = await tx
        .insert(workflowVersions)
        .values({
          workflowId,
          version: nextVersion,
          prompt: input.prompt ?? null,
          snapshot: {
            autonomyMode: input.autonomyMode ?? existing.autonomyMode,
            stepCount: input.steps.length,
            connectionCount: input.connections.length,
          },
          createdBy: request.auth.userId,
        })
        .returning();

      await insertGraph(
        tx as unknown as ReturnType<typeof getDb>,
        version.id,
        input.steps,
        input.connections,
      );

      return { workflow, version };
    });

    return result;
  });
}
