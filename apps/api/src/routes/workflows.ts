import { asc, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getDb,
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
  workspaceId: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  autonomyMode: z.enum(["manual", "assisted", "semi_auto", "full_auto"]).default("assisted"),
  prompt: z.string().nullable().optional(),
  createdBy: z.string().uuid().nullable().optional(),
  steps: z.array(stepSchema).default([]),
  connections: z.array(connectionSchema).default([]),
});

const updateWorkflowSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  autonomyMode: z.enum(["manual", "assisted", "semi_auto", "full_auto"]).optional(),
  status: z.enum(["draft", "active", "paused", "archived"]).optional(),
  prompt: z.string().nullable().optional(),
  createdBy: z.string().uuid().nullable().optional(),
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

export async function workflowRoutes(app: FastifyInstance) {
  const db = getDb();

  app.post("/workflows", async (request, reply) => {
    const input = createWorkflowSchema.parse(request.body);

    const result = await db.transaction(async (tx) => {
      const [workflow] = await tx
        .insert(workflows)
        .values({
          workspaceId: input.workspaceId,
          name: input.name,
          description: input.description ?? null,
          autonomyMode: input.autonomyMode,
          createdBy: input.createdBy ?? null,
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
          createdBy: input.createdBy ?? null,
        })
        .returning();

      await insertGraph(tx as ReturnType<typeof getDb>, version.id, input.steps, input.connections);

      return { workflow, version };
    });

    return reply.code(201).send(result);
  });

  app.get("/workflows", async (request) => {
    const query = z
      .object({ workspaceId: z.string().uuid() })
      .parse(request.query);

    return db
      .select()
      .from(workflows)
      .where(eq(workflows.workspaceId, query.workspaceId))
      .orderBy(desc(workflows.updatedAt));
  });

  app.get("/workflows/:workflowId", async (request, reply) => {
    const { workflowId } = z
      .object({ workflowId: z.string().uuid() })
      .parse(request.params);

    const [workflow] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, workflowId))
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
      .where(eq(workflows.id, workflowId))
      .limit(1);

    if (!existing) {
      return reply.code(404).send({ error: "workflow_not_found" });
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
          createdBy: input.createdBy ?? null,
        })
        .returning();

      await insertGraph(tx as ReturnType<typeof getDb>, version.id, input.steps, input.connections);

      return { workflow, version };
    });

    return result;
  });
}
