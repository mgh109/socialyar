import { test } from "node:test";
import assert from "node:assert/strict";
import { uploadYoutubeVideo, youtubeMediaType, fetchYoutubeMedia, storeYoutubeMedia, readYoutubeMedia } from "@socialyar/db";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeYoutube } from "./youtube";

const session = "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=test";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
test("unapproved, rejected, cancelled and published items never start uploading", async () => {
  for (const item of [
    { status: "queued", approvedAt: null }, { status: "uploading", approvedAt: null },
    { status: "rejected", approvedAt: new Date() }, { status: "cancelled", approvedAt: new Date() },
    { status: "published", approvedAt: new Date() },
  ]) {
    let claimed = false;
    const db = { select: () => ({ from: () => ({ where: async () => [item] }) }), update: () => { claimed = true; throw new Error("Unexpected claim"); } };
    await executeYoutube("00000000-0000-0000-0000-000000000001", db as any);
    assert.equal(claimed, false, `must not claim ${item.status}`);
  }
});
function input(overrides: Record<string, unknown> = {}) {
  return { bytes: Buffer.alloc(16), type: "video/mp4", token: "test-token", metadata: { status: { privacyStatus: "private" } },
    saveSession: async (_: string) => {}, saveProgress: async (_: number, __?: string) => {}, ...overrides };
}
test("persist session before upload bytes and save confirmed id", async () => {
  const events: string[] = [];
  const request = (async (_url: unknown, options: RequestInit) => {
    if (options.method === "POST") return new Response(null, { status: 200, headers: { location: session } });
    events.push("bytes"); return json({ id: "video-1" });
  }) as typeof fetch;
  assert.equal(await uploadYoutubeVideo(input({ saveSession: async () => { events.push("persist"); },
    saveProgress: async (percent: number, id: string) => { assert.equal(percent, 100); assert.equal(id, "video-1"); } }), request), "video-1");
  assert.deepEqual(events, ["persist", "bytes"]);
});
test("lost final response resumes the completed session without sending bytes", async () => {
  let calls = 0;
  const request = (async (_url: unknown, options: RequestInit) => {
    calls++; assert.equal(options.method, "PUT"); assert.equal((options.headers as any)["Content-Range"], "bytes */16");
    assert.equal(options.body, undefined); return json({ id: "already-uploaded" });
  }) as typeof fetch;
  assert.equal(await uploadYoutubeVideo(input({ session }), request), "already-uploaded"); assert.equal(calls, 1);
});
test("resume acknowledged bytes instead of restarting", async () => {
  let calls = 0;
  const request = (async (_url: unknown, options: RequestInit) => {
    assert.equal(options.method, "PUT");
    if (++calls === 1) return new Response(null, { status: 308, headers: { range: "bytes=0-7" } });
    assert.equal((options.headers as any)["Content-Range"], "bytes 8-15/16");
    assert.equal((options.body as Uint8Array).length, 8); return json({ id: "resumed" });
  }) as typeof fetch;
  assert.equal(await uploadYoutubeVideo(input({ session }), request), "resumed");
});
test("expired session fails without creating a duplicate upload", async () => {
  let calls = 0;
  await assert.rejects(uploadYoutubeVideo(input({ session }), (async (_url: unknown, options: RequestInit) => {
    calls++; assert.equal(options.method, "PUT"); return new Response(null, { status: 404 });
  }) as typeof fetch), /refusing to create a duplicate/); assert.equal(calls, 1);
});
test("failed session persistence prevents sending video bytes", async () => {
  let calls = 0;
  await assert.rejects(uploadYoutubeVideo(input({ saveSession: async () => { throw new Error("DB unavailable"); } }), (async () => {
    calls++; return new Response(null, { headers: { location: session } });
  }) as typeof fetch), /DB unavailable/); assert.equal(calls, 1);
});
test("upload HTTP failure is surfaced and missing ids never count as success", async () => {
  await assert.rejects(uploadYoutubeVideo(input({ session }), (async () => json({ error: { message: "Quota exceeded" } }, 403)) as typeof fetch), /HTTP 403/);
  await assert.rejects(uploadYoutubeVideo(input({ session }), (async () => json({})) as typeof fetch), /lacks video id/);
});
test("media URLs reject private hosts and non-HTTPS protocols", async () => {
  await assert.rejects(fetchYoutubeMedia("http://example.com/v.mp4", 100, "video"), /public HTTPS/);
  await assert.rejects(fetchYoutubeMedia("https://127.0.0.1/v.mp4", 100, "video"), /public IPv4/);
  assert.throws(() => youtubeMediaType(Buffer.from("<html>login</html>")), /Unsupported/);
});
test("media snapshots deduplicate content and enforce workspace isolation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hoor-youtube-test-"));
  const before = process.env.YOUTUBE_MEDIA_DIR; process.env.YOUTUBE_MEDIA_DIR = directory;
  try {
    const bytes = Buffer.from([0,0,0,16,102,116,121,112,0,0,0,0]);
    const first = await storeYoutubeMedia("workspace-a", bytes); const second = await storeYoutubeMedia("workspace-a", bytes);
    assert.equal(first.mediaId, second.mediaId);
    assert.deepEqual((await readYoutubeMedia("workspace-a", first.mediaId, "video")).bytes, bytes);
    await assert.rejects(readYoutubeMedia("workspace-b", first.mediaId));
    await assert.rejects(readYoutubeMedia("workspace-a", "../../outside"), /Invalid media id/);
    await assert.rejects(readYoutubeMedia("workspace-a", first.mediaId, "image"), /Expected image/);
  } finally {
    if (before === undefined) delete process.env.YOUTUBE_MEDIA_DIR; else process.env.YOUTUBE_MEDIA_DIR = before;
    await rm(directory, { recursive: true });
  }
});
