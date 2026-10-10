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
import { runRoutes } from "./routes/runs";
import { contentRoutes } from "./routes/content";
import { connection } from "./queue";
const engine=new PGlite();const db=drizzle(engine,{schema:tables});const app=Fastify();
const userId=randomUUID(),workspaceId=randomUUID(),workflowId=randomUUID(),versionId=randomUUID(),stepId=randomUUID();
const jobs:unknown[]=[];let queueUnavailable=false;
before(async()=>{
  connection.disconnect();
  for(const name of ["0000_initial.sql","0001_auth.sql","0002_eitaa_automation.sql","0006_youtube.sql","0007_publishing_proxies.sql","0008_publication_calendar.sql","0009_content_collections.sql","0011_execution_recovery.sql", "0012_tenant_access.sql"])
    await engine.exec(await readFile(new URL(`../../../packages/db/migrations/${name}`,import.meta.url),"utf8"));
  await db.insert(tables.users).values({id:userId,email:"run-test@example.com"});
  await db.insert(tables.workspaces).values({id:workspaceId,name:"test",slug:"run-test",ownerId:userId});
  await db.insert(tables.workflows).values({id:workflowId,workspaceId,name:"test"});
  await db.insert(tables.workflowVersions).values({id:versionId,workflowId,version:1});
  await db.insert(tables.workflowSteps).values({id:stepId,workflowVersionId:versionId,key:"review",type:"human_approval",name:"تأیید"});
  app.decorate("authenticate",async(request:any)=>{request.auth={userId,email:"test@example.com",workspaceId:request.headers["x-other"]?randomUUID():workspaceId};});
  app.setErrorHandler((error,_request,reply)=>reply.code(500).send({error:error instanceof Error ? error.message : "خطا"}));
  await app.register(contentRoutes,{database:db as unknown as ReturnType<typeof getDb>});
  await app.register(runRoutes,{database:db as unknown as ReturnType<typeof getDb>,queue:{add:async(...args:unknown[])=>{if(queueUnavailable)throw new Error("queue unavailable");jobs.push(args);return {} as any;}}});
});
after(async()=>{await app.close();await engine.close();});
async function pending(){const id=randomUUID();await db.insert(tables.runs).values({id,workflowId,workflowVersionId:versionId,status:"waiting_approval"});await db.insert(tables.runSteps).values({runId:id,workflowStepId:stepId,status:"waiting_approval",output:{text:"متن کامل"}});return id;}
const approve=(id:string)=>app.inject({method:"POST",url:`/runs/${id}/approval`,payload:{action:"approve",stepKey:"review",edit:{text:"متن ویرایش‌شده"}}});
test("concurrent approval resolves once and schedules one resume",async()=>{
 const id=await pending(),count=jobs.length;const results=await Promise.all([approve(id),approve(id)]);
 assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,409]);assert.equal(jobs.length,count+1);assert.equal((jobs[count] as any[])[2].jobId,`run-${id}-dispatch-1`);
 const [step]=await db.select().from(tables.runSteps).where(eq(tables.runSteps.runId,id));assert.equal(step.status,"completed");assert.equal(step.output?.text,"متن ویرایش‌شده");
 const events=await db.select().from(tables.runEvents).where(eq(tables.runEvents.runId,id));assert.equal(events.filter(e=>e.type==="approval_resolved").length,1);
});
test("failed approval step write rolls back the run claim and schedules nothing",async()=>{
 const id=await pending(),count=jobs.length;
 await engine.exec(`CREATE FUNCTION reject_review_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.run_id = '${id}'::uuid THEN RAISE EXCEPTION 'injected approval failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_review_write BEFORE UPDATE ON run_steps FOR EACH ROW EXECUTE FUNCTION reject_review_write();`);
 try{const response=await approve(id);assert.equal(response.statusCode,500,response.body);
 const [run]=await db.select().from(tables.runs).where(eq(tables.runs.id,id));assert.equal(run.status,"waiting_approval");
 const [step]=await db.select().from(tables.runSteps).where(eq(tables.runSteps.runId,id));assert.equal(step.status,"waiting_approval");assert.equal(jobs.length,count);
 }finally{await engine.exec("DROP TRIGGER reject_review_write ON run_steps; DROP FUNCTION reject_review_write();");}
});
test("run details keep processing completion separate from queued and uncertain deliveries",async()=>{
 const id=randomUUID();await db.insert(tables.runs).values({id,workflowId,workflowVersionId:versionId,status:"completed"});
 const [content]=await db.insert(tables.contentItems).values({workspaceId,runId:id,body:"متن"}).returning();
 for(const [channel,status,error] of [["eitaa","queued",null],["telegram","failed",{deliveryUnknown:true,message:"نامعلوم"}]] as const){
 const [variant]=await db.insert(tables.contentVariants).values({contentItemId:content.id,channel,body:"متن",status:"approved"}).returning();await db.insert(tables.publications).values({workspaceId,contentVariantId:variant.id,status,error});}
 const response=await app.inject({method:"GET",url:`/runs/${id}`});assert.equal(response.statusCode,200,response.body);
 assert.equal(response.json().status,"completed");assert.equal(response.json().publicationSummary.published,0);assert.equal(response.json().publicationSummary.queued,1);assert.equal(response.json().publicationSummary.unknown,1);
 const denied=await app.inject({method:"GET",url:`/runs/${id}`,headers:{"x-other":"1"}});assert.equal(denied.statusCode,404);
});

