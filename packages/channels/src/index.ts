import { instagramProblems } from "@socialyar/shared";
import type { Channel } from "@socialyar/shared";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type ChannelCredentials = Record<string, unknown>;

export type PublishRequest = {
  fetch?: typeof fetch;
  media?: Blob;
  providerState?: Record<string,unknown>;
  saveProviderState?: (state:Record<string,unknown>)=>Promise<void>;
  publicationId?: string;
  channel: Channel;
  title?: string | null;
  content: string;
  imageUrl?: string | null;
  videoUrl?: string | null;
  instagramType?: string;
  instagramImages?: string[];
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

  const isBale=request.channel==="bale";
  const origin=isBale ? "https://tapi.bale.ai" : "https://api.telegram.org";
  const mediaUrl=request.videoUrl || request.imageUrl;
  const text=request.title && request.content!==request.title ? `${request.title}\n\n${request.content}` : request.content;
  const method=mediaUrl ? request.videoUrl ? "sendVideo" : "sendPhoto" : "sendMessage";
  if(text.length>(mediaUrl ? 1024 : 4096))throw new Error("متن از محدودیت مقصد طولانی‌تر است؛ متن را کوتاه کنید.");
  let body:BodyInit;let headers:Record<string,string>|undefined;
  if(request.media && mediaUrl){ const form=new FormData();form.set("chat_id",chatId);form.set("caption",text);form.set(request.videoUrl?"video":"photo",request.media,request.videoUrl?"content.mp4":"content.jpg");body=form; }
  else { headers={"Content-Type":"application/json"};body=JSON.stringify({chat_id:chatId,...(mediaUrl?{[request.videoUrl?"video":"photo"]:mediaUrl,caption:text}:{text,disable_web_page_preview:false})}); }
  const response=await (request.fetch??fetch)(`${origin}/bot${botToken}/${method}`,{method:"POST",headers,body,signal:AbortSignal.timeout(60000)});

  let data: {
    ok?: boolean;
    description?: string;
    result?: { message_id?: number; chat?: { username?: string } };
  };
  try { data = await response.json(); }
  catch {
    if (response.ok) throw Object.assign(new Error("Telegram delivery is unknown; inspect the destination before retrying"), { code: "DELIVERY_UNKNOWN" });
    throw new Error(`Telegram returned HTTP ${response.status}`);
  }
  if (response.ok && data.ok !== false && !data.result?.message_id) {
    throw Object.assign(new Error("Telegram delivery is unknown; inspect the destination before retrying"), { code: "DELIVERY_UNKNOWN" });
  }

  if (!response.ok || !data.ok || !data.result?.message_id) {
    throw new Error(
      `Telegram publish failed: ${data.description ?? response.statusText}`,
    );
  }

  const username = data.result.chat?.username;

  return {
    externalId: String(data.result.message_id),
    externalUrl: username
      ? `${isBale ? "https://ble.ir" : "https://t.me"}/${username}/${data.result.message_id}`
      : undefined,
    publishedAt: new Date().toISOString(),
    provider: isBale ? "bale-bot-api" : "telegram-bot-api",
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
  const title = request.title?.trim();
  const body = request.content.trim();
  // Public channel posts often use their first line as the title. Do not repeat it.
  const normalized = (value: string) => value.replace(/\s+/g, " ").trim();
  const message = title && normalized(body.split("\n")[0]) !== normalized(title) &&
    !normalized(body).startsWith(normalized(title)) ? `${title}\n\n${body}` : body;
  let media: Blob | null = request.media ?? null;
  const mediaUrl = request.videoUrl || request.imageUrl;
  const isVideo = Boolean(request.videoUrl);
  if (mediaUrl && !media) {
    try {
      let url = new URL(mediaUrl);
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
      const maxBytes = isVideo ? 20_000_000 : 5_000_000;
      if (length > maxBytes) throw new Error(`${isVideo ? "Video" : "Image"} is too large`);
      if (!response.body) throw new Error("Media has no body");
      const reader = response.body.getReader();
      const chunks: ArrayBuffer[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { await reader.cancel(); throw new Error(`${isVideo ? "Video" : "Image"} is too large`); }
        chunks.push(Uint8Array.from(value).buffer as ArrayBuffer);
      }
      const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
      const type = isVideo ?
        (String.fromCharCode(...bytes.slice(4, 8)) === "ftyp" ? "video/mp4" :
          bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3 ? "video/webm" : null) :
        bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? "image/jpeg" :
        bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 ? "image/png" :
        String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP" ? "image/webp" :
        ["GIF87a", "GIF89a"].includes(String.fromCharCode(...bytes.slice(0, 6))) ? "image/gif" : null;
      if (!type) throw new Error(`${isVideo ? "Video" : "Image"} URL did not return a supported file (HTTP ${response.status}, Content-Type: ${declaredType || "unknown"})`);
      media = new Blob([bytes], { type });
    } catch (error) {
      throw new Error(`Eitaa ${isVideo ? "video" : "image"} could not be fetched: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  const form = new FormData();
  form.set("chat_id", chatId);
  form.set(media ? "caption" : "text", message);
  if (media) form.set("file", media, media.type === "video/mp4" ? "news.mp4" : media.type === "video/webm" ? "news.webm" :
    media.type === "image/png" ? "news.png" : media.type === "image/webp" ? "news.webp" : media.type === "image/gif" ? "news.gif" : "news.jpg");
  const response = await fetch(`https://eitaayar.ir/api/${encodeURIComponent(botToken)}/${media ? "sendFile" : "sendMessage"}`, {
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
      imageUrl:request.imageUrl ?? null,videoUrl:request.videoUrl ?? null,
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
  if (request.channel === "youtube") throw new Error("YouTube requires its human-approved upload queue");
  try {
    switch (request.channel) {
      case "bale":
      case "telegram":
        return await publishTelegram(request);
      case "website":
        return await publishWebsite(request);
      case "eitaa":
        return await publishEitaa(request);
      case "instagram":
        return await publishInstagram(request);
      case "x":
      case "linkedin":
        throw new Error(
          `Native ${request.channel} publisher is not configured yet`,
        );
    }
  } catch (primaryError) {
    if (!request.fetch && ["x","linkedin"].includes(request.channel) && typeof request.credentials.fallbackWebhookUrl === "string") {
      return publishFallbackWebhook(request);
    }

    throw primaryError;
  }
}

async function publishInstagram(request:PublishRequest):Promise<PublishResult> {
  const token=requiredString(request.credentials,"accessToken");
  const account=request.externalAccountId;if(!account || !/^\d+$/.test(account))throw new Error("شناسه رسمی حساب حرفه‌ای اینستاگرام را وارد کنید.");
  const version=requiredString(request.credentials,"apiVersion");if(!/^v\d+\.\d+$/.test(version))throw new Error("نسخه API معتبر نیست.");
  const origin=request.credentials.loginType==="facebook" ? "https://graph.facebook.com" : "https://graph.instagram.com";
  const endpoint=`${origin}/${version}`;const send=request.fetch??fetch;
  const headers={Authorization:`Bearer ${token}`};
  const json=async(response:Response)=>{const data=await response.json().catch(()=>null);if(!response.ok || data?.error)throw new Error(data?.error?.message ?? `Instagram HTTP ${response.status}`);if(!data)throw Object.assign(new Error("نتیجه انتشار اینستاگرام نامشخص است؛ مقصد را بررسی کنید."),{code:"DELIVERY_UNKNOWN"});return data;};
  const caption=request.content;
  const type=request.instagramType ?? (request.videoUrl ? "reel" : "image");
  const problems=instagramProblems({instagramType:type,imageUrl:request.imageUrl,videoUrl:request.videoUrl,instagramImages:request.instagramImages},caption);
  if(problems.length)throw new Error(problems.join(" "));
  if(!request.saveProviderState)throw new Error("ذخیره وضعیت آماده‌سازی اینستاگرام ضروری است.");
  let container=typeof request.providerState?.instagramContainerId==="string" ? request.providerState.instagramContainerId : undefined;
  if(!container){
    let children = Array.isArray(request.providerState?.instagramChildren) ? request.providerState.instagramChildren as string[] : [];
    if(type === "carousel") {
      for(let i=children.length;i<request.instagramImages!.length;i++) {
        const child=await json(await send(`${endpoint}/${account}/media`,{method:"POST",headers,body:new URLSearchParams({image_url:request.instagramImages![i],is_carousel_item:"true"}),signal:AbortSignal.timeout(30000)}));
        if(typeof child.id!=="string")throw new Error("شناسه تصویر آلبوم دریافت نشد.");
        children=[...children,child.id];await request.saveProviderState!({instagramChildren:children});
      }
      for(const id of children) {
        const child=await json(await send(`${endpoint}/${id}?fields=status_code`,{headers,signal:AbortSignal.timeout(15000)}));
        if(child.status_code!=="FINISHED")throw new Error(child.status_code==="IN_PROGRESS" ? "اینستاگرام در حال آماده‌سازی ویدئو است؛ بعداً دوباره تلاش کنید." : "آماده‌سازی تصویر آلبوم ناموفق بود.");
      }
    }
    const parameters=new URLSearchParams({caption,...(type === "carousel" ? {media_type:"CAROUSEL",children:children.join(",")} : type === "reel" ? {media_type:"REELS",video_url:request.videoUrl!,...(request.imageUrl?{cover_url:request.imageUrl}:{})} : {image_url:request.imageUrl!})});
    const data=await json(await send(`${endpoint}/${account}/media`,{method:"POST",headers,body:parameters,signal:AbortSignal.timeout(30000)}));
    if(typeof data.id!=="string")throw new Error("شناسه آماده‌سازی اینستاگرام دریافت نشد.");container=data.id;
    if(!request.saveProviderState)throw new Error("ذخیره وضعیت آماده‌سازی اینستاگرام ضروری است.");
    await request.saveProviderState({instagramContainerId:container});
  }
  const state=await json(await send(`${endpoint}/${container}?fields=status_code`,{headers,signal:AbortSignal.timeout(15000)}));
  if(state.status_code==="PUBLISHED")throw Object.assign(new Error("این محتوا در اینستاگرام ثبت شده است؛ مقصد را بررسی کنید."),{code:"DELIVERY_UNKNOWN"});
  if(state.status_code!=="FINISHED")throw new Error(state.status_code==="IN_PROGRESS" ? "اینستاگرام در حال آماده‌سازی ویدئو است؛ بعداً دوباره تلاش کنید." : "آماده‌سازی فایل در اینستاگرام ناموفق بود؛ گزارش مقصد را بررسی کنید.");
  const data=await json(await send(`${endpoint}/${account}/media_publish`,{method:"POST",headers,body:new URLSearchParams({creation_id:container!}),signal:AbortSignal.timeout(30000)}));
  if(typeof data.id!=="string")throw Object.assign(new Error("نتیجه انتشار اینستاگرام نامشخص است؛ مقصد را بررسی کنید."),{code:"DELIVERY_UNKNOWN"});
  let externalUrl:string|undefined;
  try{const remote=await json(await send(`${endpoint}/${data.id}?fields=permalink`,{headers,signal:AbortSignal.timeout(15000)}));externalUrl=remote.permalink;}catch{/* The confirmed media id already prevents duplicate publication. */}
  return {externalId:data.id,externalUrl,publishedAt:new Date().toISOString(),provider:"instagram-graph-api"};
}
