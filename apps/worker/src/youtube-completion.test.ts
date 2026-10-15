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
