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
test("a rotated session must be persisted before reading or sending the next bytes", async () => {
  let calls = 0; let reads = 0;
  await assert.rejects(uploadYoutubeVideo(input({ session, bytes: undefined,
    source: { size: 16, read: async () => { reads++; return Buffer.alloc(16); } },
    saveSession: async () => { throw new Error("DB unavailable"); },
  }), (async () => {
    calls++;
    return new Response(null, { status: 308, headers: { location: `${session}-rotated` } });
  }) as typeof fetch), /DB unavailable/);
  assert.equal(calls, 1); assert.equal(reads, 0);
});
test("rotated upload locations cannot send credentials outside Google's upload endpoint", async () => {
  for (const location of ["https://untrusted.example/steal", "http://www.googleapis.com/upload/youtube/v3/videos?upload_id=test",
    "https://user:password@www.googleapis.com/upload/youtube/v3/videos?upload_id=test",
    "https://www.googleapis.com:8443/upload/youtube/v3/videos?upload_id=test",
    "https://www.googleapis.com/youtube/v3/videos?upload_id=test", `${session}#fragment`]) {
    let calls = 0; let persisted = false;
    await assert.rejects(uploadYoutubeVideo(input({ session, saveSession: async () => { persisted = true; } }), (async () => {
      calls++; return new Response(null, { status: 308, headers: { location } });
    }) as typeof fetch), /نشانی نشست/);
    assert.equal(calls, 1); assert.equal(persisted, false);
  }
});
test("a lost final response after session rotation probes the latest URI without a new upload", async () => {
  const rotated = `${session}-rotated`; const calls: string[] = [];
  const request = (async (url, options) => {
    calls.push(`${String(url)} ${new Headers(options?.headers).get("Content-Range")}`);
    if (calls.length === 1) return new Response(null, { status: 308, headers: { location: rotated, range: "bytes=0-7" } });
    assert.equal(String(url), rotated);
    if (calls.length === 2) throw Object.assign(new Error("Connection lost"), { code: "ECONNRESET" });
    assert.equal(new Headers(options?.headers).get("Content-Range"), "bytes */16");
    return json({ id: "confirmed-after-rotation" });
  }) as typeof fetch;
  assert.equal(await uploadYoutubeVideo(input({ session }), request), "confirmed-after-rotation");
  assert.equal(calls.length, 3);
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

test("a large file source uploads in bounded chunks and resumes at the server acknowledged offset",async()=>{
  const total=350_580_000;const resumeAt=8*1024*1024;const reads:Array<[number,number]>=[];
  const source={size:total,read:async(start:number,end:number)=>{assert.ok(end-start<=8*1024*1024);reads.push([start,end]);return Buffer.alloc(end-start);}};
  let probe=true;
  const request=(async(_url:unknown,options:RequestInit)=>{
    if(probe){probe=false;assert.equal((options.headers as any)["Content-Range"],`bytes */${total}`);return new Response(null,{status:308,headers:{range:`bytes=0-${resumeAt-1}`}});}
    const range=String((options.headers as any)["Content-Range"]);const [,start,end]=range.match(/bytes (\d+)-(\d+)\//)!;
    assert.equal((options.body as Uint8Array).byteLength,Number(end)-Number(start)+1);
    return Number(end)+1===total?json({id:"large-video"}):new Response(null,{status:308,headers:{range:`bytes=0-${end}`}});
  }) as typeof fetch;
  assert.equal(await uploadYoutubeVideo({...input(),bytes:undefined,source,session},request),"large-video");
  assert.equal(reads[0][0],resumeAt);assert.equal(reads.at(-1)![1],total);
});

test("temporary upload and probe HTTP failures recover the same session from acknowledged bytes",async()=>{
  const chunk=8*1024*1024,total=chunk+16;let calls=0,posts=0;const ranges:string[]=[],reads:number[]=[],recoveries:any[]=[],waits:number[]=[],progress:number[]=[];
  const request=(async(_url,init)=>{
    if(init?.method==="POST"){posts++;return new Response(null,{headers:{location:session}});}
    const range=new Headers(init?.headers).get("Content-Range")!;ranges.push(range);calls++;
    if(calls===1)return json({error:{message:"service unavailable"}},503);
    if(calls===2)return json({error:{message:"upstream unavailable"}},502);
    if(calls===3)return new Response(null,{status:308,headers:{range:`bytes=0-${chunk-1}`}});
    assert.equal(range,`bytes ${chunk}-${total-1}/${total}`);return json({id:"resumed-same-session"},201);
  }) as typeof fetch;
  const id=await uploadYoutubeVideo({type:"video/mp4",token:"fake",metadata:{},source:{size:total,read:async(start,end)=>{reads.push(start);return Buffer.alloc(end-start);}},saveSession:async()=>{},saveProgress:async(p)=>{progress.push(p);},onRecovery:async(event)=>{recoveries.push(event);},wait:async(ms)=>{waits.push(ms);}},request);
  assert.equal(id,"resumed-same-session");assert.equal(posts,1);assert.deepEqual(reads,[0,chunk]);assert.deepEqual(ranges,[`bytes 0-${chunk-1}/${total}`,`bytes */${total}`,`bytes */${total}`,`bytes ${chunk}-${total-1}/${total}`]);assert.deepEqual(waits,[1000,2000]);assert.deepEqual(recoveries.map(e=>e.httpStatus),[503,502]);assert.equal(progress.at(-1),100);
});
test("an upload acknowledged in full stays below 100 until Google returns the completed video",async()=>{
  const progress:number[]=[];let calls=0;
  const request=(async(_url,init)=>{
    calls++;const range=new Headers(init?.headers).get("Content-Range");
    if(calls===1){assert.equal(range,"bytes */16");return new Response(null,{status:308,headers:{range:"bytes=0-15"}});}
    assert.equal(range,"bytes */16");assert.equal(init?.body,undefined);return json({id:"confirmed"},201);
  }) as typeof fetch;
  assert.equal(await uploadYoutubeVideo(input({session,wait:async()=>{},saveProgress:async(p:number)=>{progress.push(p);}}),request),"confirmed");assert.deepEqual(progress,[99,100]);
});
test("persistent transient upload outage is bounded and never starts another upload",async()=>{
  let calls=0;
  await assert.rejects(uploadYoutubeVideo(input({session,wait:async()=>{}}),(async(_url,init)=>{calls++;assert.equal(init?.method,"PUT");return json({},503);}) as typeof fetch),(error:any)=>error.code==="YOUTUBE_UPLOAD_INTERRUPTED");
  assert.equal(calls,4);
});
test("early completion cannot confirm an unsent remainder",async()=>{
  const total=8*1024*1024+16;let confirmed=false;
  await assert.rejects(uploadYoutubeVideo(input({session,bytes:Buffer.alloc(total),saveProgress:async(_p:number,id?:string)=>{if(id)confirmed=true;}}),(async(_url,init)=>new Headers(init?.headers).get("Content-Range")!.startsWith("bytes */") ? new Response(null,{status:308}) : json({id:"premature"},201)) as typeof fetch),/پیش از دریافت همه/);
  assert.equal(confirmed,false);
});
