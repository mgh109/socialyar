import Fastify from "fastify";
import { z } from "zod";
import { createRun } from "@socialyar/workflow";

const app = Fastify({ logger: true });

app.get("/health", async () => ({ ok: true, service: "socialyar-api" }));

app.post("/workflows/:workflowId/runs", async (request, reply) => {
  const params = z.object({ workflowId: z.string().min(1) }).parse(request.params);
  const run = createRun(params.workflowId);
  return reply.code(201).send(run);
});

const port = Number(process.env.PORT ?? 4000);
app.listen({ port, host: "0.0.0.0" }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
