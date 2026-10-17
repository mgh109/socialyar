import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile,mkdtemp,rm,writeFile,stat} from "node:fs/promises";
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
import {getDb,openCollectionVideoSource,inspectRemoteVideo,assertWorkspaceOperational} from "@socialyar/db";
import {readCollectionSheet,mapCollectionRows,inferMapping} from "../../web/app/lib/collection-sheet";
import {contentCollectionRoutes} from "./routes/content-collections";
import {mutateCalendarItem} from "./routes/calendar";
import {workflowRoutes} from "./routes/workflows";
import {youtubeRoutes} from "./routes/youtube";
import {prepareCollectionVideo} from "../../worker/src/collection-prepare";
import {executeYoutube} from "../../worker/src/youtube";
import {connection} from "./queue";

test("real XLSX → remote inspection → approval without shared disk → resumable upload; source changes and retries never publish twice",async()=>{
  connection.disconnect();
  const engine=new PGlite();const db=drizzle(engine,{schema}) as unknown as ReturnType<typeof getDb>;
  const app=Fastify();const mediaRoot=await mkdtemp(join(tmpdir(),"hoor-collection-flow-"));
  const oldMedia=process.env.YOUTUBE_MEDIA_DIR,oldKey=process.env.HOOR_SECRET_KEY;
  process.env.YOUTUBE_MEDIA_DIR=join(mediaRoot,"blocked-media-path");await writeFile(process.env.YOUTUBE_MEDIA_DIR,"no media directory");process.env.HOOR_SECRET_KEY=Buffer.alloc(32,7).toString("base64");
  const userId=randomUUID(),workspaceId=randomUUID(),workflowId=randomUUID(),versionId=randomUUID(),accountId=randomUUID();
  const jobs:Array<{name:string;data:any}>=[];let queueDown=false;
  const queue={add:async(name:string,data:any)=>{if(queueDown)throw new Error("queue unavailable");jobs.push({name,data});return {} as any;},getJob:async()=>undefined};
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
    sheet.addRow(["شناسه محتوا","عنوان","لینک ویدئو","لینک کاور","وضعیت نمایش"]);
    sheet.addRow(["MH-001","آموزش حفظ سوره ناس",{text:"دانلود ویدئو",hyperlink:"https://files.example.com/01%20nas.mp4"},"https://files.example.com/MH-001.png","public"]);
    const data=await readCollectionSheet(new File([new Uint8Array(await workbook.xlsx.writeBuffer())],"course.xlsx"));
    const {rows,errors}=mapCollectionRows(data,inferMapping(data.headers));assert.deepEqual(errors,[]);assert.equal(rows[0].privacy,"public");
    app.decorate("authenticate",async(request:any)=>{request.auth={userId,workspaceId:request.headers["x-other"] ? randomUUID() : workspaceId};});
    app.setErrorHandler((error,_request,reply)=>reply.code(400).send({error:error instanceof Error ? error.message : "خطا"}));
    await app.register(contentCollectionRoutes,{database:db,queue,sheetFetcher:async()=>data});
    await app.register(youtubeRoutes,{database:db,queue});
    await app.register(workflowRoutes,{database:db});
    assert.equal((await app.inject({method:"GET",url:"/youtube/config"})).json().privateOnly,false);
    const disconnected=await app.inject({method:"PUT",url:`/workflows/${workflowId}`,payload:{status:"active",autonomyMode:"full_auto",steps:[{key:"sheet",type:"collection_source",name:"شیت"},{key:"youtube",type:"publish",name:"یوتیوب",config:{accountId}}],connections:[]}});
    assert.equal(disconnected.statusCode,409);assert.equal(disconnected.json().error,"graph_missing_input");
    const activation=await app.inject({method:"PUT",url:`/workflows/${workflowId}`,payload:{status:"active",autonomyMode:"full_auto",steps:[{key:"sheet",type:"collection_source",name:"شیت",config:{collectionSource:"google_sheet"}},{key:"youtube",type:"publish",name:"یوتیوب",config:{accountId}}],connections:[{sourceKey:"sheet",targetKey:"youtube"}]}});
    assert.equal(activation.statusCode,200,activation.body);
    assert.equal(activation.json().workflow.status,"active");
    assert.equal(jobs.length,0);assert.equal((await db.select().from(schema.youtubeItems)).length,0);
    const scope={workflowId,sourceStepKey:"sheet",targetStepKey:"youtube",rows};
    const gs=await app.inject({method:"POST",url:"/content-collections/google-sheet",payload:{workflowId,sourceStepKey:"sheet",url:"https://docs.google.com/spreadsheets/d/test/edit"}});
    assert.equal(gs.statusCode,200,gs.body);assert.deepEqual(gs.json(),data);
    const preview=await app.inject({method:"POST",url:"/content-collections/preview",payload:scope});assert.equal(preview.statusCode,200,preview.body);
    const p=preview.json();const applied=await app.inject({method:"POST",url:"/content-collections/apply",payload:{...scope,revision:p.revision,selected:p.changes.map(({id,version,updatedAt}:any)=>({id,version,updatedAt}))}});
    assert.equal(applied.statusCode,200,applied.body);assert.equal(jobs[0].name,"youtube-prepare");
    let [item]=await db.select().from(schema.youtubeItems);assert.equal(item.approvedAt,null);assert.equal(item.settings.privacy,"public");
    const video=execFileSync("ffmpeg",["-v","error","-f","lavfi","-i","color=c=black:s=192x108:r=1","-t","1","-c:v","libx264","-movflags","frag_keyframe+empty_moov","-f","mp4","pipe:1"]);
    const cover=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VfoAAAAASUVORK5CYII=","base64");
    let checks=0,coverFails=true,sourceChanged=false;
    const openVideo:typeof openCollectionVideoSource=async(workspace,url,policy,expected)=>{
      checks++;
      return openCollectionVideoSource(workspace,url,policy,expected,async(w,raw,start,end)=>{
        assert.equal(w,workspaceId);assert.equal(raw,rows[0].videoUrl);end=Math.min(end,video.length);
        return {bytes:video.subarray(start,end),headers:{"content-range":`bytes ${start}-${end-1}/${video.length}`,etag:sourceChanged?'"changed"':'"video-v1"'}};
      });
    };
    const fetchMedia:NonNullable<Parameters<typeof prepareCollectionVideo>[3]>["fetchMedia"]=async(_workspace,_url,kind,_policy,verifyOnly)=>{
      assert.equal(kind,"image");if(verifyOnly)assert.equal(_workspace,workspaceId);
      if(coverFails)throw new Error("دریافت کاور از هاست ناموفق بود (HTTP 403).");return {bytes:cover,type:"image/png"};
    };
    const services:Parameters<typeof prepareCollectionVideo>[3]={
      lock:async()=>({query:async()=>({rows:[]}),release:()=>{}} as any),operational:assertWorkspaceOperational,
      inspect:inspectRemoteVideo,openVideo,fetchMedia,
    };
    await assert.rejects(prepareCollectionVideo(item.id,item.queueVersion,db,services),/403/);
    [item]=await db.select().from(schema.youtubeItems);assert.equal(item.settings.preparationFailureStage,"cover_link");assert.equal(item.settings.videoMediaId,undefined);assert.ok(item.settings.remoteVideo);
    assert.ok(item.logs.some(log=>log.result==="video_link_checked"));
    const denied=await app.inject({method:"POST",url:`/youtube/items/${item.id}/retry`,headers:{"x-other":"1"}});assert.equal(denied.statusCode,409);
    const retry=await app.inject({method:"POST",url:`/youtube/items/${item.id}/retry`});assert.equal(retry.statusCode,200,retry.body);
    const duplicate=await app.inject({method:"POST",url:`/youtube/items/${item.id}/retry`});assert.equal(duplicate.statusCode,409);assert.equal(jobs.filter(j=>j.name==="youtube-prepare").length,2);
    coverFails=false;[item]=await db.select().from(schema.youtubeItems);
    await prepareCollectionVideo(item.id,item.queueVersion-1,db,services); // stale job cannot change the current revision
    assert.equal(checks,1);
    await prepareCollectionVideo(item.id,item.queueVersion,db,services);
    [item]=await db.select().from(schema.youtubeItems);assert.equal(checks,2);assert.equal(item.status,"waiting_approval");assert.equal(item.error,null);assert.equal(item.approvedAt,null);
    assert.equal(item.settings.preparationStage,"ready");assert.equal(item.settings.coverMediaId,undefined);assert.equal(item.settings.mediaTransfer,"remote");
    // Existing prepared collection items can be approved in the calendar without any shared file.
    const legacyId=randomUUID();const legacySettings:Record<string,unknown>={...item.settings,videoMediaId:"a".repeat(64)};delete legacySettings.remoteVideo;
    await db.insert(schema.youtubeItems).values({...item,id:legacyId,itemKey:"legacy-calendar",queueVersion:0,settings:legacySettings});
    const auth={userId,workspaceId} as Parameters<typeof mutateCalendarItem>[1];
    assert.equal((await mutateCalendarItem(db,auth,{kind:"youtube",id:legacyId},{action:"approve",version:0},queue)).status,200);
    const future=new Date(Date.now()+86400000).toISOString();
    assert.equal((await mutateCalendarItem(db,auth,{kind:"youtube",id:legacyId},{action:"schedule",version:1,scheduledAt:future},queue)).status,200);
    assert.equal((await mutateCalendarItem(db,auth,{kind:"youtube",id:legacyId},{action:"edit",version:2,settings:{videoUrl:"https://files.example.com/replacement.mp4",coverUrl:"https://files.example.com/new-cover.png"}},queue)).status,200);
    const [edited]=await db.select().from(schema.youtubeItems).where(eq(schema.youtubeItems.id,legacyId));
    assert.equal(edited.status,"waiting_video");assert.equal(edited.approvedAt,null);assert.equal(edited.settings.videoMediaId,undefined);
    assert.equal(edited.settings.remoteVideo,undefined);assert.equal(edited.settings.sourceVideoUrl,"https://files.example.com/replacement.mp4");
    assert.equal(jobs.at(-1)?.name,"youtube-prepare");
    await db.delete(schema.youtubeItems).where(eq(schema.youtubeItems.id,legacyId));
    const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{"Content-Type":"application/json"}});
    let uploadSessions=0,thumbnailFails=true;const uploads:Uint8Array[]=[];
    const request=(async(url:unknown,init:RequestInit={})=>{
      const path=String(url);
      if(path.includes("uploadType=resumable")){uploadSessions++;assert.equal(JSON.parse(String(init.body)).status.privacyStatus,"public");return new Response(null,{headers:{location:"https://www.googleapis.com/upload/youtube/v3/videos?upload_id=test"}});}
      if(init.method==="PUT"){uploads.push(init.body as Uint8Array);return json({id:"confirmed-video"});}
      if(path.includes("thumbnails/set")){if(thumbnailFails)return new Response(JSON.stringify({error:{message:"thumbnail temporarily failed"}}),{status:503,headers:{"Content-Type":"application/json"}});return json({items:[]});}
      if(path.includes("processingDetails"))return json({items:[{status:{privacyStatus:"public",uploadStatus:"processed"},processingDetails:{processingStatus:"succeeded"}}]});
      throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch;
    const publishServices:Parameters<typeof executeYoutube>[3]={operational:assertWorkspaceOperational,transport:async()=>({fetch:request,close:async()=>{}} as any),token:async()=>({token:"test-token",privateOnly:true,account:{} as any}),openVideo,inspectRemote:inspectRemoteVideo,fetchMedia,pause:async()=>{},playlist:async()=>undefined};
    await executeYoutube(item.id,db,item.queueVersion,publishServices);assert.equal(uploadSessions,0); // human approval is mandatory
    const approve=()=>app.inject({method:"POST",url:`/youtube/items/${item.id}/resolve`,payload:{action:"approve"}});
    const approved=await approve();assert.equal(approved.statusCode,200,approved.body);assert.equal(jobs.at(-1)?.name,"youtube-publish");
    assert.equal((await approve()).statusCode,409);
    sourceChanged=true;
    await assert.rejects(executeYoutube(item.id,db,item.queueVersion,publishServices),/تغییر/);assert.equal(uploadSessions,0);
    sourceChanged=false;assert.equal((await app.inject({method:"POST",url:`/youtube/items/${item.id}/retry`})).statusCode,200);
    [item]=await db.select().from(schema.youtubeItems);assert.equal(item.status,"waiting_video");assert.equal(item.approvedAt,null);
    await prepareCollectionVideo(item.id,item.queueVersion,db,services);
    assert.equal((await approve()).statusCode,200);
    await assert.rejects(executeYoutube(item.id,db,item.queueVersion,publishServices),/503/);
    [item]=await db.select().from(schema.youtubeItems);assert.equal(item.videoId,"confirmed-video");assert.equal(item.status,"failed");assert.equal(item.settings.publicationFailureStage,"cover_upload");
    thumbnailFails=false;
    assert.equal((await app.inject({method:"POST",url:`/youtube/items/${item.id}/retry`})).statusCode,200);
    await executeYoutube(item.id,db,item.queueVersion,publishServices);
    [item]=await db.select().from(schema.youtubeItems);assert.equal(item.status,"published");assert.equal(item.videoId,"confirmed-video");assert.equal(item.actualPrivacy,"public");
    assert.equal(uploadSessions,1);assert.deepEqual(Buffer.concat(uploads),video);
    await executeYoutube(item.id,db,item.queueVersion,publishServices);assert.equal(uploadSessions,1);
    const again=await app.inject({method:"POST",url:"/content-collections/preview",payload:scope});assert.equal(again.json().changes[0].kind,"unchanged");assert.equal((await db.select().from(schema.youtubeItems)).length,1);
    // No preparation, approval, publication or thumbnail retry touched the configured media path.
    assert.equal((await stat(process.env.YOUTUBE_MEDIA_DIR!)).isFile(),true);
    assert.equal(await readFile(process.env.YOUTUBE_MEDIA_DIR!,"utf8"),"no media directory");
    // An already-started upload is never reset or sent back for preparation, even after an origin change.
    await db.update(schema.youtubeItems).set({status:"failed",videoId:null,sessionEnc:"preserved-session",settings:{...item.settings,remoteVideoChanged:true}}).where(eq(schema.youtubeItems.id,item.id));
    assert.equal((await app.inject({method:"POST",url:`/youtube/items/${item.id}/retry`})).statusCode,200);
    [item]=await db.select().from(schema.youtubeItems);assert.equal(item.status,"queued");assert.ok(item.approvedAt);assert.equal(item.sessionEnc,"preserved-session");assert.equal(jobs.at(-1)?.name,"youtube-publish");
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
