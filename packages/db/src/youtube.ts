import { YOUTUBE_COVER_MAX_BYTES } from "@socialyar/shared";
import { and, eq } from "drizzle-orm";
import { getDb } from "./client";
import { socialAccounts } from "./schema";
import { decryptSecret, encryptSecret } from "./secrets";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, writeFile, open, link, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";

const mediaRoot = () => process.env.YOUTUBE_MEDIA_DIR || fileURLToPath(new URL("../../../uploads/youtube/", import.meta.url));

export function youtubeMediaType(bytes: Buffer): "video/mp4" | "video/webm" | "image/jpeg" | "image/png" {
  if (bytes.subarray(4, 8).toString() === "ftyp") return "video/mp4";
  if (bytes.subarray(0, 4).equals(Buffer.from([26,69,223,163]))) return "video/webm";
  if (bytes[0] === 255 && bytes[1] === 216) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  throw new Error("Unsupported media file; use MP4, WebM, JPEG or PNG");
}
export async function storeYoutubeMedia(workspaceId: string, bytes: Buffer) {
  const type = youtubeMediaType(bytes);
  if (bytes.length > (type.startsWith("image/") ? YOUTUBE_COVER_MAX_BYTES : 250_000_000)) throw new Error("Media exceeds upload limit");
  const mediaId = createHash("sha256").update(bytes).digest("hex");
  const directory = resolve(mediaRoot(), workspaceId);
  await mkdir(directory, { recursive: true });
  try { await writeFile(resolve(directory, mediaId), bytes, { flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return { mediaId, kind: type.startsWith("video/") ? "video" : "image" };
}
/** Limit for server-side collection downloads; manual browser uploads keep their own cap. */
export const youtubeVideoLimit = () => {
  const value=Number(process.env.YOUTUBE_VIDEO_MAX_BYTES ?? 1_000_000_000);
  return Number.isSafeInteger(value) && value>0 && value<=10_000_000_000 ? value : 1_000_000_000;
};
export async function youtubeMediaFile(workspaceId: string, mediaId: string, kind?: "video" | "image") {
  if (!/^[a-f0-9]{64}$/.test(mediaId)) throw new Error("Invalid media id");
  const path=resolve(mediaRoot(),workspaceId,mediaId); const handle=await open(path,"r");
  try {
    const header=Buffer.alloc(32);const {bytesRead}=await handle.read(header,0,32,0);
    const type=youtubeMediaType(header.subarray(0,bytesRead));
    if(kind && !type.startsWith(`${kind}/`))throw new Error(`Expected ${kind} file`);
    return {path,type,size:(await handle.stat()).size};
  } finally {await handle.close();}
}
/** Reads only one bounded upload chunk at a time, including on session recovery. */
export function youtubeFileSource(file: {path:string;size:number}) {
  return {size:file.size,read:async(start:number,end:number)=>{
    if(start<0 || end>file.size || end<=start || end-start>8*1024*1024)throw new Error("Invalid video chunk");
    const handle=await open(file.path,"r");
    try {
      const bytes=Buffer.alloc(end-start);let offset=0;
      while(offset<bytes.length){const result=await handle.read(bytes,offset,bytes.length-offset,start+offset);if(!result.bytesRead)throw new Error("Stored video is incomplete");offset+=result.bytesRead;}
      return bytes;
    } finally {await handle.close();}
  }};
}
/** Content-addressed storage with bounded memory and cleanup of interrupted downloads. */
export async function storeYoutubeVideoStream(workspaceId:string, chunks:AsyncIterable<Uint8Array>, limit=youtubeVideoLimit()) {
  const directory=resolve(mediaRoot(),workspaceId);await mkdir(directory,{recursive:true});
  const temporary=resolve(directory,`.download-${randomUUID()}`);const handle=await open(temporary,"wx",0o600);
  let size=0;let header=Buffer.alloc(0);const hash=createHash("sha256");
  try {
    for await(const chunk of chunks){
      size+=chunk.length;if(size>limit)throw new Error(`حجم ویدئو بیش از سقف ${Math.floor(limit/1_000_000)} مگابایت است.`);
      if(header.length<32)header=Buffer.concat([header,chunk.subarray(0,32-header.length)]);
      hash.update(chunk);await handle.writeFile(chunk);
    }
    const type=youtubeMediaType(header);if(!type.startsWith("video/"))throw new Error("لینک به فایل ویدئو نمی‌رسد.");
    const mediaId=hash.digest("hex");await handle.close();
    try{await link(temporary,resolve(directory,mediaId));}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
    return {mediaId,kind:"video" as const,type,size};
  }finally{await handle.close().catch(()=>{});await unlink(temporary).catch(()=>{});}
}
export async function readYoutubeMedia(workspaceId: string, mediaId: string, kind?: "video" | "image") {
  if (!/^[a-f0-9]{64}$/.test(mediaId)) throw new Error("Invalid media id");
  const bytes = await readFile(resolve(mediaRoot(), workspaceId, mediaId));
  const type = youtubeMediaType(bytes);
  if (kind && !type.startsWith(`${kind}/`)) throw new Error(`Expected ${kind} file`);
  return { bytes, type };
}

export function youtubeConfig() {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const redirectUri = process.env.YOUTUBE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) throw new Error("YouTube OAuth is not configured on the server");
  return { clientId, clientSecret, redirectUri, privateOnly: process.env.YOUTUBE_PROJECT_VERIFIED !== "true" };
}

export async function googleJson(response: Response): Promise<any> {
  const data = await response.json();
  if (!response.ok) throw new Error(`Google HTTP ${response.status}: ${data.error?.message ?? data.error_description ?? data.error ?? "request failed"}`);
  return data;
}

export async function youtubeToken(accountId: string, workspaceId: string, request: typeof fetch = fetch) {
  const db = getDb();
  const [account] = await db.select().from(socialAccounts).where(and(eq(socialAccounts.id, accountId),
    eq(socialAccounts.workspaceId, workspaceId), eq(socialAccounts.channel, "youtube"), eq(socialAccounts.isActive, true)));
  if (!account) throw new Error("YouTube channel is disconnected");
  const config = youtubeConfig();
  // Refresh for each worker execution; refresh tokens never leave the server.
  const data = await googleJson(await request("https://oauth2.googleapis.com/token", {
    method: "POST", body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret,
      grant_type: "refresh_token", refresh_token: decryptSecret(String(account.credentials.refreshTokenEnc)) }),
    signal: AbortSignal.timeout(15000),
  }));
  await db.update(socialAccounts).set({ credentials: { ...account.credentials,
    accessTokenEnc: encryptSecret(data.access_token), expiresAt: Date.now() + data.expires_in * 1000 }, updatedAt: new Date() })
    .where(eq(socialAccounts.id, account.id));
  return { token: String(data.access_token), account, privateOnly: config.privateOnly };
}

