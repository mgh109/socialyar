import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { decryptSecret, encryptSecret, getDb, reserveResourceQuota, socialAccounts } from "@socialyar/db";

const channelSchema = z.enum(["instagram", "telegram", "website", "x", "linkedin", "eitaa", "youtube", "bale"]);

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
  channel="telegram",
) {
  const botToken =
    typeof credentials.botToken === "string" ? credentials.botToken : "";

  if (!botToken) {
    throw new Error("botToken is required");
  }

  const origin=channel==="bale" ? "https://tapi.bale.ai" : "https://api.telegram.org";
  const botResponse = await fetch(
    `${origin}/bot${botToken}/getMe`,
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
    `${origin}/bot${botToken}/getChat?chat_id=${encodeURIComponent(chatId)}`,
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
    provider: channel==="bale" ? "bale-bot-api" : "telegram-bot-api",
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
    if (input.channel === "youtube") return reply.code(400).send({ error: "youtube_requires_google_oauth" });
    if (["eitaa","bale"].includes(input.channel) && (typeof input.credentials.botToken !== "string" || !input.credentials.botToken || typeof input.credentials.chatId !== "string" || !input.credentials.chatId)) {
      return reply.code(400).send({ error: input.channel === "bale" ? "توکن و شناسه کانال بله لازم است." : "eitaa_token_and_chat_required" });
    }
    if(input.channel==="instagram" && (typeof input.credentials.accessToken!=="string" || !input.credentials.accessToken || !/^v\d+\.\d+$/.test(String(input.credentials.apiVersion)) || !/^\d+$/.test(input.externalAccountId)))return reply.code(400).send({error:"شناسه رسمی، توکن انتشار و نسخه API اینستاگرام را وارد کنید."});
    const credentials = input.channel === "instagram" ? {apiVersion:input.credentials.apiVersion,loginType:input.credentials.loginType,accessTokenEnc:encryptSecret(input.credentials.accessToken as string)} : ["eitaa","bale"].includes(input.channel)
      ? { chatId: input.credentials.chatId, botTokenEnc: encryptSecret(input.credentials.botToken as string) }
      : input.credentials;

    const account = await db.transaction(async (tx) => {
      await reserveResourceQuota(tx, request.auth.workspaceId, "channels");
      const [created] = await tx
      .insert(socialAccounts)
      .values({
        workspaceId: request.auth.workspaceId,
        channel: input.channel,
        externalAccountId: input.externalAccountId,
        displayName: input.displayName ?? null,
        credentials,
        isActive: input.isActive,
      })
      .returning();

      return created;
    });
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

    if (current.channel === "youtube" && (input.credentials || input.externalAccountId || input.isActive)) return reply.code(400).send({ error: "use_youtube_oauth_routes" });
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
          ? ["eitaa","bale"].includes(current.channel)
            ? { chatId: input.credentials.chatId ?? current.credentials.chatId,
                botTokenEnc: typeof input.credentials.botToken === "string"
                  ? encryptSecret(input.credentials.botToken) : current.credentials.botTokenEnc }
            : current.channel === "instagram" ? { ...current.credentials,apiVersion:input.credentials.apiVersion ?? current.credentials.apiVersion,loginType:input.credentials.loginType ?? current.credentials.loginType,...(typeof input.credentials.accessToken==="string" ? {accessTokenEnc:encryptSecret(input.credentials.accessToken)} : {}) } : { ...current.credentials, ...input.credentials }
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

    const [account] = await db.select().from(socialAccounts).where(and(eq(socialAccounts.id, accountId), eq(socialAccounts.workspaceId, request.auth.workspaceId)));
    if (account?.channel === "youtube") return reply.code(400).send({ error: "use_youtube_disconnect_to_revoke_google_access" });

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
      if (account.channel === "telegram" || account.channel === "bale") {
        return await testTelegram(
          account.externalAccountId,
          typeof account.credentials.botTokenEnc==="string" ? {...account.credentials,botToken:decryptSecret(account.credentials.botTokenEnc)} : account.credentials,
          account.channel,
        );
      }

      if(account.channel==="instagram"){
        const token=typeof account.credentials.accessTokenEnc==="string" ? decryptSecret(account.credentials.accessTokenEnc) : "";
        if(!token)throw new Error("توکن رسمی اینستاگرام ثبت نشده است.");
        const origin=account.credentials.loginType==="facebook" ? "https://graph.facebook.com" : "https://graph.instagram.com";
        const version=String(account.credentials.apiVersion);if(!/^v\d+\.\d+$/.test(version) || !/^\d+$/.test(account.externalAccountId))throw new Error("تنظیم اتصال اینستاگرام معتبر نیست.");
        const r=await fetch(`${origin}/${version}/${account.externalAccountId}?fields=id,username`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});const data=await r.json();if(!r.ok || !data.id)throw new Error(data.error?.message ?? "اتصال رسمی ناموفق بود.");return {ok:true,provider:"instagram-graph-api",identity:{username:data.username},publishingPermissionVerified:false};
      }
      if (account.channel === "website") {
        return await testWebsite(account.credentials);
      }
      if (account.channel === "eitaa") {
        const token = typeof account.credentials.botTokenEnc === "string"
          ? decryptSecret(account.credentials.botTokenEnc) : "";
        if (!token) throw new Error("توکن ایتا ثبت نشده است");
        const response = await fetch(`https://eitaayar.ir/api/${encodeURIComponent(token)}/getMe`, { signal: AbortSignal.timeout(15000) });
        const data = await response.json() as { ok?: boolean; description?: string };
        if (!response.ok || !data.ok) throw new Error(data.description ?? "Eitaa connection failed");
        return { ok: true, provider: "eitaayar" };
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
