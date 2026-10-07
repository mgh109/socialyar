import { and, eq } from "drizzle-orm";
import { getDb } from "./client";
import { socialAccounts } from "./schema";
import { decryptSecret, encryptSecret } from "./secrets";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
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
  if (bytes.length > (type.startsWith("image/") ? 2_000_000 : 250_000_000)) throw new Error("Media exceeds upload limit");
  const mediaId = createHash("sha256").update(bytes).digest("hex");
  const directory = resolve(mediaRoot(), workspaceId);
  await mkdir(directory, { recursive: true });
  try { await writeFile(resolve(directory, mediaId), bytes, { flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return { mediaId, kind: type.startsWith("video/") ? "video" : "image" };
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