// Reject private hosts and redirects before fetching untrusted workflow media.
export async function fetchYoutubeMedia(raw: string, maxBytes: number, kind: "video" | "image") {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("Media must use a public HTTPS URL");
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address, family }) => family !== 4 ||
    /^(?:0\.|10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|198\.(?:18|19)\.|22[4-9]\.|23\d\.|24\d\.|25\d\.)/.test(address))) throw new Error("Media host must be public IPv4");
  // Pin the checked DNS address so a second lookup cannot redirect the connection to a private host.
  const response = await new Promise<IncomingMessage>((accept, reject) => {
    const request = httpsRequest(url, { family: 4, signal: AbortSignal.timeout(120000), lookup: (_hostname, _options, callback) => {
      callback(null, addresses[0].address, 4);
    } }, accept);
    request.on("error", reject); request.end();
  });
  if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
    response.destroy(); throw new Error(`Media HTTP ${response.statusCode}; redirects are not allowed`);
  }
  if (Number(response.headers["content-length"]) > maxBytes) { response.destroy(); throw new Error("Media exceeds upload limit"); }
  const parts: Uint8Array[] = []; let size = 0;
  for await (const part of response) {
    size += part.length;
    if (size > maxBytes) { response.destroy(); throw new Error("Media exceeds upload limit"); }
    parts.push(part);
  }
  const bytes = Buffer.concat(parts);
  const type = youtubeMediaType(bytes);
  if (!type.startsWith(`${kind}/`)) throw new Error(`Expected ${kind} file`);
  return { bytes, type };
}
