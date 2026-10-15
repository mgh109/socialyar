import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareCollectionVideo } from "./collection-prepare";
import type { getDb } from "@socialyar/db";

test("cover failure identifies the stage; retry validates remote links and discards legacy cached IDs", async () => {
  let current: any = { id:"item", workspaceId:"workspace", status:"waiting_video", queueVersion:1,
    title:"ویدئو", description:"", channelName:"کانال", logs:[], settings:{ collectionId:"collection", sourceVideoUrl:"https://example.com/video.mp4", coverUrl:"https://example.com/cover.jpg",videoMediaId:"old-video",coverMediaId:"old-cover" } };
  const database = {
    select:()=>({from:()=>({where:async()=>[structuredClone(current)]})}),
    update:()=>({set:(patch:Record<string,unknown>)=>({where:()=>{
      current={...current,...structuredClone(patch)};
      return { returning:async()=>[structuredClone(current)], then:(resolve:(value:unknown)=>void)=>resolve([]) };
    }})}),
  } as unknown as ReturnType<typeof getDb>;
  let videoChecks=0, failCover=true;
  const services: Parameters<typeof prepareCollectionVideo>[3] = {
    lock:async()=>({query:async()=>({rows:[]}),release:()=>{}} as any),
    operational:async()=>({status:"active"} as any),
    fetchMedia:async(_workspace,_url,kind)=>{
      assert.equal(kind,"image");
      if(failCover) throw new Error("cover download failed");
      return {bytes:Buffer.from(kind),type:"image/jpeg"} as any;
    },
    openVideo:async()=>{videoChecks++;return {size:32,type:"video/mp4",snapshot:{size:32,type:"video/mp4",headHash:"hash",etag:'"stable"'},read:async()=>Buffer.alloc(32)};},
    inspect:async()=>({width:1920,height:1080,duration:30}),
  };
  await assert.rejects(prepareCollectionVideo("item",1,database,services),/cover download failed/);
  assert.equal(current.settings.videoMediaId,undefined);
  assert.equal(current.settings.mediaTransfer,"remote");
  assert.equal(current.settings.preparationFailureStage,"cover_link");
  assert.equal(current.status,"failed");
  failCover=false;
  await prepareCollectionVideo("item",1,database,services);
  assert.equal(videoChecks,2);
  assert.equal(current.status,"waiting_approval");
  assert.equal(current.error,null);
  assert.equal(current.settings.preparationFailureStage,null);
  assert.equal(current.settings.coverMediaId,undefined);
  assert.equal(current.settings.coverLinkChecked,true);
});
