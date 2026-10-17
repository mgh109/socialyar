import {test} from "node:test";
import assert from "node:assert/strict";
import {executeYoutube} from "./youtube";
import {youtubeCompletionLabel,youtubeFailureTitle} from "../../web/app/lib/youtube-publication";
import type {getDb} from "@socialyar/db";
function fixture(request:typeof fetch) {
  let current:any={id:"item",workspaceId:"workspace",status:"queued",queueVersion:3,approvedAt:new Date(),videoId:"already-uploaded",title:"عنوان",description:"",channelName:"کانال",logs:[],settings:{collectionId:"collection",coverUrl:"https://files.example/cover.png"}};
  const db={select:()=>({from:()=>({where:async()=>[structuredClone(current)]})}),update:()=>({set:(patch:Record<string,unknown>)=>({where:()=>{current={...current,...structuredClone(patch)};return{returning:async()=>[structuredClone(current)],then:(resolve:(value:unknown)=>void)=>resolve([])};}})})} as unknown as ReturnType<typeof getDb>;
  let coverReads=0;const delays:number[]=[];
  const services:NonNullable<Parameters<typeof executeYoutube>[3]>={operational:async()=>({} as any),transport:async()=>({fetch:request,close:async()=>{}} as any),token:async()=>({token:"fake",privateOnly:true,account:{} as any}),
    openVideo:async()=>{throw new Error("must not fetch or upload this video again");},inspectRemote:async()=>{throw new Error("must not inspect this video again");},
    fetchMedia:async()=>{coverReads++;return{bytes:Buffer.from([137,80,78,71]),type:"image/png"};},pause:async(ms)=>{delays.push(ms);},playlist:async()=>"PLexisting"};
  return{get item(){return current;},get coverReads(){return coverReads;},delays,services,run:()=>executeYoutube("item",db,3,services),retry:()=>{current.status="queued";}};
}
const processed=()=>Response.json({items:[{status:{privacyStatus:"private",uploadStatus:"processed"},processingDetails:{processingStatus:"succeeded"}}]});
test("uploaded video survives cover, transient read and playlist failures; completion skips successful cover",async()=>{
  let coverPosts=0,reads=0,playlistCalls=0;
  const f=fixture((async(url:unknown,init:RequestInit={})=>{
    if(String(url).includes("thumbnails/set")){coverPosts++;return coverPosts===1 ? Response.json({error:{message:"temporary thumbnail failure"}},{status:503}) : Response.json({items:[]});}
    assert.equal(init.method,undefined);assert.match(String(url),/id=already-uploaded/);reads++;
    if(reads<=2)throw Object.assign(new Error("network disconnected"),{code:"ECONNRESET"});return processed();
  }) as typeof fetch);
  f.services.playlist=async()=>{playlistCalls++;if(playlistCalls===1)throw new Error("playlist unavailable");return "PLexisting";};
  await assert.rejects(f.run(),/503/);assert.equal(f.item.settings.publicationFailureStage,"cover_upload");assert.equal(f.item.videoId,"already-uploaded");
  f.retry();await assert.rejects(f.run(),/playlist unavailable/);
  assert.equal(f.item.settings.publicationFailureStage,"playlist");assert.equal(f.item.settings.coverUploaded,true);assert.equal(f.item.settings.videoProcessingConfirmed,true);
  assert.deepEqual(f.delays,[1000,2000]);assert.equal(f.item.logs.filter((e:any)=>e.result==="read_retry").length,2);
  f.retry();await f.run();assert.equal(f.item.status,"published");assert.equal(f.item.settings.publicationFailureStage,null);assert.equal(f.item.settings.playlistId,"PLexisting");
  assert.equal(f.coverReads,2);assert.equal(coverPosts,2);assert.equal(f.item.videoId,"already-uploaded");
});
test("persistent service outage has bounded read retries; permission errors are not retried automatically",async()=>{
  for(const status of [503,403]){
    let reads=0;const f=fixture((async()=>{reads++;return Response.json({error:{message:"service error"}},{status});}) as typeof fetch);
    delete f.item.settings.coverUrl;
    await assert.rejects(f.run(),new RegExp(String(status)));
    assert.equal(reads,status===503?3:1);assert.equal(f.item.settings.publicationFailureStage,"status_check");assert.equal(f.item.videoId,"already-uploaded");
    assert.equal(f.item.status,"failed");assert.equal(f.coverReads,0);
  }
});
test("completion labels distinguish an uploaded video from a failed upload, including legacy records",()=>{
  assert.equal(youtubeCompletionLabel(true,"failed"),"ارسال شد؛ نیازمند تکمیل");assert.equal(youtubeCompletionLabel(false,"failed"),null);
  assert.match(youtubeFailureTitle({publicationFailureStage:"cover_upload"},true),/ویدئو ارسال شد؛ تنظیم کاور/);
  assert.match(youtubeFailureTitle({},true),/ویدئو ارسال شد؛ تکمیل انتشار/);
});

