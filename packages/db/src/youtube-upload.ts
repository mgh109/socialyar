import { googleJson } from "./youtube";
import { AmbiguousDeliveryError, isConnectionError } from "./publishing-connection";

export async function uploadYoutubeVideo(input: {
  bytes: Buffer; type: string; token: string; session?: string;
  metadata: Record<string, unknown>;
  saveSession: (session: string) => Promise<void>;
  saveProgress: (progress: number, videoId?: string) => Promise<void>;
}, request: typeof fetch = fetch, recoveries = 0): Promise<string> {
  const total = input.bytes.length;
  if (!total) throw new Error("Empty video");
  const headers = { Authorization: `Bearer ${input.token}` };
  let session = input.session;
  let offset = 0;
  if (session) {
    if (new URL(session).hostname !== "www.googleapis.com" || new URL(session).protocol !== "https:") throw new Error("Invalid Google upload session");
    const probe = await request(session, { method: "PUT", headers: { ...headers, "Content-Length": "0", "Content-Range": `bytes */${total}` }, signal: AbortSignal.timeout(30000) });
    if (probe.ok) {
      const data = await googleJson(probe);
      if (!data.id) throw new Error("Upload completion lacks video id");
      await input.saveProgress(100, data.id); return String(data.id);
    }
    if (probe.status !== 308) throw new Error(`Upload session HTTP ${probe.status}; refusing to create a duplicate upload. Verify the channel before creating another item.`);
    offset = Number(probe.headers.get("range")?.match(/-(\d+)$/)?.[1] ?? -1) + 1;
  } else {
    const response = await request("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
      method: "POST", headers: { ...headers, "Content-Type": "application/json", "X-Upload-Content-Type": input.type, "X-Upload-Content-Length": String(total) },
      body: JSON.stringify(input.metadata), signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) await googleJson(response);
    session = response.headers.get("location") ?? undefined;
    if (!session || new URL(session).hostname !== "www.googleapis.com" || new URL(session).protocol !== "https:") throw new Error("Invalid Google upload session");
    await input.saveSession(session);
  }
  while (offset < total) {
    const end = Math.min(offset + 8 * 1024 * 1024, total);
    let response: Response;
    try {
      response = await request(session, { method: "PUT", headers: { ...headers, "Content-Type": input.type,
        "Content-Length": String(end - offset), "Content-Range": `bytes ${offset}-${end - 1}/${total}` },
        body: new Uint8Array(input.bytes.subarray(offset, end)), signal: AbortSignal.timeout(120000) });
    } catch (error) {
      if (recoveries < 2 && (error instanceof AmbiguousDeliveryError || isConnectionError(error))) {
        // Query the same persisted session on the selected route before sending another byte.
        return uploadYoutubeVideo({ ...input, session }, request, recoveries + 1);
      }
      throw error;
    }
    if (response.status === 308) {
      const acknowledged = Number(response.headers.get("range")?.match(/-(\d+)$/)?.[1] ?? -1) + 1;
      if (acknowledged <= offset || acknowledged > total) throw new Error("Invalid YouTube upload acknowledgment");
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
