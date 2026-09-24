import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDb, socialAccounts } from "@socialyar/db";

const channelSchema = z.enum(["instagram", "telegram", "website", "x", "linkedin"]);

const createAccountSchema = z.object({
  workspaceId: z.string().uuid(),
  channel: channelSchema,
  externalAccountId: z.string().min(1),
  displayName: z.string().nullable().optional(),
  credentials: z.record(z.unknown()).default({}),
  isActive: z.boolean().default(true),
});

const updateAccountSchema = z.object({
  externalAccountId: z.string().min(1).optional(),
  displayName: z.string().nullable().optional(),
  credentials: z.record(z.unknown()).optional(),
  isActive: z.boolean().optional(),
});

function safeAccount(account: typeof socialAccounts.$inferSelect) {
  return {
    id: account.id,
    workspaceId: account.workspaceId,
    channel: account.channel,
    externalAccountId: account.externalAccountId,
    displayName: account.displayName,
    isActive: account.isActive,
    hasCredentials: Object.keys(account.credentials ?? {}).length > 0,
    credentialKeys: Object.keys(account.credentials ?? {}),
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

async function testTelegram(
  externalAccountId: string,
  credentials: Record<string, unknown>,
) {
  const botToken =
    typeof credentials.botToken === "string" ? credentials.botToken : "";

  if (!botToken) {
    throw new Error("botToken is required");
  }

  const botResponse = await fetch(
    `https://api.telegram.org/bot${botToken}/getMe`,
  );
  const botData = (await botResponse.json()) as {
    ok?: boolean;
    description?: string;
    result?: { username?: string; first_name?: string };
  };

  if (!botResponse.ok || !botData.ok) {
    throw new Error(botData.description ?? "Telegram bot validation failed");
  }

  const chatId =
    typeof credentials.chatId === "string"
      ? credentials.chatId
      : externalAccountId;

  const chatResponse = await fetch(
    `https://api.telegram.org/bot${botToken}/getChat?chat_id=${encodeURIComponent(chatId)}`,
  );
  const chatData = (await chatResponse.json()) as {
    ok?: boolean;
    description?: string;
    result?: { title?: string; username?: string; type?: string };
  };

  if (!chatResponse.ok || !chatData.ok) {
    throw new Error(chatData.description ?? "Telegram chat validation failed");
  }

  return {
    ok: true,
    provider: "telegram-bot-api",
    identity: {
      bot: botData.result?.username ?? botData.result?.first_name ?? "Telegram Bot",
      chat: chatData.result?.username ?? chatData.result?.title ?? chatId,
      type: chatData.result?.type ?? null,
    },
  };
}

async function testWebsite(credentials: Record<string, unknown>) {
  const webhookUrl =
    typeof credentials.webhookUrl === "string" ? credentials.webhookUrl : "";

  if (!webhookUrl) {
    throw new Error("webhookUrl is required");
  }

  const token =
    typeof credentials.token === "string" ? credentials.token : null;

  const response = await fetch(webhookUrl, {
    method: "OPTIONS",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });

  if (!response.ok && response.status !== 405) {
    throw new Error(
      `Website connection failed: ${response.status} ${response.statusText}`,
    );
  }

  return {
    ok: true,
    provider: "website-webhook",
    identity: { endpoint: webhookUrl, status: response.status },
  };
}

export async function accountRoutes(app: FastifyInstance) {
  const db = getDb();
  app.addHook("onRequest", app.authenticate);

  app.get("/social-accounts", async (request) => {
    const accounts = await db
      .select()
      .from(socialAccounts)
      .where(eq(socialAccounts.workspaceId, request.auth.workspaceId));

    return accounts.map(safeAccount);
  });

  app.post("/social-accounts", async (request, reply) => {
    const input = createAccountSchema.parse(request.body);

    const [account] = await db
      .insert(socialAccounts)
      .values({
        workspaceId: request.auth.workspaceId,
        channel: input.channel,
        externalAccountId: input.externalAccountId,
        displayName: input.displayName ?? null,
        credentials: input.credentials,
        isActive: input.isActive,
      })
      .returning();

    return reply.code(201).send(safeAccount(account));
  });

  app.patch("/social-accounts/:accountId", async (request, reply) => {
    const { accountId } = z
      .object({ accountId: z.string().uuid() })
      .parse(request.params);
    const input = updateAccountSchema.parse(request.body);

    const [current] = await db
      .select()
      .from(socialAccounts)
      .where(and(eq(socialAccounts.id, accountId), eq(socialAccounts.workspaceId, request.auth.workspaceId)))
      .limit(1);

    if (!current) {
      return reply.code(404).send({ error: "social_account_not_found" });
    }

    const [updated] = await db
      .update(socialAccounts)
      .set({
        externalAccountId:
          input.externalAccountId ?? current.externalAccountId,
        displayName:
          input.displayName === undefined
            ? current.displayName
            : input.displayName,
        credentials: input.credentials
          ? { ...current.credentials, ...input.credentials }
          : current.credentials,
        isActive: input.isActive ?? current.isActive,
        updatedAt: new Date(),
      })
      .where(and(eq(socialAccounts.id, accountId), eq(socialAccounts.workspaceId, request.auth.workspaceId)))
      .returning();

    return safeAccount(updated);
  });

  app.delete("/social-accounts/:accountId", async (request, reply) => {
    const { accountId } = z
      .object({ accountId: z.string().uuid() })
      .parse(request.params);

    const [deleted] = await db
      .delete(socialAccounts)
      .where(and(eq(socialAccounts.id, accountId), eq(socialAccounts.workspaceId, request.auth.workspaceId)))
      .returning({ id: socialAccounts.id });

    if (!deleted) {
      return reply.code(404).send({ error: "social_account_not_found" });
    }

    return reply.code(204).send();
  });

  app.post("/social-accounts/:accountId/test", async (request, reply) => {
    const { accountId } = z
      .object({ accountId: z.string().uuid() })
      .parse(request.params);

    const [account] = await db
      .select()
      .from(socialAccounts)
      .where(and(eq(socialAccounts.id, accountId), eq(socialAccounts.workspaceId, request.auth.workspaceId)))
      .limit(1);

    if (!account) {
      return reply.code(404).send({ error: "social_account_not_found" });
    }

    try {
      if (account.channel === "telegram") {
        return await testTelegram(
          account.externalAccountId,
          account.credentials,
        );
      }

      if (account.channel === "website") {
        return await testWebsite(account.credentials);
      }

      return reply.code(501).send({
        ok: false,
        error: "native_connection_not_implemented",
        channel: account.channel,
        fallbackWebhookSupported:
          typeof account.credentials.fallbackWebhookUrl === "string",
      });
    } catch (error) {
      return reply.code(422).send({
        ok: false,
        error: "connection_test_failed",
        message:
          error instanceof Error ? error.message : "Unknown connection error",
      });
    }
  });
}
