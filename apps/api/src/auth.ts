import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export type AuthContext = {
  userId: string;
  email: string;
  workspaceId: string;
};

type TokenPayload = {
  sub: string;
  email: string;
  workspaceId: string;
  iat: number;
  exp: number;
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
    signAccessToken: (payload: {
      sub: string;
      email: string;
      workspaceId: string;
    }) => string;
  }
}

function base64url(value: string | Buffer) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function decodeBase64url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4;
  return Buffer.from(
    normalized + (padding ? "=".repeat(4 - padding) : ""),
    "base64",
  );
}

function signToken(
  payload: Omit<TokenPayload, "iat" | "exp">,
  secret: string,
) {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: TokenPayload = {
    ...payload,
    iat: now,
    exp: now + 7 * 24 * 60 * 60,
  };

  const header = base64url(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  );
  const body = base64url(JSON.stringify(fullPayload));
  const unsigned = `${header}.${body}`;
  const signature = base64url(
    createHmac("sha256", secret).update(unsigned).digest(),
  );

  return `${unsigned}.${signature}`;
}

function verifyToken(token: string, secret: string): TokenPayload {
  const [header, body, signature] = token.split(".");
  if (!header || !body || !signature) {
    throw new Error("Invalid token");
  }

  const unsigned = `${header}.${body}`;
  const expected = base64url(
    createHmac("sha256", secret).update(unsigned).digest(),
  );

  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new Error("Invalid token signature");
  }

  const payload = JSON.parse(
    decodeBase64url(body).toString("utf8"),
  ) as TokenPayload;

  if (
    !payload.sub ||
    !payload.email ||
    !payload.workspaceId ||
    !payload.exp ||
    payload.exp <= Math.floor(Date.now() / 1000)
  ) {
    throw new Error("Expired or invalid token");
  }

  return payload;
}

export async function authPlugin(app: FastifyInstance) {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 characters");
  }

  app.decorateRequest("auth", null as unknown as AuthContext);

  app.decorate("signAccessToken", (payload) =>
    signToken(payload, secret),
  );

  app.decorate("authenticate", async function (
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }

    try {
      const token = authorization.slice("Bearer ".length).trim();
      const payload = verifyToken(token, secret);

      request.auth = {
        userId: payload.sub,
        email: payload.email,
        workspaceId: payload.workspaceId,
      };
    } catch {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });
}
