import {test} from "node:test";
import assert from "node:assert/strict";
import {openCollectionVideoSource,collectionVideoUrl} from "./remote-video";
import {uploadYoutubeVideo} from "./youtube-upload";
const signature=Buffer.from([0,0,0,16,102,116,121,112,0,0,0,0]);
const total=350_580_000;
function origin(options:{size?:number;etag?:string;lastModified?:string;mutate?:(response:any,start:number)=>void}={}) {
  const reads:Array<[number,number,string|undefined]>=[];
  const reader:Parameters<typeof openCollectionVideoSource>[4]=async(workspace,url,start,end,policy,validator)=>{
    assert.equal(workspace,"workspace");assert.equal(url,"https://files.example.com/video.mp4");assert.deepEqual(policy,{mode:"direct"});
    const size=options.size??total;end=Math.min(end,size);reads.push([start,end,validator]);
    const bytes=Buffer.alloc(end-start);if(start===0)signature.copy(bytes);
    const response={bytes,headers:{"content-range":`bytes ${start}-${end-1}/${size}`,etag:options.etag??'"stable"',...(options.lastModified?{"last-modified":options.lastModified}:{})}};
    options.mutate?.(response,start);return response;
  };
  const open=(expected?:Parameters<typeof openCollectionVideoSource>[3])=>openCollectionVideoSource("workspace","https://files.example.com/video.mp4",{mode:"direct"},expected,reader);
  return{open,reads};
}
test("350 MB remote source resumes in bounded chunks without reading acknowledged bytes",async()=>{
  const {open,reads}=origin();const source=await open();const resume=8*1024*1024;
  let probe=true,sessions=0;
  const request=(async(_url:unknown,init:RequestInit)=>{
    if(init.method==="POST"){sessions++;throw new Error("must reuse session");}
    if(probe){probe=false;return new Response(null,{status:308,headers:{range:`bytes=0-${resume-1}`}});}
    const range=String((init.headers as any)["Content-Range"]);const [,start,end]=range.match(/bytes (\d+)-(\d+)\//)!;
    assert.ok(Number(end)-Number(start)+1<=8*1024*1024);
    assert.equal((init.body as Uint8Array).length,Number(end)-Number(start)+1);
    return Number(end)+1===total ? Response.json({id:"remote-video"}) : new Response(null,{status:308,headers:{range:`bytes=0-${end}`}});
  }) as typeof fetch;
  const id=await uploadYoutubeVideo({source,type:source.type,token:"test",session:"https://www.googleapis.com/upload/youtube/v3/videos?upload_id=test",metadata:{},saveSession:async()=>{},saveProgress:async()=>{}},request);
  assert.equal(id,"remote-video");assert.equal(sessions,0);assert.equal(reads[0][1],4096);assert.equal(reads[1][0],resume);
  assert.ok(reads.slice(1).every(([start,end,validator])=>end-start<=8*1024*1024&&validator==='"stable"'));
});
test("changed, truncated and invalid remote ranges fail before upload bytes can be mixed",async()=>{
  const snapshot=(await origin().open()).snapshot;
  await assert.rejects(origin({etag:'"new"'}).open(snapshot),/تغییر/);
  await assert.rejects(origin({mutate:r=>{r.headers["content-range"]="bytes 1-4096/5000";}}).open(),/بازه/);
  await assert.rejects(origin({mutate:r=>{r.bytes=r.bytes.subarray(1);}}).open(),/بازه/);
  await assert.rejects(origin({mutate:r=>{r.headers["content-range"]="garbage";}}).open(),/Content-Range/);
  await assert.rejects(origin({mutate:r=>{delete r.headers.etag;}}).open(),/ETag/);
  await assert.rejects(origin({size:11_000_000_000}).open(),/حجم/);
  const source=await origin({mutate:(r,start)=>{if(start>0)r.headers.etag='"changed"';}}).open();
  await assert.rejects(source.read(4096,8192),/تغییر/);
  await assert.rejects(source.read(0,9*1024*1024),/Invalid/);
});
test("weak ETag falls back to Last-Modified; small sources and signed URLs remain valid",async()=>{
  const {open}=origin({size:32,etag:'W/"weak"',lastModified:"Mon, 12 Oct 2026 10:00:00 GMT"});
  const source=await open();assert.equal(source.size,32);assert.equal(source.snapshot.etag,undefined);assert.equal((await source.read(0,32)).length,32);
  assert.equal(collectionVideoUrl({sourceVideoUrl:"https://files.example.com/a.mp4?signature=abc"}),"https://files.example.com/a.mp4?signature=abc");
  assert.throws(()=>collectionVideoUrl({videoUrl:"http://files.example.com/a.mp4"}),/HTTPS/);
  assert.throws(()=>collectionVideoUrl({videoUrl:"https://user:pass@files.example.com/a.mp4"}),/HTTPS/);
});
