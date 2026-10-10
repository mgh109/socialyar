import {test,before,after} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';import Fastify from 'fastify';import {PGlite} from '@electric-sql/pglite';import {drizzle} from 'drizzle-orm/pglite';import {eq} from 'drizzle-orm';import * as tables from '@socialyar/db/schema';import {getDb,TenantPolicyError} from '@socialyar/db';import {enforceAccess} from './access';
const engine=new PGlite(),db=drizzle(engine,{schema:tables}),app=Fastify();const userId=randomUUID(),workspaceId=randomUUID(),otherId=randomUUID(),channelId=randomUUID(),foreignId=randomUUID(),workflowId=randomUUID(),versionId=randomUUID();
before(async()=>{
 for(const name of ['0000_initial.sql','0001_auth.sql','0002_eitaa_automation.sql','0012_tenant_access.sql'])await engine.exec(await readFile(new URL(`../../../packages/db/migrations/${name}`,import.meta.url),'utf8'));
 await db.insert(tables.users).values({id:userId,email:'access-policy@example.com'});await db.insert(tables.workspaces).values([{id:workspaceId,ownerId:userId,name:'one',slug:'scope-one'},{id:otherId,ownerId:userId,name:'two',slug:'scope-two'}]);await db.insert(tables.workspaceSubscriptions).values([{workspaceId},{workspaceId:otherId}]);await db.insert(tables.socialAccounts).values([{id:channelId,workspaceId,channel:'telegram',externalAccountId:'one'},{id:foreignId,workspaceId:otherId,channel:'telegram',externalAccountId:'two'}]);await db.insert(tables.workflows).values({id:workflowId,workspaceId,name:'flow'});await db.insert(tables.workflowVersions).values({id:versionId,workflowId,version:1});await db.insert(tables.workflowSteps).values({workflowVersionId:versionId,type:'publish',key:'send',name:'send',config:{accountId:channelId}});
 app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof TenantPolicyError?error.statusCode:400).send({error:error instanceof Error?error.message:'خطا'}));app.addHook('onRequest',async request=>{request.auth={userId,email:'test@example.com',workspaceId,role:String(request.headers['x-role']??'manager'),channelIds:request.headers['x-empty']?[]:request.headers['x-scoped']?[channelId]:null,workflowIds:request.headers['x-empty']?[]:request.headers['x-scoped']?[workflowId]:null};});app.addHook('preHandler',async(request,reply)=>enforceAccess(db as unknown as ReturnType<typeof getDb>,request,reply));
 for(const method of ['GET','PUT','POST'] as const)app.route({method,url:'/workflows/:workflowId',handler:async()=>({ok:true})});app.post('/workflows/:workflowId/runs',async()=>({ok:true}));
});after(async()=>{await app.close();await engine.close();});
test('empty workflow scope denies while assigned workflow and its channel are readable',async()=>{
 const allowed=await app.inject({method:'GET',url:`/workflows/${workflowId}`,headers:{'x-scoped':'1'}});assert.equal(allowed.statusCode,200,allowed.body);
 const denied=await app.inject({method:'GET',url:`/workflows/${workflowId}`,headers:{'x-empty':'1'}});assert.equal(denied.statusCode,403,denied.body);
});
test('manager cannot inject a channel owned by another workspace in nested config',async()=>{
 const response=await app.inject({method:'PUT',url:`/workflows/${workflowId}`,payload:{steps:[{config:{accountId:foreignId}}]}});assert.equal(response.statusCode,403,response.body);
});
test('viewer cannot mutate and editor cannot trigger publication runs',async()=>{
 const viewer=await app.inject({method:'PUT',url:`/workflows/${workflowId}`,headers:{'x-role':'viewer'},payload:{name:'updated'}});assert.equal(viewer.statusCode,403,viewer.body);
 const editor=await app.inject({method:'POST',url:`/workflows/${workflowId}/runs`,headers:{'x-role':'editor'},payload:{}});assert.equal(editor.statusCode,403,editor.body);
});

test('expired organization subscription blocks edits before mutation',async()=>{
 await db.update(tables.workspaceSubscriptions).set({expiresAt:new Date('2020-01-01T00:00:00Z')}).where(eq(tables.workspaceSubscriptions.workspaceId,workspaceId));
 const response=await app.inject({method:'PUT',url:`/workflows/${workflowId}`,payload:{name:'blocked'}});assert.equal(response.statusCode,402,response.body);
});
