import { and, asc, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getDb,
  runEvents,
  runSteps,
  runs,
  workflowVersions,
  workflows,
  workflowSteps,
} from "@socialyar/db";
import { workflowQueue } from "../queue";

const createRunSchema = z.object({
  trigger: z.string().min(1).default("manual"),
  input: z.record(z.unknown()).default({}),
});

export async function runRoutes(app: FastifyInstance) {
  const db = getDb();
  app.addHook("onRequest", app.authenticate);

  app.post("/workflows/:workflowId/runs", async (request, reply) => {
    const { workflowId } = z
      .object({ workflowId: z.string().uuid() })
      .parse(request.params);
    const input = createRunSchema.parse(request.body ?? {});

    const [workflow] = await db
      .select()
      .from(workflows)
      .where(and(eq(workflows.id, workflowId), eq(workflows.workspaceId, request.auth.workspaceId)))
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
      return reply.code(409).send({ error: "workflow_has_no_version" });
    }

    const run = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(runs)
        .values({
          workflowId,
          workflowVersionId: version.id,
          status: "queued",
          trigger: input.trigger,
          input: input.input,
        })
        .returning();

      await tx.insert(runEvents).values({
        runId: created.id,
        type: "run_started",
        message: "Run queued",
        payload: {
          workflowId,
          workflowVersionId: version.id,
          trigger: input.trigger,
        },
      });

      return created;
    });

    try {
      await workflowQueue.add(
        "execute-workflow",
        {
          runId: run.id,
          workflowId,
          workflowVersionId: version.id,
        },
        {
          jobId: run.id,
          attempts: 3,
          backoff: { type: "exponential", delay: 2000 },
          removeOnComplete: 1000,
          removeOnFail: 1000,
        },
      );
    } catch (error) {
      await db
        .update(runs)
        .set({
          status: "failed",
          output: {
            error: {
              message:
                error instanceof Error ? error.message : "Failed to queue run",
            },
          },
          finishedAt: new Date(),
        })
        .where(eq(runs.id, run.id));

      await db.insert(runEvents).values({
        runId: run.id,
        type: "run_failed",
        message: "Run could not be queued",
        payload: {
          error: error instanceof Error ? error.message : "Unknown queue error",
        },
      });

      return reply.code(503).send({
        error: "queue_unavailable",
        runId: run.id,
      });
    }

    return reply.code(201).send(run);
  });

  app.get("/runs/:runId", async (request, reply) => {
    const { runId } = z
      .object({ runId: z.string().uuid() })
      .parse(request.params);

    const [row] = await db
      .select({ run: runs })
      .from(runs)
      .innerJoin(workflows, eq(runs.workflowId, workflows.id))
      .where(and(eq(runs.id, runId), eq(workflows.workspaceId, request.auth.workspaceId)))
      .limit(1);

    if (!row) {
      return reply.code(404).send({ error: "run_not_found" });
    }

    return row.run;
  });

  app.get("/runs/:runId/steps", async (request, reply) => {
    const { runId } = z.object({ runId: z.string().uuid() }).parse(request.params);
    const [owned] = await db.select({ versionId: runs.workflowVersionId }).from(runs)
      .innerJoin(workflows, eq(runs.workflowId, workflows.id))
      .where(and(eq(runs.id, runId), eq(workflows.workspaceId, request.auth.workspaceId))).limit(1);
    if (!owned) return reply.code(404).send({ error: "run_not_found" });
    return db.select({ key: workflowSteps.key, name: workflowSteps.name, type: workflowSteps.type })
      .from(workflowSteps).where(eq(workflowSteps.workflowVersionId, owned.versionId)).orderBy(asc(workflowSteps.order));
  });

  app.post("/runs/:runId/approval", async (request, reply) => {
    const { runId } = z.object({ runId: z.string().uuid() }).parse(request.params);
    const { action } = z.object({ action: z.enum(["approve", "reject"]) }).parse(request.body);
    const [owned] = await db.select({ run: runs }).from(runs)
      .innerJoin(workflows, eq(runs.workflowId, workflows.id))
      .where(and(eq(runs.id, runId), eq(workflows.workspaceId, request.auth.workspaceId))).limit(1);
    if (!owned) return reply.code(404).send({ error: "run_not_found" });
    if (owned.run.status !== "waiting_approval") return reply.code(409).send({ error: "run_not_waiting_approval" });

    const [pending] = await db.select({ step: runSteps }).from(runSteps)
      .innerJoin(workflowSteps, eq(runSteps.workflowStepId, workflowSteps.id))
      .where(and(eq(runSteps.runId, runId), eq(runSteps.status, "waiting_approval"))).limit(1);
    if (!pending) return reply.code(409).send({ error: "approval_step_not_found" });
    const next = action === "approve" ? "queued" : "cancelled";
    const [claimed] = await db.update(runs).set({ status: next, finishedAt: action === "reject" ? new Date() : null })
      .where(and(eq(runs.id, runId), eq(runs.status, "waiting_approval"))).returning();
    if (!claimed) return reply.code(409).send({ error: "approval_already_resolved" });
    await db.update(runSteps).set({ status: action === "approve" ? "completed" : "skipped",
      output: { approved: action === "approve", resolvedBy: request.auth.userId }, finishedAt: new Date() })
      .where(eq(runSteps.id, pending.step.id));
    await db.insert(runEvents).values({ runId, runStepId: pending.step.id, type: "approval_resolved",
      payload: { action, resolvedBy: request.auth.userId } });
    if (action === "approve") {
      try {
        await workflowQueue.add("execute-workflow", {
          runId, workflowId: owned.run.workflowId, workflowVersionId: owned.run.workflowVersionId,
        }, { jobId: `${runId}-resume`, attempts: 3, backoff: { type: "exponential", delay: 2000 } });
      } catch (error) {
        await db.update(runs).set({ status: "failed", output: { error: { message: "Could not resume run" } }, finishedAt: new Date() })
          .where(eq(runs.id, runId));
        return reply.code(503).send({ error: "queue_unavailable" });
      }
    }
    return { runId, status: next };
  });

  app.get("/runs/:runId/events", async (request, reply) => {
    const { runId } = z
      .object({ runId: z.string().uuid() })
      .parse(request.params);

    const [run] = await db
      .select({ id: runs.id })
      .from(runs)
      .innerJoin(workflows, eq(runs.workflowId, workflows.id))
      .where(and(eq(runs.id, runId), eq(workflows.workspaceId, request.auth.workspaceId)))
      .limit(1);

    if (!run) {
      return reply.code(404).send({ error: "run_not_found" });
    }

    return db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(asc(runEvents.createdAt));
  });

  app.get("/runs/:runId/events/stream", async (request, reply) => {
    const { runId } = z
      .object({ runId: z.string().uuid() })
      .parse(request.params);

    const [run] = await db
      .select({ id: runs.id })
      .from(runs)
      .innerJoin(workflows, eq(runs.workflowId, workflows.id))
      .where(and(eq(runs.id, runId), eq(workflows.workspaceId, request.auth.workspaceId)))
      .limit(1);

    if (!run) {
      return reply.code(404).send({ error: "run_not_found" });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    reply.raw.write("retry: 2000\n\n");

    const seen = new Set<string>();
    let closed = false;

    const sendNewEvents = async () => {
      if (closed) return;

      const events = await db
        .select()
        .from(runEvents)
        .where(eq(runEvents.runId, runId))
        .orderBy(asc(runEvents.createdAt));

      for (const event of events) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);

        reply.raw.write(`id: ${event.id}\n`);
        reply.raw.write(`event: ${event.type}\n`);
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    };

    await sendNewEvents();

    const poll = setInterval(() => {
      void sendNewEvents().catch((error) => {
        app.log.error({ error, runId }, "SSE run event polling failed");
      });
    }, 1000);

    const heartbeat = setInterval(() => {
      if (!closed) reply.raw.write(": heartbeat\n\n");
    }, 15000);

    request.raw.on("close", () => {
      closed = true;
      clearInterval(poll);
      clearInterval(heartbeat);
      reply.raw.end();
    });
  });
}
