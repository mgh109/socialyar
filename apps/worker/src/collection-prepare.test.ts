import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareCollectionVideo } from "./collection-prepare";
import type { getDb } from "@socialyar/db";

test("cover failure preserves downloaded video, identifies the failed stage, and retry reuses video", async () => {
  let current: any = { id:"item", workspaceId:"workspace", status:"waiting_video", queueVersion:1,
    title:"ویدئو", description:"", channelName:"کانال", logs:[], settings:{ collectionId:"collection", sourceVideoUrl:"https://example.com/video.mp4", coverUrl:"https://example.com/cover.jpg" } };
  const database = {
    select:()=>({from:()=>({where:async()=>[structuredClone(current)]})}),
    update:()=>({set:(patch:Record<string,unknown>)=>({where:()=>{
      current={...current,...structuredClone(patch)};
      return { returning:async()=>[structuredClone(current)], then:(resolve:(value:unknown)=>void)=>resolve([]) };
    }})}),
  } as unknown as ReturnType<typeof getDb>;
  let videoDownloads=0, failCover=true;
  const services: Parameters<typeof prepareCollectionVideo>[3] = {
    lock:async()=>({query:async()=>({rows:[]}),release:()=>{}} as any),
    operational:async()=>({status:"active"} as any),
    fetchMedia:async(_workspace,_url,kind)=>{
      if(kind==="video") videoDownloads++;
      if(kind==="image" && failCover) throw new Error("cover download failed");
      return {bytes:Buffer.from(kind),type:kind==="video"?"video/mp4":"image/jpeg"} as any;
    },
    storeMedia:async(_workspace,bytes)=>({mediaId:bytes.toString()==="video"?"a".repeat(64):"b".repeat(64),kind:bytes.toString()==="video"?"video":"image"}),
    fetchVideo:async()=>{videoDownloads++;return {mediaId:"a".repeat(64),kind:"video",type:"video/mp4",size:32};},
    mediaFile:async()=>({path:"/test/video",size:32,type:"video/mp4"}),
    inspect:async()=>({width:1920,height:1080,duration:30}),
  };
  await assert.rejects(prepareCollectionVideo("item",1,database,services),/cover download failed/);
  assert.equal(current.settings.videoMediaId,"a".repeat(64));
  assert.equal(current.settings.preparationFailureStage,"cover_download");
  assert.equal(current.status,"failed");
  failCover=false;
  await prepareCollectionVideo("item",1,database,services);
  assert.equal(videoDownloads,1);
  assert.equal(current.status,"waiting_approval");
  assert.equal(current.error,null);
  assert.equal(current.settings.preparationFailureStage,null);
  assert.equal(current.settings.coverMediaId,"b".repeat(64));
});
