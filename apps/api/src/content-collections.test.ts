import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as tables from "@socialyar/db/schema";
import { getDb } from "@socialyar/db";
import { contentCollectionRoutes } from "./routes/content-collections";
import { connection } from "./queue";
import type { CollectionRow, CollectionChange } from "@socialyar/shared";
const engine = new PGlite(); const db=drizzle(engine,{ schema:tables }); const app=Fastify();
const userId=randomUUID(),workspaceId=randomUUID(),otherWorkspaceId=randomUUID(),workflowId=randomUUID(),versionId=randomUUID(),accountId=randomUUID(),sourceId=randomUUID(),targetId=randomUUID();
const scope={ workflowId,sourceStepKey:"sheet",targetStepKey:"youtube" };
const jobs: unknown[]=[];
const row=(id="one",order=1): CollectionRow => ({ id,order,title:`قسمت ${order}`,description:"توضیحات",videoUrl:`https://files.example.com/${id}.mp4`,coverUrl:"",scheduledAt:"2028-01-01T14:30:00.000Z",videoType:"video",playlist:"مجموعه",tags:[],privacy:"private",madeForKids:false });
before(async()=>{
  connection.disconnect();
  for (const name of ["0000_initial.sql","0001_auth.sql","0002_eitaa_automation.sql","0006_youtube.sql","0007_publishing_proxies.sql","0008_publication_calendar.sql","0009_content_collections.sql","0011_execution_recovery.sql"])
    await engine.exec(await readFile(new URL(`../../../packages/db/migrations/${name}`,import.meta.url),"utf8"));
  // Additive publishing migrations must be safe on the next rollout too.
  await engine.exec(await readFile(new URL("../../../packages/db/migrations/0009_content_collections.sql",import.meta.url),"utf8"));
  await db.insert(tables.users).values({ id:userId,email:"collection-test@example.com" });
  await db.insert(tables.workspaces).values([{ id:workspaceId,name:"test",slug:"test",ownerId:userId },{ id:otherWorkspaceId,name:"other",slug:"other",ownerId:userId }]);
  await db.insert(tables.socialAccounts).values({ id:accountId,workspaceId,channel:"youtube",externalAccountId:"test-channel",displayName:"کانال تست" });
  await db.insert(tables.workflows).values({ id:workflowId,workspaceId,name:"مجموعه" });
  await db.insert(tables.workflowVersions).values({ id:versionId,workflowId,version:1 });
  await db.insert(tables.workflowSteps).values([{ id:sourceId,workflowVersionId:versionId,key:"sheet",type:"collection_source",name:"اکسل" },{ id:targetId,workflowVersionId:versionId,key:"youtube",type:"publish",name:"یوتیوب",config:{ accountId } }]);
  await db.insert(tables.workflowConnections).values({ workflowVersionId:versionId,sourceStepId:sourceId,targetStepId:targetId });
  app.decorate("authenticate",async(request: any)=>{ request.auth={ userId,email:"test@example.com",workspaceId:request.headers["x-other"] ? otherWorkspaceId : workspaceId }; });
  app.setErrorHandler((error,_request,reply)=>reply.code(400).send({ error:error instanceof Error ? error.message : "خطا" }));
  await app.register(contentCollectionRoutes,{ database:db as unknown as ReturnType<typeof getDb>,queue:{ add:async (...args:unknown[])=>{ jobs.push(args);return {} as any; } } });
});
after(async()=>{await app.close();await engine.close();});
const preview=async(rows:CollectionRow[],extra={})=>{
  const result=await app.inject({ method:"POST",url:"/content-collections/preview",payload:{ ...scope,rows,...extra } });assert.equal(result.statusCode,200,result.body);return result.json() as { revision:number;changes:CollectionChange[] };
};
const apply=async(rows:CollectionRow[],p:Awaited<ReturnType<typeof preview>>, ids:string[],extra={})=>app.inject({ method:"POST",url:"/content-collections/apply",payload:{ ...scope,rows,...extra,revision:p.revision,selected:p.changes.filter((c)=>ids.includes(c.id)).map(({ id,version,updatedAt })=>({ id,version,updatedAt })) } });
test("preview is read-only; apply creates stable identities, media jobs and unapproved calendar outputs",async()=>{
  const rows=[row(),row("two",2)];const p=await preview(rows);
  assert.equal((await db.select().from(tables.youtubeItems)).length,0);assert.equal(p.changes.length,2);
  const result=await apply(rows,p,["one","two"]);assert.equal(result.statusCode,200,result.body);
  const items=await db.select().from(tables.youtubeItems);assert.equal(items.length,2);assert.equal(jobs.length,2);
  for(const item of items){assert.equal(item.status,"waiting_video");assert.equal(item.approvedAt,null);assert.ok(item.settings.collectionId);assert.equal(item.scheduledAt?.toISOString(),row().scheduledAt);}
  assert.equal((await db.select().from(tables.collectionImportEvents)).length,1);
});
test("identical reimports create no duplicate video, and unselected missing rows remain active",async()=>{
  const p=await preview([row(),row("two",2)]);assert.ok(p.changes.every((c)=>c.kind==="unchanged"));
  const withNew=[row(),row("three",3)];const next=await preview(withNew);assert.equal(next.changes.find((c)=>c.id==="two")?.kind,"removed");
  const result=await apply(withNew,next,["three"]);assert.equal(result.statusCode,200,result.body);
  assert.equal((await db.select().from(tables.youtubeItems)).length,3);
  const [collection]=await db.select().from(tables.contentCollections);assert.equal(collection.records.find((r)=>r.row.id==="two")?.active,true);
});
test("partial files disable inferred removals and stale collection revisions cannot apply",async()=>{
  const p=await preview([row()],{ detectRemovals:false });assert.ok(p.changes.every((c)=>c.kind!=="removed"));
  const changed=[{ ...row(),title:"عنوان جدید" },row("two",2),row("three",3)];const old=await preview(changed);
  const ok=await apply(changed,old,["one"]);assert.equal(ok.statusCode,200,ok.body);
  const stale=await apply(changed,old,["one"]);assert.equal(stale.statusCode,409);
});
test("calendar edits after preview cause a conflict rather than being overwritten",async()=>{
  const rows=[{ ...row(),title:"ویرایش دوم" },row("two",2),row("three",3)];const p=await preview(rows);
  const change=p.changes.find((c)=>c.id==="one")!;
  await db.update(tables.youtubeItems).set({ queueVersion:change.version!+1,updatedAt:new Date("2027-01-01T00:00:00Z") }).where(eq(tables.youtubeItems.id,change.itemId!));
  const result=await apply(rows,p,["one"]);assert.equal(result.statusCode,409);
});
test("editing an approved queued row revokes approval, invalidates the old job and preserves unchanged calendar fields",async()=>{
  const [collection]=await db.select().from(tables.contentCollections);const record=collection.records.find((r)=>r.row.id==="two")!;
  await db.update(tables.youtubeItems).set({ status:"queued",approvedAt:new Date(),approvedBy:userId,title:"عنوان ویرایش‌شده در تقویم",
    settings:{ videoMediaId:"a".repeat(64),collectionId:collection.id,videoType:"video",privacy:"private" },queueVersion:8 }).where(eq(tables.youtubeItems.id,record.itemId));
  const rows=[{ ...row(),title:"عنوان جدید" },{ ...row("two",2),description:"توضیحات تازه" },row("three",3)];const p=await preview(rows);
  const result=await apply(rows,p,["two"]);assert.equal(result.statusCode,200,result.body);
  const [item]=await db.select().from(tables.youtubeItems).where(eq(tables.youtubeItems.id,record.itemId));
  assert.equal(item.approvedAt,null);assert.equal(item.queueVersion,9);assert.equal(item.title,"عنوان ویرایش‌شده در تقویم");assert.equal(item.description,"توضیحات تازه");assert.equal(item.status,"waiting_approval");
});
test("confirmed removals stop the same item and restores reuse that identity",async()=>{
  const rows=[{ ...row(),title:"عنوان جدید" },{ ...row("two",2),description:"توضیحات تازه" }];const p=await preview(rows);
  const removed=p.changes.find((c)=>c.id==="three")!;const result=await apply(rows,p,["three"]);assert.equal(result.statusCode,200,result.body);
  let [item]=await db.select().from(tables.youtubeItems).where(eq(tables.youtubeItems.id,removed.itemId!));assert.equal(item.status,"cancelled");
  const restore=await preview([...rows,row("three",3)]);assert.equal(restore.changes.find((c)=>c.id==="three")?.kind,"changed");
  assert.equal((await apply([...rows,row("three",3)],restore,["three"])).statusCode,200);
  [item]=await db.select().from(tables.youtubeItems).where(eq(tables.youtubeItems.id,removed.itemId!));assert.equal(item.id,removed.itemId);assert.equal((await db.select().from(tables.youtubeItems)).length,3);
});
test("workspace isolation and detached cards reject requests",async()=>{
  const denied=await app.inject({ method:"POST",url:"/content-collections/preview",headers:{ "x-other":"1" },payload:{ ...scope,rows:[row()] } });assert.equal(denied.statusCode,409);
  const list=await app.inject({ method:"GET",url:`/content-collections?workflowId=${workflowId}&sourceStepKey=sheet`,headers:{ "x-other":"1" } });assert.deepEqual(list.json(),[]);
  const invalid=await app.inject({ method:"POST",url:"/content-collections/preview",payload:{ ...scope,targetStepKey:"absent",rows:[row()] } });assert.equal(invalid.statusCode,409);
});

