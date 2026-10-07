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
  for (const name of ["0000_initial.sql","0001_auth.sql","0002_eitaa_automation.sql","0006_youtube.sql","0007_publishing_proxies.sql","0008_publication_calendar.sql","0009_content_collections.sql"])
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
