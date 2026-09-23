import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
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

const registerSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email(),
  password: z.string().min(8).max(128),
  workspaceName: z.string().min(2).max(120).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${key.toString("hex")}`;
}

async function verifyPassword(password: string, stored: string) {
  const [algorithm, salt, hash] = stored.split("$");
  if (algorithm !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function slugify(value: string) {
  const base = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return `${base || "workspace"}-${randomBytes(3).toString("hex")}`;
}

export async function authRoutes(app: FastifyInstance) {
  const db = getDb();

  app.post("/auth/register", async (request, reply) => {
    const input = registerSchema.parse(request.body);
    const email = input.email.toLowerCase().trim();

    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (existing) {
      return reply.code(409).send({ error: "email_already_exists" });
    }

    const passwordHash = await hashPassword(input.password);

    const result = await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          email,
          name: input.name,
          passwordHash,
        })
        .returning();

      const workspaceName =
        input.workspaceName?.trim() || `فضای کاری ${input.name}`;

      const [workspace] = await tx
        .insert(workspaces)
        .values({
          name: workspaceName,
          slug: slugify(workspaceName),
          ownerId: user.id,
        })
        .returning();

      await tx.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: user.id,
        role: "owner",
      });

      return { user, workspace };
    });

    const accessToken = app.jwt.sign(
      {
        sub: result.user.id,
        email: result.user.email,
        workspaceId: result.workspace.id,
      },
      { expiresIn: "7d" },
    );

    return reply.code(201).send({
      accessToken,
      user: {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
      },
      workspace: {
        id: result.workspace.id,
        name: result.workspace.name,
        slug: result.workspace.slug,
      },
    });
  });

  app.post("/auth/login", async (request, reply) => {
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

    const accessToken = app.jwt.sign(
      {
        sub: user.id,
        email: user.email,
        workspaceId: membership.workspaceId,
      },
      { expiresIn: "7d" },
    );

    return {
      accessToken,
      user: { id: user.id, email: user.email, name: user.name },
      workspace: {
        id: membership.workspaceId,
        name: membership.workspaceName,
        slug: membership.workspaceSlug,
      },
    };
  });

  app.get("/auth/me", {
    onRequest: [app.authenticate],
  }, async (request) => {
    return {
      user: {
        id: request.auth.userId,
        email: request.auth.email,
      },
      workspace: {
        id: request.auth.workspaceId,
      },
    };
  });
}
