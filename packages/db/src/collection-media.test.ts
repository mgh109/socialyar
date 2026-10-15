import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent } from "undici";
import { requestPinnedMedia } from "./collection-media";

test("pinned downloads retain the virtual host and encoded Persian path instead of hitting the IP default site",async()=>{
  const agent=new MockAgent();agent.disableNetConnect();
  const url=new URL("https://files.hoorpluse.ir/مدرسه حفظ- جزء 30/03 tohid.mp4");
  agent.get("https://203.0.113.10").intercept({path:url.pathname,method:"GET",headers:{host:"files.hoorpluse.ir",range:"bytes=0-4095"}})
    .reply(206,Buffer.from("00000018667479706d703432000000006d7034326d703431","hex"),{headers:{"content-type":"video/mp4"}});
  try {
    const response=await requestPinnedMedia(url,"203.0.113.10",agent,AbortSignal.timeout(5000),true);
    assert.equal(response.statusCode,206);
    assert.equal(Buffer.from(await response.body.arrayBuffer()).subarray(4,8).toString(),"ftyp");
    agent.assertNoPendingInterceptors();
  } finally {await agent.close();}
});

test("redirects are returned to the downloader so the next host can be revalidated",async()=>{
  const agent=new MockAgent();agent.disableNetConnect();
  agent.get("https://203.0.113.10").intercept({path:"/video.mp4",method:"GET",headers:{host:"files.example.com"}})
    .reply(302,"",{headers:{location:"https://other.example.com/video.mp4"}});
  try {
    const response=await requestPinnedMedia(new URL("https://files.example.com/video.mp4"),"203.0.113.10",agent,AbortSignal.timeout(5000),false);
    assert.equal(response.statusCode,302);
    assert.equal(response.headers.location,"https://other.example.com/video.mp4");
    await response.body.dump();
    agent.assertNoPendingInterceptors();
  } finally {await agent.close();}
});

test("a 350.58 MB video is streamed to disk, identified without a full read, and partial downloads are removed",async()=>{
  const {mkdtemp,rm,readdir}=await import("node:fs/promises");
  const {tmpdir}=await import("node:os");const {join}=await import("node:path");
  const {storeYoutubeVideoStream,youtubeMediaFile,youtubeFileSource}=await import("./youtube");
  const directory=await mkdtemp(join(tmpdir(),"hoor-large-video-"));const previous=process.env.YOUTUBE_MEDIA_DIR;process.env.YOUTUBE_MEDIA_DIR=directory;
  const size=350_580_000;const chunk=Buffer.alloc(1024*1024);chunk.write("ftyp",4);
  async function* chunks(){let remaining=size;while(remaining){const length=Math.min(remaining,chunk.length);yield chunk.subarray(0,length);remaining-=length;}}
  try {
    const stored=await storeYoutubeVideoStream("workspace",chunks());
    const file=await youtubeMediaFile("workspace",stored.mediaId,"video");assert.equal(file.size,size);
    const source=youtubeFileSource(file);assert.equal((await source.read(0,32)).subarray(4,8).toString(),"ftyp");
    assert.equal((await source.read(size-32,size)).length,32);
    async function* interrupted(){yield chunk;throw new Error("connection lost");}
    await assert.rejects(storeYoutubeVideoStream("workspace",interrupted()),/connection lost/);
    await assert.rejects(storeYoutubeVideoStream("workspace",chunks(),100),/سقف/);
    assert.deepEqual(await readdir(join(directory,"workspace")),[stored.mediaId]);
  }finally{if(previous===undefined)delete process.env.YOUTUBE_MEDIA_DIR;else process.env.YOUTUBE_MEDIA_DIR=previous;await rm(directory,{recursive:true,force:true});}
});

test("covers above the old decimal 2 MB cap and up to 50 MB are stored; larger covers remain rejected",async()=>{
  const {mkdtemp,rm}=await import("node:fs/promises");
  const {tmpdir}=await import("node:os");const {join}=await import("node:path");
  const {storeYoutubeMedia,readYoutubeMedia}=await import("./youtube");
  const {YOUTUBE_COVER_MAX_BYTES}=await import("@socialyar/shared");
  const directory=await mkdtemp(join(tmpdir(),"hoor-cover-limit-"));
  const previous=process.env.YOUTUBE_MEDIA_DIR;process.env.YOUTUBE_MEDIA_DIR=directory;
  const png=(size:number)=>{const bytes=Buffer.alloc(size);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);return bytes;};
  try {
    // A UI reporting MiB can display this as 1.91 MB, despite exceeding 2,000,000 bytes.
    const nearOldLimit=png(2_002_780);const small=await storeYoutubeMedia("workspace",nearOldLimit);
    assert.deepEqual((await readYoutubeMedia("workspace",small.mediaId,"image")).bytes,nearOldLimit);
    assert.equal(YOUTUBE_COVER_MAX_BYTES,50_000_000);
    const atLimit=await storeYoutubeMedia("workspace",png(YOUTUBE_COVER_MAX_BYTES));
    assert.equal((await readYoutubeMedia("workspace",atLimit.mediaId,"image")).bytes.length,YOUTUBE_COVER_MAX_BYTES);
    await assert.rejects(storeYoutubeMedia("workspace",png(YOUTUBE_COVER_MAX_BYTES+1)),/upload limit/);
  }finally{if(previous===undefined)delete process.env.YOUTUBE_MEDIA_DIR;else process.env.YOUTUBE_MEDIA_DIR=previous;await rm(directory,{recursive:true,force:true});}
});
