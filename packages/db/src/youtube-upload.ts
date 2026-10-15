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

export async function uploadYoutubeVideo(input: {
  bytes?: Buffer; source?: {size:number;read:(start:number,end:number)=>Promise<Buffer>}; type: string; token: string; session?: string;
  metadata: Record<string, unknown>;
  saveSession: (session: string) => Promise<void>;
  saveProgress: (progress: number, videoId?: string) => Promise<void>;
}, request: typeof fetch = fetch, recoveries = 0): Promise<string> {
  const total = input.source?.size ?? input.bytes?.length ?? 0;
  if (!total) throw new Error("Empty video");
  const headers = { Authorization: `Bearer ${input.token}` };
  let session = input.session;
  let offset = 0;
  const acceptSessionLocation = async (response: Response) => {
    const location = response.headers.get("location");
    if (!location) return;
    const next = youtubeUploadSession(location, session);
    if (next !== session) {
      // Persist before another request. A restart must resume the latest URI.
      await input.saveSession(next);
      session = next;
    }
  };
  if (session) {
    session = youtubeUploadSession(session);
    const probe = await request(session, { method: "PUT", headers: { ...headers, "Content-Length": "0", "Content-Range": `bytes */${total}` }, redirect: "manual", signal: AbortSignal.timeout(30000) });
    if (probe.ok) {
      const data = await googleJson(probe);
      if (!data.id) throw new Error("Upload completion lacks video id");
      await input.saveProgress(100, data.id); return String(data.id);
    }
    if (probe.status !== 308) throw new Error(`Upload session HTTP ${probe.status}; refusing to create a duplicate upload. Verify the channel before creating another item.`);
    offset = acknowledgedOffset(probe, total);
    await acceptSessionLocation(probe);
  } else {
    const response = await request("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
      method: "POST", headers: { ...headers, "Content-Type": "application/json", "X-Upload-Content-Type": input.type, "X-Upload-Content-Length": String(total) },
      body: JSON.stringify(input.metadata), signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) await googleJson(response);
    await acceptSessionLocation(response);
    if (!session) throw new Error("نشانی نشست بارگذاری یوتیوب معتبر نیست.");
  }
  while (offset < total) {
    const end = Math.min(offset + 8 * 1024 * 1024, total);
    const chunk = input.source ? await input.source.read(offset,end) : input.bytes!.subarray(offset,end);
    if(chunk.length!==end-offset)throw new Error("Stored video is incomplete");
    let response: Response;
    try {
      response = await request(session, { method: "PUT", headers: { ...headers, "Content-Type": input.type,
        "Content-Length": String(end - offset), "Content-Range": `bytes ${offset}-${end - 1}/${total}` },
        body: new Uint8Array(chunk), redirect: "manual", signal: AbortSignal.timeout(120000) });
    } catch (error) {
      if (recoveries < 2 && (error instanceof AmbiguousDeliveryError || isConnectionError(error))) {
        // Query the same persisted session on the selected route before sending another byte.
        return uploadYoutubeVideo({ ...input, session }, request, recoveries + 1);
      }
      throw error;
    }
    if (response.status === 308) {
      const acknowledged = acknowledgedOffset(response, total);
      if (acknowledged <= offset || acknowledged > end) throw new Error("Invalid YouTube upload acknowledgment");
      await acceptSessionLocation(response);
      offset = acknowledged; await input.saveProgress(Math.floor(offset * 100 / total));
    } else {
      let data;
      try { data = await googleJson(response); }
      catch (error) {
        if (response.ok && recoveries < 2 && (isConnectionError(error) || error instanceof SyntaxError)) {
          return uploadYoutubeVideo({ ...input, session }, request, recoveries + 1);
        }
        throw error;
      }
      if (!data.id) throw new Error("Upload response lacks video id");
      await input.saveProgress(100, data.id); return String(data.id);
    }
  }
  throw new Error("Upload has no confirmed video id; retry to query this session");
}
