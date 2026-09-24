import type { Channel } from "@socialyar/shared";

export type ChannelCredentials = Record<string, unknown>;

export type PublishRequest = {
  publicationId?: string;
  channel: Channel;
  title?: string | null;
  content: string;
  credentials: ChannelCredentials;
  externalAccountId?: string | null;
};

export type PublishResult = {
  externalId: string;
  externalUrl?: string;
  publishedAt: string;
  provider: string;
};

export interface ChannelPublisher {
  publish(request: PublishRequest): Promise<PublishResult>;
}

function requiredString(
  credentials: ChannelCredentials,
  key: string,
): string {
  const value = credentials[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing channel credential: ${key}`);
  }
  return value;
}

async function publishTelegram(
  request: PublishRequest,
): Promise<PublishResult> {
  const botToken = requiredString(request.credentials, "botToken");
  const chatId =
    typeof request.credentials.chatId === "string"
      ? request.credentials.chatId
      : request.externalAccountId;

  if (!chatId) {
    throw new Error("Missing Telegram chatId");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: request.title
          ? `${request.title}\n\n${request.content}`
          : request.content,
        disable_web_page_preview: false,
      }),
    },
  );

  const data = (await response.json()) as {
    ok?: boolean;
    description?: string;
    result?: { message_id?: number; chat?: { username?: string } };
  };

  if (!response.ok || !data.ok || !data.result?.message_id) {
    throw new Error(
      `Telegram publish failed: ${data.description ?? response.statusText}`,
    );
  }

  const username = data.result.chat?.username;

  return {
    externalId: String(data.result.message_id),
    externalUrl: username
      ? `https://t.me/${username}/${data.result.message_id}`
      : undefined,
    publishedAt: new Date().toISOString(),
    provider: "telegram-bot-api",
  };
}

async function publishWebsite(
  request: PublishRequest,
): Promise<PublishResult> {
  const webhookUrl = requiredString(request.credentials, "webhookUrl");
  const token =
    typeof request.credentials.token === "string"
      ? request.credentials.token
      : null;

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(request.publicationId ? { "Idempotency-Key": request.publicationId } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      title: request.title ?? null,
      content: request.content,
      source: "socialyar",
      publicationId: request.publicationId ?? null,
    }),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Website publish failed: ${response.status} ${text.slice(0, 300)}`,
    );
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("Website webhook must return JSON with a published content id");
  }

  if (typeof payload.id !== "string" && typeof payload.id !== "number") {
    throw new Error("Website webhook did not confirm a published content id");
  }

  return {
    externalId: String(payload.id),
    externalUrl:
      typeof payload.url === "string" ? payload.url : undefined,
    publishedAt: new Date().toISOString(),
    provider: "website-webhook",
  };
}

async function publishFallbackWebhook(
  request: PublishRequest,
): Promise<PublishResult> {
  const fallbackWebhookUrl = requiredString(
    request.credentials,
    "fallbackWebhookUrl",
  );

  const response = await fetch(fallbackWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(request.publicationId ? { "Idempotency-Key": request.publicationId } : {}) },
    body: JSON.stringify({
      channel: request.channel,
      title: request.title ?? null,
      content: request.content,
      externalAccountId: request.externalAccountId ?? null,
      source: "socialyar-fallback",
      publicationId: request.publicationId ?? null,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Fallback webhook failed: ${response.status} ${response.statusText}`,
    );
  }

  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  if (typeof body.id !== "string" && typeof body.id !== "number") {
    throw new Error("Fallback webhook did not confirm a published content id");
  }

  return {
    externalId: String(body.id),
    externalUrl:
      typeof body.url === "string" ? body.url : undefined,
    publishedAt: new Date().toISOString(),
    provider: "fallback-webhook",
  };
}

export async function publishToChannel(
  request: PublishRequest,
): Promise<PublishResult> {
  try {
    switch (request.channel) {
      case "telegram":
        return await publishTelegram(request);
      case "website":
        return await publishWebsite(request);
      case "instagram":
      case "x":
      case "linkedin":
        throw new Error(
          `Native ${request.channel} publisher is not configured yet`,
        );
    }
  } catch (primaryError) {
    if (typeof request.credentials.fallbackWebhookUrl === "string") {
      return publishFallbackWebhook(request);
    }

    throw primaryError;
  }
}
