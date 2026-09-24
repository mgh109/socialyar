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
import { aiSettingsRoutes } from "./routes/ai-settings";
import { authPlugin } from "./auth";
import { closeQueue } from "./queue";

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: process.env.WEB_ORIGIN
    ? process.env.WEB_ORIGIN.split(",").map((origin) => origin.trim())
    : true,
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
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

const apiServer = process.env.API_PUBLIC_URL ?? "https://api.hoorpluse.ir";

const openapi = {
  openapi: "3.0.3",
  info: {
    title: "HoorPluse API",
    description: "API documentation for HoorPluse / SocialYar",
    version: "1.0.0",
  },
  servers: [{ url: apiServer }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
      },
    },
  },
  paths: {
    "/health": {
      get: {
        tags: ["System"],
        summary: "Health check",
        responses: {
          "200": {
            description: "Service health",
          },
        },
      },
    },
    "/auth/login": {
      post: {
        tags: ["Auth"],
        summary: "Login",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email", "password"],
                properties: {
                  email: { type: "string", format: "email" },
                  password: { type: "string", format: "password" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Authenticated successfully" },
          "401": { description: "Invalid credentials" },
        },
      },
    },
    "/auth/me": {
      get: {
        tags: ["Auth"],
        summary: "Current user",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": { description: "Current authenticated user" },
          "401": { description: "Unauthorized" },
        },
      },
    },
    "/workflows": {
      get: {
        tags: ["Workflows"],
        summary: "List workflows",
        security: [{ bearerAuth: [] }],
        responses: { "200": { description: "Workflow list" } },
      },
      post: {
        tags: ["Workflows"],
        summary: "Create workflow",
        security: [{ bearerAuth: [] }],
        responses: { "201": { description: "Workflow created" } },
      },
    },
    "/workflows/{workflowId}": {
      get: {
        tags: ["Workflows"],
        summary: "Get workflow",
        security: [{ bearerAuth: [] }],
        parameters: [{
          name: "workflowId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        }],
        responses: { "200": { description: "Workflow details" } },
      },
      put: {
        tags: ["Workflows"],
        summary: "Update workflow",
        security: [{ bearerAuth: [] }],
        parameters: [{
          name: "workflowId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        }],
        responses: { "200": { description: "Workflow updated" } },
      },
    },
    "/workflows/{workflowId}/runs": {
      post: {
        tags: ["Runs"],
        summary: "Start workflow run",
        security: [{ bearerAuth: [] }],
        parameters: [{
          name: "workflowId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        }],
        responses: { "201": { description: "Run created" } },
      },
    },
    "/approvals": {
      get: {
        tags: ["Approvals"],
        summary: "List approvals",
        security: [{ bearerAuth: [] }],
        responses: { "200": { description: "Approval list" } },
      },
    },
    "/calendar": {
      get: {
        tags: ["Publishing"],
        summary: "Publishing calendar",
        security: [{ bearerAuth: [] }],
        responses: { "200": { description: "Calendar items" } },
      },
    },
    "/social-accounts": {
      get: {
        tags: ["Connections"],
        summary: "List social accounts",
        security: [{ bearerAuth: [] }],
        responses: { "200": { description: "Connected accounts" } },
      },
      post: {
        tags: ["Connections"],
        summary: "Create social account",
        security: [{ bearerAuth: [] }],
        responses: { "201": { description: "Account created" } },
      },
    },
    "/analytics/summary": {
      get: {
        tags: ["Analytics"],
        summary: "Analytics summary",
        security: [{ bearerAuth: [] }],
        responses: { "200": { description: "Analytics summary" } },
      },
    },
  },
};

app.get("/docs/json", async (_request, reply) => {
  return reply.send(openapi);
});

app.get("/docs", async (_request, reply) => {
  reply.type("text/html; charset=utf-8");
  return reply.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>HoorPluse API Docs</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: "/docs/json",
      dom_id: "#swagger-ui",
      deepLinking: true,
      persistAuthorization: true
    });
  </script>
</body>
</html>`);
});

app.get("/health", async () => ({
  ok: true,
  service: "socialyar-api",
  database: Boolean(process.env.DATABASE_URL),
  redis: Boolean(process.env.REDIS_URL),
}));

await app.register(authRoutes);
await app.register(aiSettingsRoutes);
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
