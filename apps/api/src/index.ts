import cors from "@fastify/cors";
import Fastify from "fastify";
import { ZodError } from "zod";
import { closeDb } from "@socialyar/db";
import { workflowRoutes } from "./routes/workflows";
import { runRoutes } from "./routes/runs";
import { contentRoutes } from "./routes/content";
import { approvalRoutes } from "./routes/approvals";
import { accountRoutes } from "./routes/accounts";
import { analyticsRoutes } from "./routes/analytics";
import { authRoutes } from "./routes/auth";
import { authPlugin } from "./auth";
import { closeQueue } from "./queue";

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: process.env.WEB_ORIGIN
    ? process.env.WEB_ORIGIN.split(",").map((origin) => origin.trim())
    : true,
  credentials: true,
});

await authPlugin(app);

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
  redis: Boolean(process.env.REDIS_URL),
}));

await app.register(authRoutes);
await app.register(workflowRoutes);
await app.register(runRoutes);
await app.register(contentRoutes);
await app.register(approvalRoutes);
await app.register(accountRoutes);
await app.register(analyticsRoutes);

const port = Number(process.env.PORT ?? 4000);

const shutdown = async () => {
  await app.close();
  await closeQueue();
  await closeDb();
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

app.listen({ port, host: "0.0.0.0" }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