const genericAccounts=new Map<string,string>();
async function genericScope(channel:"telegram"|"eitaa"|"bale"|"instagram") {
  let id=genericAccounts.get(channel);if(!id){id=randomUUID();genericAccounts.set(channel,id);await db.insert(tables.socialAccounts).values({id,workspaceId,channel,externalAccountId:channel});const step=randomUUID();await db.insert(tables.workflowSteps).values({id:step,workflowVersionId:versionId,key:channel,type:"publish",name:channel,config:{accountId:id}});await db.insert(tables.workflowConnections).values({workflowVersionId:versionId,sourceStepId:sourceId,targetStepId:step});}
  return {...scope,targetStepKey:channel};
}
async function genericPreview(target:object,rows:CollectionRow[]) {
  const r=await app.inject({method:"POST",url:"/content-collections/preview",payload:{...target,rows}});assert.equal(r.statusCode,200,r.body);return r.json() as {revision:number;changes:CollectionChange[]};
}
async function genericApply(target:object,rows:CollectionRow[],p:Awaited<ReturnType<typeof genericPreview>>,ids:string[]) {
  return app.inject({method:"POST",url:"/content-collections/apply",payload:{...target,rows,revision:p.revision,selected:p.changes.filter((c)=>ids.includes(c.id)).map(({id,version,updatedAt})=>({id,version,updatedAt}))}});
}
test("shared source creates separate unapproved outputs and real schedules for all four networks",async()=>{
  await engine.exec(await readFile(new URL("../../../packages/db/migrations/0010_shared_collections.sql",import.meta.url),"utf8"));
  await engine.exec(await readFile(new URL("../../../packages/db/migrations/0010_shared_collections.sql",import.meta.url),"utf8"));
  const beforeJobs=jobs.length;const rows=[row("shared")];const variants:string[]=[];
  for(const channel of ["telegram","eitaa","bale","instagram"] as const){const target=await genericScope(channel);const p=await genericPreview(target,rows);const result=await genericApply(target,rows,p,["shared"]);assert.equal(result.statusCode,200,result.body);
    const [collection]=await db.select().from(tables.contentCollections).where(eq(tables.contentCollections.targetStepKey,channel));variants.push(collection.records[0].itemId);
    const [variant]=await db.select().from(tables.contentVariants).where(eq(tables.contentVariants.id,collection.records[0].itemId));assert.equal(variant.status,"waiting_approval");assert.equal(variant.generatedBy,"collection");assert.equal(variant.channel,channel);assert.equal(variant.settings.calendarHold,true);
    const [publication]=await db.select().from(tables.publications).where(eq(tables.publications.contentVariantId,variant.id));assert.equal(publication.status,"cancelled");assert.equal(publication.socialAccountId,genericAccounts.get(channel));
    const [schedule]=await db.select().from(tables.schedules).where(eq(tables.schedules.id,publication.scheduleId!));assert.equal(schedule.scheduledAt.toISOString(),rows[0].scheduledAt);
    assert.equal((await genericPreview(target,rows)).changes[0].kind,"unchanged");
  }
  assert.equal(new Set(variants).size,4);assert.equal(jobs.length,beforeJobs); // imports never enqueue unapproved generic outputs
});
test("published destination is locked while another destination remains editable",async()=>{
  const telegram=await genericScope("telegram"),bale=await genericScope("bale");const rows=[{...row("shared"),title:"ویرایش مشترک"}];
  const p=await genericPreview(telegram,[row("shared")]);const id=p.changes[0].itemId!;
  await db.update(tables.publications).set({status:"published",externalId:"remote-1"}).where(eq(tables.publications.contentVariantId,id));
  await db.update(tables.contentVariants).set({status:"published"}).where(eq(tables.contentVariants.id,id));
  const locked=await genericPreview(telegram,rows);assert.ok(locked.changes[0].blocked);assert.equal(locked.changes[0].remoteEligible,false);assert.equal((await genericApply(telegram,rows,locked,["shared"])).statusCode,409);
  const editable=await genericPreview(bale,rows);assert.equal(editable.changes[0].blocked,null);assert.equal((await genericApply(bale,rows,editable,["shared"])).statusCode,200);
});
test("generic updates revoke approval and invalidate jobs while preserving calendar edits",async()=>{
  const target=await genericScope("eitaa");const p=await genericPreview(target,[row("shared")]);const id=p.changes[0].itemId!;
  await db.update(tables.contentVariants).set({status:"scheduled",title:"ویرایش در تقویم"}).where(eq(tables.contentVariants.id,id));
  await db.update(tables.publications).set({status:"queued",queueVersion:5}).where(eq(tables.publications.contentVariantId,id));
  const rows=[{...row("shared"),description:"متن جدید"}],next=await genericPreview(target,rows);assert.equal((await genericApply(target,rows,next,["shared"])).statusCode,200);
  const [variant]=await db.select().from(tables.contentVariants).where(eq(tables.contentVariants.id,id));assert.equal(variant.status,"waiting_approval");assert.equal(variant.title,"ویرایش در تقویم");assert.equal(variant.body,"متن جدید");
  const [publication]=await db.select().from(tables.publications).where(eq(tables.publications.contentVariantId,id));assert.equal(publication.status,"cancelled");assert.equal(publication.queueVersion,6);
  const stale=await genericApply(target,rows,next,["shared"]);assert.equal(stale.statusCode,409);
});
test("unknown delivery and active send cannot be silently overwritten or removed",async()=>{
  const target=await genericScope("instagram");const p=await genericPreview(target,[row("shared")]);const id=p.changes[0].itemId!;
  for(const patch of [{status:"publishing" as const},{status:"failed" as const,error:{deliveryUnknown:true}}]){
    await db.update(tables.publications).set(patch).where(eq(tables.publications.contentVariantId,id));const next=await genericPreview(target,[]);assert.ok(next.changes[0].blocked);assert.equal((await genericApply(target,[],next,["shared"])).statusCode,409);
  }
});
test("generic deletion and restore reuse identity; text-only imports work and media-required destinations reject them",async()=>{
  const target=await genericScope("bale");const p=await genericPreview(target,[]);assert.equal((await genericApply(target,[],p,["shared"])).statusCode,200);
  const restore=await genericPreview(target,[{...row("shared"),videoUrl:""}]);assert.equal(restore.changes[0].kind,"changed");assert.equal((await genericApply(target,[{...row("shared"),videoUrl:""}],restore,["shared"])).statusCode,200);assert.equal((await genericPreview(target,[{...row("shared"),videoUrl:""}])).changes[0].itemId,restore.changes[0].itemId);
  for(const destination of [scope,await genericScope("instagram")]){const r=await app.inject({method:"POST",url:"/content-collections/preview",payload:{...destination,rows:[{...row("text"),videoUrl:"",coverUrl:""}]}});assert.equal(r.statusCode,409);}
});
test("server polling stages Google Sheets revisions without importing or approving, and honors refresh interval",async()=>{
  const {pollCollectionSheets}=await import("../../worker/src/collection-sheet-poller");
  await db.update(tables.workflows).set({status:"active"}).where(eq(tables.workflows.id,workflowId));
  await db.update(tables.workflowSteps).set({config:{collectionSource:"google_sheet",sheetUrl:"https://docs.google.com/spreadsheets/d/abc/edit",sheetGid:"2",sheetAutoRefresh:true,sheetRefreshMinutes:5}}).where(eq(tables.workflowSteps.id,sourceId));
  const beforeVariants=(await db.select().from(tables.contentVariants)).length,beforeVideos=(await db.select().from(tables.youtubeItems)).length;let reads=0;
  await pollCollectionSheets(db as unknown as ReturnType<typeof getDb>,async()=>{reads++;return {headers:["id","title"],rows:[["new","عنوان تازه"]]};});
  const [snapshot]=await db.select().from(tables.collectionSheetSnapshots);assert.equal(snapshot.sheetGid,"2");assert.equal(snapshot.data?.rows[0][0],"new");assert.equal(snapshot.error,null);
  await pollCollectionSheets(db as unknown as ReturnType<typeof getDb>,async()=>{reads++;throw new Error("offline");});assert.equal(reads,1);
  assert.equal((await db.select().from(tables.contentVariants)).length,beforeVariants);assert.equal((await db.select().from(tables.youtubeItems)).length,beforeVideos);
  await db.update(tables.collectionSheetSnapshots).set({checkedAt:new Date(0)}).where(eq(tables.collectionSheetSnapshots.id,snapshot.id));
  await pollCollectionSheets(db as unknown as ReturnType<typeof getDb>,async()=>{reads++;throw new Error("خطای خواندن");});
  const [failed]=await db.select().from(tables.collectionSheetSnapshots);assert.equal(failed.data,null);assert.equal(failed.error,"خطای خواندن");
  const denied=await app.inject({method:"GET",url:`/content-collections/google-sheet/snapshot?workflowId=${workflowId}&sourceStepKey=sheet`,headers:{"x-other":"1"}});assert.equal(denied.json(),null);
});
test("a collection output flows through calendar approval and the real publisher exactly once",async()=>{
  const {mutateCalendarItem}=await import("./routes/calendar");const {executePublication}=await import("../../worker/src/publisher");const {publicationQueue}=await import("./queue");
  const {connection:workerConnection}=await import("../../worker/src/queue");workerConnection.disconnect();
  const add=publicationQueue.add,getJob=publicationQueue.getJob,originalFetch=globalThis.fetch;const queued:any[]=[];let sends=0;
  publicationQueue.add=(async(...args:any[])=>{queued.push(args);return {} as any;}) as typeof add;publicationQueue.getJob=async()=>undefined;
  globalThis.fetch=async(resource)=>{assert.ok(String(resource).startsWith("https://tapi.bale.ai/botfake/sendMessage"));sends++;return Response.json({ok:true,result:{message_id:55,chat:{username:"test"}}});};
  try{
    const [collection]=await db.select().from(tables.contentCollections).where(eq(tables.contentCollections.targetStepKey,"bale"));const id=collection.records.find((r)=>r.row.id==="shared")!.itemId;
    const [variant]=await db.select().from(tables.contentVariants).where(eq(tables.contentVariants.id,id));let [publication]=await db.select().from(tables.publications).where(eq(tables.publications.contentVariantId,id));
    await db.update(tables.socialAccounts).set({credentials:{botToken:"fake",chatId:"@test"}}).where(eq(tables.socialAccounts.id,publication.socialAccountId!));
    await executePublication({publicationId:publication.id,queueVersion:publication.queueVersion,attempt:1,maxAttempts:1},db as any,async (_key,operation)=>operation(async () => {}));assert.equal(sends,0);
    const result=await mutateCalendarItem(db as any,{workspaceId,userId,email:"test@example.com"},{kind:"variant",id},{action:"approve",version:variant.calendarVersion,updatedAt:variant.updatedAt.toISOString()});assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(queued.length,1);assert.equal(queued[0][0],"publish-content");
    const oldVersion=publication.queueVersion;[publication]=await db.select().from(tables.publications).where(eq(tables.publications.id,publication.id));assert.equal(publication.status,"queued");
    await executePublication({publicationId:publication.id,queueVersion:oldVersion,attempt:1,maxAttempts:1},db as any,async (_key,operation)=>operation(async () => {}));assert.equal(sends,0);
    await executePublication({publicationId:publication.id,queueVersion:publication.queueVersion,attempt:1,maxAttempts:1},db as any,async (_key,operation)=>operation(async () => {}));assert.equal(sends,1);
    await executePublication({publicationId:publication.id,queueVersion:publication.queueVersion,attempt:1,maxAttempts:1},db as any,async (_key,operation)=>operation(async () => {}));assert.equal(sends,1);
    const [sent]=await db.select().from(tables.publications).where(eq(tables.publications.id,publication.id));assert.equal(sent.externalId,"55");assert.equal(sent.status,"published");
  }finally{publicationQueue.add=add;publicationQueue.getJob=getJob;globalThis.fetch=originalFetch;}
});
