import { test,before,after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as tables from "@socialyar/db/schema";
import { getDb } from "@socialyar/db";
import { reconcileDispatch, type DispatchRecoveryOptions } from "./dispatch-recovery";
const engine=new PGlite(),db=drizzle(engine,{schema:tables});
const workspaceId=randomUUID(),workflowId=randomUUID(),versionId=randomUUID(),accountId=randomUUID();
const now=new Date("2028-01-01T12:00:00Z"),old=new Date("2028-01-01T11:00:00Z");
before(async()=>{
 for(const name of ["0000_initial.sql","0001_auth.sql","0002_eitaa_automation.sql","0006_youtube.sql","0008_publication_calendar.sql","0011_execution_recovery.sql", "0012_tenant_access.sql"])await engine.exec(await readFile(new URL(`../../../packages/db/migrations/${name}`,import.meta.url),"utf8"));
 const userId=randomUUID();await db.insert(tables.users).values({id:userId,email:"dispatch-test@example.com"});
 await db.insert(tables.workspaces).values({id:workspaceId,name:"test",slug:"dispatch-test",ownerId:userId});
 await db.insert(tables.workspaceSubscriptions).values({workspaceId});
 await db.insert(tables.workflows).values({id:workflowId,workspaceId,name:"test"});await db.insert(tables.workflowVersions).values({id:versionId,workflowId,version:1});
 await db.insert(tables.socialAccounts).values({id:accountId,workspaceId,channel:"telegram",externalAccountId:"test"});
});after(async()=>{await engine.close();});
function queues(){const workflowJobs:any[]=[],publicationJobs:any[]=[],prepared:string[]=[],recovered:any[]=[],slots:any[]=[],active=new Map<string,string>();
 const make=(jobs:any[])=>({getJob:async(id:string)=>active.has(id)?{getState:async()=>active.get(id),remove:async()=>{active.delete(id);}}:undefined,add:async(...args:any[])=>{jobs.push(args);active.set(args[2].jobId,"waiting");return {};} });
 const options:DispatchRecoveryOptions={database:db as unknown as ReturnType<typeof getDb>,workflowQueue:make(workflowJobs) as any,publicationQueue:make(publicationJobs) as any,prepare:async(id)=>{prepared.push(id);},recover:async(input)=>{recovered.push(input);},reserveSlot:async(...args)=>{slots.push(args);return 1500;}};
 return {options,workflowJobs,publicationJobs,prepared,recovered,slots,active};}
async function publication(status:"queued"|"publishing",variantStatus:"approved"|"waiting_approval",date?:Date){
 const [content]=await db.insert(tables.contentItems).values({workspaceId,body:"متن"}).returning();const [variant]=await db.insert(tables.contentVariants).values({contentItemId:content.id,channel:"telegram",body:"متن",status:variantStatus,settings:{publishIntervalSeconds:45,pacedInQueue:true}}).returning();
 const schedule=date?(await db.insert(tables.schedules).values({workspaceId,contentVariantId:variant.id,socialAccountId:accountId,scheduledAt:date}).returning())[0]:undefined;
 return (await db.insert(tables.publications).values({workspaceId,contentVariantId:variant.id,socialAccountId:accountId,scheduleId:schedule?.id,status,queueVersion:7,attempt:2,createdAt:old,updatedAt:old}).returning())[0];}
test("queued run dispatch uses exact generation and preserves existing active jobs",async()=>{
 const id=randomUUID();await db.insert(tables.runs).values({id,workflowId,workflowVersionId:versionId,status:"queued",dispatchVersion:4,createdAt:old});const q=queues();
 await reconcileDispatch(q.options,now);assert.equal(q.workflowJobs.length,1);assert.equal(q.workflowJobs[0][2].jobId,`run-${id}-dispatch-4`);assert.equal(q.workflowJobs[0][1].workflowVersionId,versionId);
 await reconcileDispatch(q.options,now);assert.equal(q.workflowJobs.length,1);
});
test("publication recovery enqueues due approved generation and skips future or unapproved items",async()=>{
 const due=await publication("queued","approved",old),future=await publication("queued","approved",new Date("2028-01-02T00:00:00Z")),unapproved=await publication("queued","waiting_approval");const q=queues();
 await reconcileDispatch(q.options,now);assert.deepEqual(q.publicationJobs.map(job=>job[1].publicationId),[due.id]);assert.equal(q.publicationJobs[0][1].queueVersion,7);assert.equal(q.publicationJobs[0][2].jobId,`publication-${due.id}-v7`);assert.equal(q.publicationJobs[0][2].delay,1500);assert.deepEqual(q.slots,[[accountId,45]]);
 assert.ok(!q.publicationJobs.some(job=>[future.id,unapproved.id].includes(job[1].publicationId)));
 await reconcileDispatch(q.options,now);assert.equal(q.publicationJobs.length,1);
});
test("unfinished publication preparation and interrupted sending use dedicated recovery callbacks",async()=>{
 const id=randomUUID();await db.insert(tables.runs).values({id,workflowId,workflowVersionId:versionId,status:"completed",output:{publishNews:{queuedForPublication:true}},finishedAt:old});
 const ignored=randomUUID();await db.insert(tables.runs).values({id:ignored,workflowId,workflowVersionId:versionId,status:"completed",output:{publicationPrepared:true,publishNews:{queuedForPublication:true}},finishedAt:old});
 const interrupted=await publication("publishing","approved");const q=queues();await reconcileDispatch(q.options,now);
 assert.deepEqual(q.prepared,[id]);assert.deepEqual(q.recovered,[{publicationId:interrupted.id,queueVersion:7,attempt:3,maxAttempts:3}]);assert.ok(!q.publicationJobs.some(job=>job[1].publicationId===interrupted.id));
});