test("queue outage preserves durable dispatch intent and the resolved approval",async()=>{
 const id=await pending(),count=jobs.length;queueUnavailable=true;
 try{const response=await approve(id);assert.equal(response.statusCode,503,response.body);
 const [run]=await db.select().from(tables.runs).where(eq(tables.runs.id,id));assert.equal(run.status,"queued");assert.equal(run.dispatchVersion,1);
 const [step]=await db.select().from(tables.runSteps).where(eq(tables.runSteps.runId,id));assert.equal(step.status,"completed");assert.equal(jobs.length,count);
 }finally{queueUnavailable=false;}
});

test("completed dynamically named draft remains available when another branch fails",async()=>{
 const id=randomUUID(),draftId=randomUUID();
 await db.insert(tables.workflowSteps).values({id:draftId,workflowVersionId:versionId,key:"report",type:"draft",name:"گزارش"});
 await db.insert(tables.runs).values({id,workflowId,workflowVersionId:versionId,status:"failed",input:{prompt:"متن ورودی نباید خروجی باشد"},output:{report:{text:"گزارش واقعی تولیدشده"}}});
 await db.insert(tables.runSteps).values({runId:id,workflowStepId:draftId,status:"completed",output:{text:"گزارش واقعی تولیدشده"}});
 await db.insert(tables.contentItems).values({workspaceId,runId:id,body:"خروجی شاخه انتشار",metadata:{automated:true,publishStepKey:"publish-news"}});
 const responses=await Promise.all([app.inject({method:"POST",url:`/runs/${id}/content`}),app.inject({method:"POST",url:`/runs/${id}/content`})]);
 const response=responses[0];assert.equal(responses[1].statusCode,200,responses[1].body);assert.equal(response.statusCode,200,response.body);assert.equal(response.json().content.id,responses[1].json().content.id);assert.equal((await db.select().from(tables.contentItems).where(eq(tables.contentItems.runId,id))).length,2);assert.equal(response.json().content.body,"گزارش واقعی تولیدشده");assert.equal(response.json().content.metadata.draftStepKey,"report");assert.equal(response.json().variants.length,4);
 const details=await app.inject({method:"GET",url:`/runs/${id}`});assert.equal(details.json().processingSummary.hasDraft,true);
});
test("input prompt and empty draft never count as a generated draft",async()=>{
 const id=randomUUID(),draftId=randomUUID();
 await db.insert(tables.workflowSteps).values({id:draftId,workflowVersionId:versionId,key:"empty-report",type:"draft",name:"گزارش خالی"});
 await db.insert(tables.runs).values({id,workflowId,workflowVersionId:versionId,status:"completed",input:{prompt:"این فقط درخواست کاربر است"},output:{draft:{text:"خروجی ساختگی در snapshot"}}});
 await db.insert(tables.runSteps).values({runId:id,workflowStepId:draftId,status:"completed",output:{text:"   "}});
 const response=await app.inject({method:"POST",url:`/runs/${id}/content`});assert.equal(response.statusCode,409,response.body);assert.equal(response.json().error,"run_has_no_draft_output");assert.equal((await db.select().from(tables.contentItems).where(eq(tables.contentItems.runId,id))).length,0);
 const details=await app.inject({method:"GET",url:`/runs/${id}`});assert.equal(details.json().processingSummary.hasDraft,false);
});
