import { setTimeout as delay } from "node:timers/promises";
import { googleJson } from "./youtube";
import { AmbiguousDeliveryError, isConnectionError } from "./publishing-connection";
import { youtubeUploadSession } from "./youtube-upload-session";

function acknowledgedOffset(response: Response, total: number) {
  const range = response.headers.get("range");
  if (!range) return 0;
  const match = range.match(/^bytes=0-(\d+)$/i);
  const offset = match ? Number(match[1]) + 1 : NaN;
  if (!Number.isSafeInteger(offset) || offset <= 0 || offset > total) throw new Error("Invalid YouTube upload acknowledgment");
  return offset;
}
export type YoutubeUploadProgress = { uploadedBytes: number; totalBytes: number; confirmed: boolean };
export type YoutubeUploadRecovery = { attempt: number; reason: "network" | "http" | "response" | "confirmation"; httpStatus?: number; uploadedBytes: number; totalBytes: number };
const resumableStatus = new Set([500, 502, 503, 504]);

export async function uploadYoutubeVideo(input: {
  bytes?: Buffer; source?: {size:number;read:(start:number,end:number)=>Promise<Buffer>}; type: string; token: string; session?: string;
  metadata: Record<string, unknown>;
  saveSession: (session: string) => Promise<void>;
  saveProgress: (progress: number, videoId?: string, details?: YoutubeUploadProgress) => Promise<void>;
  onRecovery?: (event: YoutubeUploadRecovery) => Promise<void>;
  wait?: (ms: number) => Promise<unknown>;
}, request: typeof fetch = fetch): Promise<string> {
  const total = input.source?.size ?? input.bytes?.length ?? 0;
  if (!total) throw new Error("Empty video");
  const headers = { Authorization: `Bearer ${input.token}` };
  let session = input.session ? youtubeUploadSession(input.session) : undefined;
  let offset = 0;
  let probe = Boolean(session);
  let recoveries = 0;
  const progress = async () => input.saveProgress(Math.min(99, Math.floor(offset * 100 / total)), undefined,
    { uploadedBytes: offset, totalBytes: total, confirmed: false });
  const acceptSessionLocation = async (response: Response) => {
    const location = response.headers.get("location");
    if (!location) return;
    const next = youtubeUploadSession(location, session);
    if (next !== session) {
      await input.saveSession(next); // Persist rotated URIs before sending or probing again.
      session = next;
    }
  };
  const recover = async (reason: YoutubeUploadRecovery["reason"], httpStatus?: number) => {
    if (recoveries >= 3) {
      const failure = new Error("ارتباط آپلود پس از چند تلاش برقرار نشد؛ نشست قبلی حفظ شده است. مسیر اتصال را بررسی و همان آیتم را دوباره امتحان کنید.");
      throw Object.assign(failure, { code: "YOUTUBE_UPLOAD_INTERRUPTED" });
    }
    recoveries++;
    await input.onRecovery?.({ attempt: recoveries, reason, ...(httpStatus ? { httpStatus } : {}), uploadedBytes: offset, totalBytes: total });
    await (input.wait ?? delay)(1000 * 2 ** (recoveries - 1));
    probe = true; // Always ask Google for the acknowledged offset; never blindly replay a chunk.
  };
  if (!session) {
    const response = await request("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
      method: "POST", headers: { ...headers, "Content-Type": "application/json", "X-Upload-Content-Type": input.type, "X-Upload-Content-Length": String(total) },
      body: JSON.stringify(input.metadata), signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) await googleJson(response);
    await acceptSessionLocation(response);
    if (!session) throw new Error("نشانی نشست بارگذاری یوتیوب معتبر نیست.");
  }
  for (;;) {
    const querying = probe || offset === total;
    const end = Math.min(offset + 8 * 1024 * 1024, total);
    // Source errors and failed persistence must not be mistaken for a destination outage.
    const chunk = querying ? undefined : input.source ? await input.source.read(offset,end) : input.bytes!.subarray(offset,end);
    if (chunk && chunk.length !== end - offset) throw new Error("Stored video is incomplete");
    let response: Response;
    try {
      response = await request(session, { method: "PUT", headers: { ...headers,
        ...(querying ? { "Content-Length": "0", "Content-Range": `bytes */${total}` } : {
          "Content-Type": input.type, "Content-Length": String(end - offset), "Content-Range": `bytes ${offset}-${end - 1}/${total}` }),
      }, ...(chunk ? { body: new Uint8Array(chunk) } : {}), redirect: "manual", signal: AbortSignal.timeout(querying ? 30000 : 120000) });
    } catch (error) {
      if (!(error instanceof AmbiguousDeliveryError) && !isConnectionError(error)) throw error;
      await recover("network"); continue;
    }
    if (resumableStatus.has(response.status)) {
      const status = response.status; await response.body?.cancel();
      await recover("http", status); continue;
    }
    if (response.status === 308) {
      const acknowledged = acknowledgedOffset(response, total);
      if (acknowledged < offset || !querying && acknowledged > end) throw new Error("Invalid YouTube upload acknowledgment");
      await acceptSessionLocation(response);
      if (querying && acknowledged === total) {
        offset = acknowledged; await progress();
        await recover("confirmation", 308); continue;
      }
      if (!querying && acknowledged === offset) {
        await recover("confirmation", 308); continue;
      }
      offset = acknowledged; await progress(); probe = false;
      continue;
    }
    if (!response.ok && querying) throw new Error(`Upload session HTTP ${response.status}; refusing to create a duplicate upload. Verify the channel before creating another item.`);
    let data;
    try { data = await googleJson(response); }
    catch (error) {
      if (response.ok && (isConnectionError(error) || error instanceof SyntaxError)) {
        await recover("response", response.status); continue;
      }
      throw error;
    }
    if (!data?.id) throw new Error(querying ? "Upload completion lacks video id" : "Upload response lacks video id");
    if (!querying && end !== total) throw new Error("یوتیوب پیش از دریافت همهٔ فایل، پاسخ پایان آپلود داد؛ وضعیت همان نشست را بررسی کنید.");
    await input.saveProgress(100, String(data.id), { uploadedBytes: total, totalBytes: total, confirmed: true });
    return String(data.id);
  }
}
