import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile,mkdtemp,rm,unlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {createRequire} from "node:module";
import Fastify from "fastify";
import {PGlite} from "@electric-sql/pglite";
import {drizzle} from "drizzle-orm/pglite";
import {eq} from "drizzle-orm";
import * as schema from "@socialyar/db/schema";
import {getDb,storeYoutubeVideoStream,storeYoutubeMedia,youtubeMediaFile,inspectVideo,assertWorkspaceOperational} from "@socialyar/db";
import {readCollectionSheet,mapCollectionRows,inferMapping} from "../../web/app/lib/collection-sheet";
import {contentCollectionRoutes} from "./routes/content-collections";
import {youtubeRoutes} from "./routes/youtube";
import {prepareCollectionVideo} from "../../worker/src/collection-prepare";
import {executeYoutube} from "../../worker/src/youtube";
import {connection} from "./queue";

test("real XLSX → import → interrupted preparation → lost-file recovery → approval → resumable upload; retries never publish twice",async()=>{
  connection.disconnect();
  const engine=new PGlite();const db=drizzle(engine,{schema}) as unknown as ReturnType<typeof getDb>;
  const app=Fastify();const mediaRoot=await mkdtemp(join(tmpdir(),"hoor-collection-flow-"));
  const oldMedia=process.env.YOUTUBE_MEDIA_DIR,oldKey=process.env.HOOR_SECRET_KEY;
  process.env.YOUTUBE_MEDIA_DIR=mediaRoot;process.env.HOOR_SECRET_KEY=Buffer.alloc(32,7).toString("base64");
  const userId=randomUUID(),workspaceId=randomUUID(),workflowId=randomUUID(),versionId=randomUUID(),accountId=randomUUID();
  const jobs:Array<{name:string;data:any}>=[];let queueDown=false;
  const queue={add:async(name:string,data:any)=>{if(queueDown)throw new Error("queue unavailable");jobs.push({name,data});return {} as any;},getJob:async()=>null};
  try {
    for(const name of ["0000_initial.sql","0001_auth.sql","0002_eitaa_automation.sql","0006_youtube.sql","0007_publishing_proxies.sql","0008_publication_calendar.sql","0009_content_collections.sql","0011_execution_recovery.sql","0012_tenant_access.sql","0014_image_generation.sql"])
      await engine.exec(await readFile(new URL(`../../../packages/db/migrations/${name}`,import.meta.url),"utf8"));
    await db.insert(schema.users).values({id:userId,email:"flow-test@example.com"});
    await db.insert(schema.workspaces).values({id:workspaceId,name:"test",slug:"flow-test",ownerId:userId});
    await db.insert(schema.workspaceSubscriptions).values({workspaceId});
    await db.insert(schema.socialAccounts).values({id:accountId,workspaceId,channel:"youtube",externalAccountId:"channel",displayName:"کانال آزمون"});
    await db.insert(schema.workflows).values({id:workflowId,workspaceId,name:"اکسل تا یوتیوب"});
    await db.insert(schema.workflowVersions).values({id:versionId,workflowId,version:1});
    const sourceId=randomUUID(),targetId=randomUUID();
    await db.insert(schema.workflowSteps).values([{id:sourceId,workflowVersionId:versionId,key:"sheet",type:"collection_source",name:"اکسل"},{id:targetId,workflowVersionId:versionId,key:"youtube",type:"publish",name:"یوتیوب",config:{accountId}}]);
    await db.insert(schema.workflowConnections).values({workflowVersionId:versionId,sourceStepId:sourceId,targetStepId:targetId});
    const require=createRequire(new URL("../../web/package.json",import.meta.url));const ExcelJS=require("exceljs");
    const workbook=new ExcelJS.Workbook();const sheet=workbook.addWorksheet("محتوا");
    sheet.addRow(["شناسه محتوا","عنوان","لینک ویدئو","لینک کاور"]);
    sheet.addRow(["MH-001","آموزش حفظ سوره ناس",{text:"دانلود ویدئو",hyperlink:"https://files.example.com/01%20nas.mp4"},"https://files.example.com/MH-001.png"]);
    const data=await readCollectionSheet(new File([new Uint8Array(await workbook.xlsx.writeBuffer())],"course.xlsx"));
    const {rows,errors}=mapCollectionRows(data,inferMapping(data.headers));assert.deepEqual(errors,[]);
    app.decorate("authenticate",async(request:any)=>{request.auth={userId,workspaceId:request.headers["x-other"] ? randomUUID() : workspaceId};});
    app.setErrorHandler((error,_request,reply)=>reply.code(400).send({error:error instanceof Error ? error.message : "خطا"}));
    await app.register(contentCollectionRoutes,{database:db,queue,sheetFetcher:async()=>data});
    await app.register(youtubeRoutes,{database:db,queue});
    const scope={workflowId,sourceStepKey:"sheet",targetStepKey:"youtube",rows};
    const gs=await app.inject({method:"POST",url:"/content-collections/google-sheet",payload:{workflowId,sourceStepKey:"sheet",url:"https://docs.google.com/spreadsheets/d/test/edit"}});
    assert.equal(gs.statusCode,200,gs.body);assert.deepEqual(gs.json(),data);
    const preview=await app.inject({method:"POST",url:"/content-collections/preview",payload:scope});assert.equal(preview.statusCode,200,preview.body);
    const p=preview.json();const applied=await app.inject({method:"POST",url:"/content-collections/apply",payload:{...scope,revision:p.revision,selected:p.changes.map(({id,version,updatedAt}:any)=>({id,version,updatedAt}))}});
    assert.equal(applied.statusCode,200,applied.body);assert.equal(jobs[0].name,"youtube-prepare");
    let [item]=await db.select().from(schema.youtubeItems);assert.equal(item.approvedAt,null);
    const video=execFileSync("ffmpeg",["-v","error","-f","lavfi","-i","color=c=black:s=192x108:r=1","-t","1","-c:v","libx264","-movflags","frag_keyframe+empty_moov","-f","mp4","pipe:1"]);
    const cover=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VfoAAAAASUVORK5CYII=","base64");
    let downloads=0,coverFails=true;
    const services:Parameters<typeof prepareCollectionVideo>[3]={
      lock:async()=>({query:async()=>({rows:[]}),release:()=>{}} as any),operational:assertWorkspaceOperational,mediaFile:youtubeMediaFile,inspect:inspectVideo,storeMedia:storeYoutubeMedia,
      fetchVideo:async(_workspace,_url,_policy,onProgress)=>{downloads++;await onProgress?.({bytes:video.length,total:video.length});const [during]=await db.select().from(schema.youtubeItems);assert.equal(during.status,"preparing");assert.equal(during.settings.videoDownloadedBytes,video.length);return storeYoutubeVideoStream(workspaceId,(async function*(){yield video;})());},
      fetchMedia:async()=>{if(coverFails)throw new Error("دریافت کاور از هاست ناموفق بود (HTTP 403).");return {bytes:cover,type:"image/png"};},
    };
    await assert.rejects(prepareCollectionVideo(item.id,item.queueVersion,db,services),/403/);
    [item]=await db.select().from(schema.youtubeItems);assert.equal(item.settings.preparationFailureStage,"cover_download");assert.ok(item.settings.videoMediaId);
    assert.ok(item.logs.some(log=>log.result==="video_downloaded"));
    // Simulate a restarted worker or moved volume. Retrying must repair the file, not repeat ENOENT forever.
    await unlink((await youtubeMediaFile(workspaceId,String(item.settings.videoMediaId))).path);
    const denied=await app.inject({method:"POST",url:`/youtube/items/${item.id}/retry`,headers:{"x-other":"1"}});assert.equal(denied.statusCode,409);
    const retry=await app.inject({method:"POST",url:`/youtube/items/${item.id}/retry`});assert.equal(retry.statusCode,200,retry.body);
    const duplicate=await app.inject({method:"POST",url:`/youtube/items/${item.id}/retry`});assert.equal(duplicate.statusCode,409);assert.equal(jobs.filter(j=>j.name==="youtube-prepare").length,2);
    coverFails=false;[item]=await db.select().from(schema.youtubeItems);
    await prepareCollectionVideo(item.id,item.queueVersion-1,db,services); // stale job cannot change the current revision
    assert.equal(downloads,1);
    await prepareCollectionVideo(item.id,item.queueVersion,db,services);
    [item]=await db.select().from(schema.youtubeItems);assert.equal(downloads,2);assert.equal(item.status,"waiting_approval");assert.equal(item.error,null);assert.equal(item.approvedAt,null);
    assert.equal(item.settings.preparationStage,"ready");assert.ok(item.logs.some(log=>log.result==="video_recovery"));
    const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{"Content-Type":"application/json"}});
    let uploadSessions=0,thumbnailFails=true;const uploads:Uint8Array[]=[];
    const request=(async(url:unknown,init:RequestInit={})=>{
      const path=String(url);
      if(path.includes("uploadType=resumable")){uploadSessions++;return new Response(null,{headers:{location:"https://www.googleapis.com/upload/youtube/v3/videos?upload_id=test"}});}
      if(init.method==="PUT"){uploads.push(init.body as Uint8Array);return json({id:"confirmed-video"});}
      if(path.includes("thumbnails/set")){if(thumbnailFails)return new Response(JSON.stringify({error:{message:"thumbnail temporarily failed"}}),{status:503,headers:{"Content-Type":"application/json"}});return json({items:[]});}
      if(path.includes("processingDetails"))return json({items:[{status:{privacyStatus:"private",uploadStatus:"processed"},processingDetails:{processingStatus:"succeeded"}}]});
      throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch;
    const publishServices:Parameters<typeof executeYoutube>[3]={operational:assertWorkspaceOperational,transport:async()=>({fetch:request,close:async()=>{}} as any),token:async()=>({token:"test-token",privateOnly:true,account:{} as any})};
    await executeYoutube(item.id,db,item.queueVersion,publishServices);assert.equal(uploadSessions,0); // human approval is mandatory
    const approve=()=>app.inject({method:"POST",url:`/youtube/items/${item.id}/resolve`,payload:{action:"approve"}});
    process.env.YOUTUBE_MEDIA_DIR=join(mediaRoot,"unshared-api-volume");
    const unavailable=await approve();assert.equal(unavailable.statusCode,409);assert.match(unavailable.json().error,/API/);
    process.env.YOUTUBE_MEDIA_DIR=mediaRoot;
    const approved=await approve();assert.equal(approved.statusCode,200,approved.body);assert.equal(jobs.at(-1)?.name,"youtube-publish");
    assert.equal((await approve()).statusCode,409);
    await assert.rejects(executeYoutube(item.id,db,item.queueVersion,publishServices),/503/);
    [item]=await db.select().from(schema.youtubeItems);assert.equal(item.videoId,"confirmed-video");assert.equal(item.status,"failed");
    thumbnailFails=false;
    assert.equal((await app.inject({method:"POST",url:`/youtube/items/${item.id}/retry`})).statusCode,200);
    await executeYoutube(item.id,db,item.queueVersion,publishServices);
    [item]=await db.select().from(schema.youtubeItems);assert.equal(item.status,"published");assert.equal(item.videoId,"confirmed-video");assert.equal(item.actualPrivacy,"private");
    assert.equal(uploadSessions,1);assert.deepEqual(Buffer.concat(uploads),video);
    await executeYoutube(item.id,db,item.queueVersion,publishServices);assert.equal(uploadSessions,1);
    const again=await app.inject({method:"POST",url:"/content-collections/preview",payload:scope});assert.equal(again.json().changes[0].kind,"unchanged");assert.equal((await db.select().from(schema.youtubeItems)).length,1);
    // Queue failure is visible and leaves a retryable item rather than a permanently queued one.
    await db.update(schema.youtubeItems).set({status:"failed",approvedAt:null,videoId:null,sessionEnc:null}).where(eq(schema.youtubeItems.id,item.id));queueDown=true;
    const failedQueue=await app.inject({method:"POST",url:`/youtube/items/${item.id}/retry`});assert.equal(failedQueue.statusCode,503);
    [item]=await db.select().from(schema.youtubeItems);assert.equal(item.status,"failed");assert.match(String(item.error),/صف/);
  }finally{
    await app.close();await engine.close();await rm(mediaRoot,{recursive:true,force:true});
    if(oldMedia===undefined)delete process.env.YOUTUBE_MEDIA_DIR;else process.env.YOUTUBE_MEDIA_DIR=oldMedia;
    if(oldKey===undefined)delete process.env.HOOR_SECRET_KEY;else process.env.HOOR_SECRET_KEY=oldKey;
  }
});
