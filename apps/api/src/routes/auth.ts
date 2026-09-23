import { scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getDb,
  users,
  workspaceMembers,
  workspaces,
} from "@socialyar/db";

const scrypt = promisify(scryptCallback);

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

async function verifyPassword(password: string, stored: string) {
  const [algorithm, salt, hash] = stored.split("$");
  if (algorithm !== "scrypt" || !salt || !hash) return false;

  const expected = Buffer.from(hash, "hex");
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;

  return (
    actual.length === expected.length &&
    timingSafeEqual(actual, expected)
  );
}

export async function authRoutes(app: FastifyInstance) {
  const db = getDb();

  app.post(
    "/auth/login",
    {
      schema: {
        tags: ["Auth"],
        summary: "Login",
        description: "Authenticate an existing user and return a JWT access token.",
        body: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email" },
            password: { type: "string", format: "password" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              accessToken: { type: "string" },
              user: {
                type: "object",
                properties: {
                  id: { type: "string", format: "uuid" },
                  email: { type: "string" },
                  name: { type: ["string", "null"] },
                },
              },
              workspace: {
                type: "object",
                properties: {
                  id: { type: "string", format: "uuid" },
                  name: { type: "string" },
                  slug: { type: "string" },
                },
              },
            },
          },
          401: {
            type: "object",
            properties: {
              error: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const input = loginSchema.parse(request.body);
      const email = input.email.toLowerCase().trim();

      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      if (!user?.passwordHash) {
        return reply.code(401).send({ error: "invalid_credentials" });
      }

      const valid = await verifyPassword(input.password, user.passwordHash);
      if (!valid) {
        return reply.code(401).send({ error: "invalid_credentials" });
      }

      const [membership] = await db
        .select({
          workspaceId: workspaceMembers.workspaceId,
          workspaceName: workspaces.name,
          workspaceSlug: workspaces.slug,
        })
        .from(workspaceMembers)
        .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
        .where(eq(workspaceMembers.userId, user.id))
        .limit(1);

      if (!membership) {
        return reply.code(409).send({ error: "workspace_not_found" });
      }

      const accessToken = app.signAccessToken({
        sub: user.id,
        email: user.email,
        workspaceId: membership.workspaceId,
      });

      return {
        accessToken,
        user: { id: user.id, email: user.email, name: user.name },
        workspace: {
          id: membership.workspaceId,
          name: membership.workspaceName,
          slug: membership.workspaceSlug,
        },
      };
    },
  );

  app.get(
    "/auth/me",
    {
      onRequest: [app.authenticate],
      schema: {
        tags: ["Auth"],
        summary: "Current user",
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: "object",
            properties: {
              user: {
                type: "object",
                properties: {
                  id: { type: "string", format: "uuid" },
                  email: { type: "string" },
                },
              },
              workspace: {
                type: "object",
                properties: {
                  id: { type: "string", format: "uuid" },
                },
              },
            },
          },
        },
      },
    },
    async (request) => ({
      user: {
        id: request.auth.userId,
        email: request.auth.email,
      },
      workspace: {
        id: request.auth.workspaceId,
      },
    }),
  );
}