test("unknown session creation is held before a later attempt can start another upload",async()=>{
  const {AmbiguousDeliveryError}=await import("@socialyar/db");let posts=0;
  const f=fixture((async(_url,init)=>{assert.equal(init?.method,"POST");posts++;throw new AmbiguousDeliveryError();}) as typeof fetch);
  f.item.videoId=null;f.item.settings.videoUrl="https://files.example/video.mp4";
  f.services.openVideo=async()=>({size:16,type:"video/mp4",snapshot:{size:16,type:"video/mp4",headHash:"hash",etag:'"etag"'},read:async(start:number,end:number)=>Buffer.alloc(end-start)});
  await assert.rejects(f.run(),AmbiguousDeliveryError);assert.equal(f.item.settings.uploadSessionUnknown,true);assert.equal(posts,1);
  f.retry();await assert.rejects(f.run(),/شروع آپلود قبلی نامعلوم/);assert.equal(posts,1);
});

test("publication sends the selected visibility even when a legacy token service returns privateOnly",async(t)=>{
  const previous=process.env.HOOR_SECRET_KEY;process.env.HOOR_SECRET_KEY=Buffer.alloc(32,9).toString("base64");
  t.after(()=>{if(previous===undefined)delete process.env.HOOR_SECRET_KEY;else process.env.HOOR_SECRET_KEY=previous;});
  for(const privacy of ["public","unlisted","private"]){
    let sessions=0;
    const f=fixture((async(url,init)=>{
      if(init?.method==="POST"){
        sessions++;assert.equal(JSON.parse(String(init.body)).status.privacyStatus,privacy);
        return new Response(null,{headers:{location:"https://www.googleapis.com/upload/youtube/v3/videos?upload_id=visibility"}});
      }
      if(init?.method==="PUT")return Response.json({id:"new-video"});
      assert.match(String(url),/id=new-video/);
      return Response.json({items:[{status:{privacyStatus:privacy,uploadStatus:"processed"},processingDetails:{processingStatus:"succeeded"}}]});
    }) as typeof fetch);
    f.item.videoId=null;delete f.item.settings.coverUrl;f.item.settings.privacy=privacy;f.item.settings.videoUrl="https://files.example/video.mp4";
    f.services.openVideo=async()=>({size:16,type:"video/mp4",snapshot:{size:16,type:"video/mp4",headHash:"hash"},read:async(start:number,end:number)=>Buffer.alloc(end-start)});
    await f.run();assert.equal(sessions,1);assert.equal(f.item.status,"published");assert.equal(f.item.actualPrivacy,privacy);
    assert.ok(f.item.logs.some((log:any)=>log.result==="upload_started" && log.requestedPrivacy===privacy && log.submittedPrivacy===privacy));
    assert.ok(f.item.logs.some((log:any)=>log.result==="published" && log.privacyRestricted===false));
  }
});
test("actual YouTube visibility is preserved when the provider returns a different value",async()=>{
  const f=fixture((async()=>processed()) as typeof fetch);
  delete f.item.settings.coverUrl;f.item.settings.privacy="public";
  await f.run();assert.equal(f.item.actualPrivacy,"private");assert.equal(f.item.videoId,"already-uploaded");
  assert.ok(f.item.logs.some((log:any)=>log.result==="published" && log.requestedPrivacy==="public" && log.actualPrivacy==="private" && log.privacyRestricted===true));
});
test("legacy project verification flags no longer force private visibility",async()=>{
  const {youtubeConfig}=await import("@socialyar/db");
  const names=["YOUTUBE_CLIENT_ID","YOUTUBE_CLIENT_SECRET","YOUTUBE_REDIRECT_URI","YOUTUBE_PROJECT_VERIFIED"];
  const saved=names.map(name=>process.env[name]);
  try{
    process.env.YOUTUBE_CLIENT_ID="test-client";process.env.YOUTUBE_CLIENT_SECRET="test-secret";process.env.YOUTUBE_REDIRECT_URI="https://api.example.com/youtube/oauth/callback";
    for(const value of [undefined,"false","true"]){
      if(value===undefined)delete process.env.YOUTUBE_PROJECT_VERIFIED;else process.env.YOUTUBE_PROJECT_VERIFIED=value;
      assert.equal(youtubeConfig().privateOnly,false);
    }
  }finally{names.forEach((name,index)=>{if(saved[index]===undefined)delete process.env[name];else process.env[name]=saved[index];});}
});
