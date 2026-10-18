import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import Fastify from "fastify";
import {PGlite} from "@electric-sql/pglite";
import {drizzle} from "drizzle-orm/pglite";
import * as schema from "@socialyar/db/schema";
import {getDb,youtubeAnalysisFollowUps} from "@socialyar/db";
import {youtubeAnalysisRoutes} from "./routes/youtube-analysis";
const engine=new PGlite(),db=drizzle(engine,{schema}),database=db as unknown as ReturnType<typeof getDb>,app=Fastify();
const workspaceId=randomUUID(),other=randomUUID(),workflowId=randomUUID(),versionId=randomUUID(),stepId=randomUUID(),runId=randomUUID();
let currentWorkspace=workspaceId;
before(async()=>{
 for(const file of ["0000_initial.sql","0001_auth.sql","0002_eitaa_automation.sql","0011_execution_recovery.sql","0012_tenant_access.sql"])await engine.exec(await readFile(new URL(`../../../packages/db/migrations/${file}`,import.meta.url),"utf8"));
 const userId=randomUUID();await db.insert(schema.users).values({id:userId,email:"analysis@example.com"});await db.insert(schema.workspaces).values([{id:workspaceId,name:"test",slug:"analysis",ownerId:userId},{id:other,name:"foreign",slug:"analysis-foreign",ownerId:userId}]);
 await db.insert(schema.workflows).values({id:workflowId,workspaceId,name:"تحلیل"});await db.insert(schema.workflowVersions).values({id:versionId,workflowId,version:1});await db.insert(schema.workflowSteps).values({id:stepId,workflowVersionId:versionId,key:"analysis",type:"youtube_analysis",name:"تحلیل",order:0});await db.insert(schema.runs).values({id:runId,workflowId,workflowVersionId:versionId,status:"completed"});
 await db.insert(schema.runSteps).values({runId,workflowStepId:stepId,status:"completed",output:{growthPlan:{summary:"خلاصه",actions:[{title:"اصلاح عنوان",evidence:"شاهد",metric:"بازدید",videoIds:["video"]}],ideas:[]},youtubeAnalysis:{channel:{id:"channel"},generatedAt:"2026-10-01T00:00:00Z",videos:[{id:"video",views:10}]}}});
 app.addHook("onRequest",async request=>{request.auth={workspaceId:currentWorkspace,userId} as any;});await youtubeAnalysisRoutes(app,database);await app.ready();
});
after(async()=>{await app.close();await engine.close();});
const url=`/workflows/${workflowId}/youtube-analysis`,body={stepKey:"analysis",index:0,completed:true};
test("reports and action mutations are workspace scoped, persistent and idempotent",async()=>{
 currentWorkspace=other;assert.equal((await app.inject({method:"GET",url})).statusCode,404);assert.equal((await app.inject({method:"PATCH",url:`${url}/${runId}/actions`,payload:body})).statusCode,404);currentWorkspace=workspaceId;
 const first=await app.inject({method:"PATCH",url:`${url}/${runId}/actions`,payload:body});assert.equal(first.statusCode,200);const repeat=await app.inject({method:"PATCH",url:`${url}/${runId}/actions`,payload:body});assert.deepEqual(first.json(),repeat.json());
 const report=(await app.inject({method:"GET",url:`${url}?stepKey=analysis`})).json()[0];assert.equal(report.output.growthPlan.actions[0].title,"اصلاح عنوان");assert.equal(report.output.analysisActions[0].videoViews.video,10);assert.deepEqual((await app.inject({method:"GET",url:`${url}?stepKey=other`})).json(),[]);
});
test("followup is channel/workspace scoped and retains capture baseline; undo removes it",async()=>{
 const report={channel:{id:"channel"},generatedAt:"2099-01-01T00:00:00Z",videos:[{id:"video",views:35}]};const rows=await youtubeAnalysisFollowUps(database,workspaceId,workflowId,"analysis",report);assert.equal(rows.length,1);assert.equal(rows[0].delta,25);assert.equal(rows[0].baselineAt,"2026-10-01T00:00:00Z");
 assert.deepEqual(await youtubeAnalysisFollowUps(database,other,workflowId,"analysis",report),[]);assert.deepEqual(await youtubeAnalysisFollowUps(database,workspaceId,workflowId,"analysis",{...report,channel:{id:"other"}}),[]);
 assert.equal((await app.inject({method:"PATCH",url:`${url}/${runId}/actions`,payload:{...body,index:4}})).statusCode,404);
 assert.deepEqual((await app.inject({method:"PATCH",url:`${url}/${runId}/actions`,payload:{...body,completed:false}})).json(),{});assert.deepEqual(await youtubeAnalysisFollowUps(database,workspaceId,workflowId,"analysis",report),[]);
});
