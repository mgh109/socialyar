import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";
import type { FastifyReply, FastifyRequest } from "fastify";

export type AuthContext = {
  userId: string;
  email: string;
  workspaceId: string;
};

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext;
  }

  interface FastifyInstance {
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
  }
}

export const authPlugin = fp(async (app) => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is required");
  }

  await app.register(fastifyJwt, { secret });

  app.decorateRequest("auth", null);

  app.decorate("authenticate", async function (
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    try {
      const payload = await request.jwtVerify<{
        sub: string;
        email: string;
        workspaceId: string;
      }>();

      request.auth = {
        userId: payload.sub,
        email: payload.email,
        workspaceId: payload.workspaceId,
      };
    } catch {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });
});
