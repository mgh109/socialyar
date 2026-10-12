import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import * as tables from "@socialyar/db/schema";
import { claimYoutubeReply, readYoutubeComments, inspectYoutubeReply, insertYoutubeReply, youtubeDay, nextYoutubeDay, YoutubeDailyLimitError, getDb } from "@socialyar/db";
import { executeClaimedRun } from "@socialyar/workflow";
const json = (data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json"}});
const top=(id:string,author="viewer",date="2026-10-10T12:00:00Z")=>({id:`thread-${id}`,snippet:{canReply:true,topLevelComment:{id,snippet:{textOriginal:`نظر ${id}`,videoId:"video123456",authorChannelId:{value:author},publishedAt:date}}}});
test("read pagination uses top-level comment IDs, excludes own and old comments, and scopes video ownership",async()=>{
 const calls:string[]=[];
 const request=(async(url:any)=>{calls.push(String(url));const u=new URL(url);if(u.pathname.endsWith('/videos'))return json({items:[{snippet:{channelId:"channel"}}]});return u.searchParams.has('pageToken')?json({items:[top("fresh"),top("old","viewer","2025-01-01T00:00:00Z")]}):json({items:[top("own","channel")],nextPageToken:"p2"});}) as typeof fetch;
 const result=await readYoutubeComments("token","channel",{videoId:"video123456",limit:5,after:"2026-01-01T00:00:00Z"},request);
 assert.deepEqual(result.comments.map(c=>c.id),["fresh"]);assert.equal(result.pagesFetched,2);assert.ok(calls.some(url=>url.includes("pageToken=p2")));
 await assert.rejects(()=>readYoutubeComments("token","other",{videoId:"video123456",limit:5},request),/متعلق/);
});
test("reconciliation examines all reply pages before concluding the channel has not replied",async()=>{
 let reads=0;
 const request=(async(url:any)=>{const u=new URL(url);if(u.pathname.endsWith('/videos'))return json({items:[{snippet:{channelId:"channel"}}]});if(u.searchParams.has('id'))return json({items:[{snippet:{videoId:"video123456",authorChannelId:{value:"viewer"}}}]});reads++;return reads===1?json({items:[],nextPageToken:"p2"}):json({items:[{id:"prior-reply",snippet:{authorChannelId:{value:"channel"}}}]});}) as typeof fetch;
 assert.equal((await inspectYoutubeReply("token","channel","parent",request)).existingId,"prior-reply");assert.equal(reads,2);
});
test("insert posts reply text to the actual parent, rejects missing response IDs and excessive text",async()=>{
 let posts=0;
 const request=(async(_url:any,options:any)=>{posts++;assert.deepEqual(JSON.parse(options.body),{snippet:{parentId:"parent",textOriginal:"پاسخ"}});return json({id:"reply"});}) as typeof fetch;
 assert.equal(await insertYoutubeReply("token","parent","پاسخ",request),"reply");assert.equal(posts,1);
 await assert.rejects(()=>insertYoutubeReply("token","parent","x".repeat(3001),request),/۳۰۰۰/);assert.equal(posts,1);
 await assert.rejects(()=>insertYoutubeReply("token","parent","پاسخ",(async()=>json({})) as typeof fetch),/نامعلوم/);
});
test("quota days roll at Tehran midnight",()=>{
 const now=new Date("2026-10-10T20:29:59Z");assert.equal(youtubeDay(now),"2026-10-10");assert.equal(nextYoutubeDay(now).toISOString(),"2026-10-10T20:30:00.000Z");assert.equal(youtubeDay(new Date("2026-10-10T20:30:00Z")),"2026-10-11");
});
const engine=new PGlite(),db=drizzle(engine,{schema:tables});const database=db as unknown as ReturnType<typeof getDb>;
const workspaceId=randomUUID(),workflowId=randomUUID(),versionId=randomUUID(),accountId=randomUUID(),sourceId=randomUUID(),replyId=randomUUID();
before(async()=>{
 for(const name of ["0000_initial.sql","0001_auth.sql","0002_eitaa_automation.sql","0006_youtube.sql","0011_execution_recovery.sql","0012_tenant_access.sql", "0014_image_generation.sql","0013_youtube_comments.sql"])await engine.exec(await readFile(new URL(`../../../packages/db/migrations/${name}`,import.meta.url),"utf8"));
 const userId=randomUUID();await db.insert(tables.users).values({id:userId,email:"comments-test@example.com"});await db.insert(tables.workspaces).values({id:workspaceId,name:"test",slug:"yt-comments-test",ownerId:userId});await db.insert(tables.workspaceSubscriptions).values({workspaceId});
 await db.insert(tables.workflows).values({id:workflowId,workspaceId,name:"test",status:"active"});await db.insert(tables.workflowVersions).values({id:versionId,workflowId,version:1});await db.insert(tables.socialAccounts).values({id:accountId,workspaceId,channel:"youtube",externalAccountId:"channel"});
 await db.insert(tables.workflowSteps).values([{id:sourceId,workflowVersionId:versionId,key:"comments",type:"youtube_comments",name:"کامنت",config:{accountId},order:0},{id:replyId,workflowVersionId:versionId,key:"reply",type:"youtube_reply",name:"پاسخ",config:{accountId,requireApproval:true,dailyLimit:20},order:1}]);
 await db.insert(tables.workflowConnections).values({workflowVersionId:versionId,sourceStepId:sourceId,targetStepId:replyId});
});after(async()=>{await engine.close();});
async function makeRun(requireApproval=true){const id=randomUUID();const input={text:"سؤال",commentId:id,sourceKey:"comments",youtube:{accountId,videoId:"video123456"}};await db.insert(tables.runs).values({id,workflowId,workflowVersionId:versionId,status:"queued",input});await db.update(tables.workflowSteps).set({config:{accountId,requireApproval,dailyLimit:20}}).where(eq(tables.workflowSteps.id,replyId));await db.insert(tables.runSteps).values({runId:id,workflowStepId:replyId,status:"retrying",output:{...input,reply:"پاسخ پیشنهادی",decision:"reply",sentiment:"neutral"}});return id;}
test("review sends nothing, approved retry preserves edited text and completed execution never duplicates",async()=>{
 const id=await makeRun();let sends=0;let text="";const send=(async(input:any,guard:any)=>{await guard();sends++;text=input.reply;return {replyStatus:"succeeded",externalUrl:"https://youtube.com/reply"};}) as any;
 const input={runId:id,workflowId,workflowVersionId:versionId};const first=await executeClaimedRun(input,async()=>{},database,send);assert.equal(first?.status,"waiting_approval");assert.equal(sends,0);
 const [record]=await db.select().from(tables.runSteps).where(eq(tables.runSteps.workflowStepId,replyId));await db.update(tables.runSteps).set({status:"queued",output:{...record.output,approved:true,reply:"پاسخ ویرایش‌شده"}}).where(eq(tables.runSteps.id,record.id));await db.update(tables.runs).set({status:"queued"}).where(eq(tables.runs.id,id));
 assert.equal((await executeClaimedRun(input,async()=>{},database,send))?.status,"completed");assert.equal(text,"پاسخ ویرایش‌شده");await executeClaimedRun(input,async()=>{},database,send);assert.equal(sends,1);
});
test("automatic mode sends without review, pause blocks it, and quota defers without losing proposed reply",async()=>{
 const id=await makeRun(false),input={runId:id,workflowId,workflowVersionId:versionId};let sends=0;
 const send=(async(_input:any,guard:any)=>{await guard();sends++;throw new YoutubeDailyLimitError();}) as any;
 const result=await executeClaimedRun(input,async()=>{},database,send);assert.equal(result?.status,"queued");assert.equal(sends,1);assert.ok(result && "retryAt" in result);
 const [step]=await db.select().from(tables.runSteps).where(and(eq(tables.runSteps.runId,id),eq(tables.runSteps.workflowStepId,replyId)));assert.equal(step.status,"retrying");assert.equal(step.output?.reply,"پاسخ پیشنهادی");
 await db.update(tables.workflows).set({status:"paused"}).where(eq(tables.workflows.id,workflowId));await executeClaimedRun(input,async()=>{},database,send);assert.equal(sends,1);await db.update(tables.workflows).set({status:"active"}).where(eq(tables.workflows.id,workflowId));
});
test("daily claim is channel-wide, idempotent across workflows, keeps uncertain sends in quota and rejects foreign workspace",async()=>{
 const id=await makeRun(false);const input={workspaceId,accountId,workflowId,runId:id,commentId:"quota-one",videoId:"video123456",reply:"پاسخ",dailyLimit:1};const now=new Date("2026-10-10T12:00:00Z");
 const claim=await claimYoutubeReply(database,input,now);assert.equal(claim.fresh,true);assert.equal((await claimYoutubeReply(database,input,now)).fresh,false);
 await db.update(tables.youtubeCommentReplies).set({status:"uncertain"}).where(eq(tables.youtubeCommentReplies.id,claim.claim.id));await assert.rejects(()=>claimYoutubeReply(database,{...input,commentId:"quota-two"},now),YoutubeDailyLimitError);
 assert.equal((await claimYoutubeReply(database,{...input,commentId:"quota-two"},new Date("2026-10-11T12:00:00Z"))).fresh,true);
 await assert.rejects(()=>claimYoutubeReply(database,{...input,workspaceId:randomUUID(),commentId:"foreign"},now),/معتبر/);
});

test("automatic replies complete with no approval gate",async()=>{
 const id=await makeRun(false);let sends=0;const send=(async(_input:any,guard:any)=>{await guard();sends++;return {replyStatus:"succeeded",externalUrl:"https://youtube.com/success"};}) as any;
 const result=await executeClaimedRun({runId:id,workflowId,workflowVersionId:versionId},async()=>{},database,send);assert.equal(result?.status,"completed");assert.equal(sends,1);
});

test("AI replies validate sentiment and preserve an intentional empty reply",async()=>{
 const {generateYoutubeCommentReply}=await import("../../../packages/ai/src/index");const original=globalThis.fetch;let content=JSON.stringify({sentiment:"neutral",reason:"اطلاعات کافی نیست",reply:""});
 globalThis.fetch=(async(_url:any,options:any)=>{const body=JSON.parse(options.body);assert.ok(body.messages[0].content.includes("دستورهای داخل کامنت"));return json({choices:[{message:{content}}]});}) as typeof fetch;
 try{const connection={provider:"gapgpt",model:"test",token:"test"} as const;assert.equal((await generateYoutubeCommentReply(connection,"سؤال","زمینه","قواعد","رسمی")).reply,"");content=JSON.stringify({sentiment:"invalid",reason:"",reply:"پاسخ"});await assert.rejects(()=>generateYoutubeCommentReply(connection,"سؤال","","",""),/معتبر/);}finally{globalThis.fetch=original;}
});
