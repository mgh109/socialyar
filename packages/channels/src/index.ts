import type { Channel } from "@socialyar/shared";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type ChannelCredentials = Record<string, unknown>;

export type PublishRequest = {
  publicationId?: string;
  channel: Channel;
  title?: string | null;
  content: string;
  imageUrl?: string | null;
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

async function publishEitaa(request: PublishRequest): Promise<PublishResult> {
  const botToken = requiredString(request.credentials, "botToken");
  const chatId = requiredString(request.credentials, "chatId");
  const message = request.title ? `${request.title}\n\n${request.content}` : request.content;
  let image: Blob | null = null;
  if (request.imageUrl) {
    try {
      let url = new URL(request.imageUrl);
      let response: Response | undefined;
      for (let redirects = 0; redirects <= 3; redirects++) {
        if (url.protocol !== "https:" || url.username || url.password || url.port || isIP(url.hostname)) throw new Error("Invalid image URL");
        const addresses = await lookup(url.hostname, { all: true });
        if (!addresses.length || addresses.some(({ address, family }) => family !== 4 ||
          /^(?:0\.|10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|198\.18\.|198\.19\.|22[4-9]\.|23\d\.|24\d\.|25\d\.)/.test(address))) {
          throw new Error("Image host is not public IPv4");
        }
        response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10000),
          headers: url.hostname === "eitaa.com" ? {
            "User-Agent": "Mozilla/5.0 (compatible; HoorNewsBot/1.0)", Referer: "https://eitaa.com/",
          } : {} });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get("location");
        if (!location || redirects === 3) throw new Error("Too many image redirects");
        url = new URL(location, url);
      }
      if (!response) throw new Error("Image response missing");
      const length = Number(response.headers.get("content-length") ?? 0);
      const declaredType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
      if (!response.ok) throw new Error(`Image server returned HTTP ${response.status}`);
      if (length > 5_000_000) throw new Error("Image is too large");
      if (!response.body) throw new Error("Image has no body");
      const reader = response.body.getReader();
      const chunks: ArrayBuffer[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 5_000_000) { await reader.cancel(); throw new Error("Image is too large"); }
        chunks.push(Uint8Array.from(value).buffer as ArrayBuffer);
      }
      const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
      const type = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? "image/jpeg" :
        bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 ? "image/png" :
        String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP" ? "image/webp" :
        ["GIF87a", "GIF89a"].includes(String.fromCharCode(...bytes.slice(0, 6))) ? "image/gif" : null;
      if (!type) throw new Error(`Image URL did not return a supported image (HTTP ${response.status}, Content-Type: ${declaredType || "unknown"})`);
      image = new Blob([bytes], { type });
    } catch (error) {
      throw new Error(`Eitaa image could not be fetched: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  const form = new FormData();
  form.set("chat_id", chatId);
  form.set(image ? "caption" : "text", message);
  if (image) form.set("file", image, image.type === "image/png" ? "news.png" : image.type === "image/webp" ? "news.webp" : image.type === "image/gif" ? "news.gif" : "news.jpg");
  const response = await fetch(`https://eitaayar.ir/api/${encodeURIComponent(botToken)}/${image ? "sendFile" : "sendMessage"}`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(20000),
  });
  const data = await response.json() as { ok?: boolean; description?: string; result?: { message_id?: number; chat?: { username?: string } } };
  if (!response.ok || !data.ok || !data.result?.message_id) {
    throw new Error(`Eitaa publish failed: ${data.description ?? response.statusText}`);
  }
  const username = data.result.chat?.username ?? chatId.replace(/^@/, "");
  return { externalId: String(data.result.message_id),
    externalUrl: /^[a-zA-Z0-9_]+$/.test(username) ? `https://eitaa.com/${username}/${data.result.message_id}` : undefined,
    publishedAt: new Date().toISOString(), provider: "eitaayar" };
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
      case "eitaa":
        return await publishEitaa(request);
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
