import Fastify from "fastify";
import { ZodError } from "zod";
import { closeDb } from "@socialyar/db";
import { workflowRoutes } from "./routes/workflows";
import { runRoutes } from "./routes/runs";

const app = Fastify({ logger: true });

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: "validation_error",
      issues: error.issues,
    });
  }

  app.log.error(error);
  return reply.code(500).send({ error: "internal_error" });
});

app.get("/health", async () => ({
  ok: true,
  service: "socialyar-api",
  database: Boolean(process.env.DATABASE_URL),
}));

await app.register(workflowRoutes);
await app.register(runRoutes);

const port = Number(process.env.PORT ?? 4000);

const shutdown = async () => {
  await app.close();
  await closeDb();
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

app.listen({ port, host: "0.0.0.0" }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
