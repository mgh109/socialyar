import {test,before,after} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';import Fastify from 'fastify';import {PGlite} from '@electric-sql/pglite';import {drizzle} from 'drizzle-orm/pglite';import {eq} from 'drizzle-orm';import * as tables from '@socialyar/db/schema';import {getDb,TenantPolicyError} from '@socialyar/db';import {teamRoutes} from './routes/team';import {platformRoutes} from './routes/platform';
const engine=new PGlite(),db=drizzle(engine,{schema:tables}),app=Fastify();const ownerId=randomUUID(),managerId=randomUUID(),workspaceId=randomUUID(),otherId=randomUUID(),channelId=randomUUID(),extraChannelId=randomUUID(),foreignChannelId=randomUUID(),workflowId=randomUUID();
before(async()=>{
 for(const name of ['0000_initial.sql','0001_auth.sql','0002_eitaa_automation.sql','0005_ai_usage.sql','0011_execution_recovery.sql','0012_tenant_access.sql'])await engine.exec(await readFile(new URL(`../../../packages/db/migrations/${name}`,import.meta.url),'utf8'));
 await db.insert(tables.users).values([{id:ownerId,email:'team-owner@example.com',phone:'+989120000001'},{id:managerId,email:'team-manager@example.com'}]);await db.insert(tables.workspaces).values([{id:workspaceId,ownerId,name:'team',slug:'team-test'},{id:otherId,ownerId,name:'other',slug:'team-other'}]);await db.insert(tables.workspaceMembers).values([{workspaceId,userId:ownerId,role:'manager'},{workspaceId,userId:managerId,role:'manager',channelIds:[channelId],workflowIds:[workflowId]}]);await db.insert(tables.workspaceSubscriptions).values({workspaceId,maxUsers:10});
 await db.insert(tables.socialAccounts).values([{id:channelId,workspaceId,channel:'telegram',externalAccountId:'one'},{id:extraChannelId,workspaceId,channel:'telegram',externalAccountId:'two'},{id:foreignChannelId,workspaceId:otherId,channel:'telegram',externalAccountId:'foreign'}]);await db.insert(tables.workflows).values({id:workflowId,workspaceId,name:'allowed'});
 app.decorate('authenticate',async(request:any)=>{const restricted=request.headers['x-scoped'];request.auth={userId:restricted?managerId:ownerId,email:'team@example.com',workspaceId,role:request.headers['x-viewer']?'viewer':'manager',channelIds:restricted?[channelId]:null,workflowIds:restricted?[workflowId]:null,isPlatformAdmin:!!request.headers['x-platform']};});app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof TenantPolicyError?error.statusCode:400).send({error:error instanceof Error?error.message:'خطا'}));
 await app.register(teamRoutes,{db:db as unknown as ReturnType<typeof getDb>});await app.register(platformRoutes,{db:db as unknown as ReturnType<typeof getDb>});
});after(async()=>{await app.close();await engine.close();});
let phone=1000000;const payload=(extra={})=>({name:'همکار',phone:`0912${++phone}`,password:'temporary password',role:'editor',channelIds:[channelId],workflowIds:[workflowId],...extra});
test('restricted managers cannot grant unrestricted, unassigned or manager authority',async()=>{
 for(const extra of [{channelIds:null},{channelIds:[extraChannelId]},{role:'manager'}]){const response=await app.inject({method:'POST',url:'/team',headers:{'x-scoped':'1'},payload:payload(extra)});assert.equal(response.statusCode,403,response.body);}
 const scopedRead=await app.inject({method:'GET',url:'/team',headers:{'x-scoped':'1'}});assert.equal(scopedRead.statusCode,403,scopedRead.body);
 const allowed=await app.inject({method:'POST',url:'/team',payload:payload()});assert.equal(allowed.statusCode,201,allowed.body);assert.deepEqual(allowed.json().member.channelIds,[channelId]);
});
test('workspace scope and platform boundaries reject unauthorized grants',async()=>{
 const foreign=await app.inject({method:'POST',url:'/team',payload:payload({channelIds:[foreignChannelId]})});assert.equal(foreign.statusCode,400,foreign.body);
 const viewer=await app.inject({method:'GET',url:'/team',headers:{'x-viewer':'1'}});assert.equal(viewer.statusCode,403,viewer.body);
 const platform=await app.inject({method:'GET',url:'/platform/workspaces'});assert.equal(platform.statusCode,403,platform.body);
 const missing=await app.inject({method:'PATCH',url:`/team/${randomUUID()}`,payload:{active:false}});assert.equal(missing.statusCode,404,missing.body);
});
test('organization managers cannot take over an existing identity or modify owner/self',async()=>{
 const duplicate=await app.inject({method:'POST',url:'/team',payload:payload({phone:'09120000001'})});assert.equal(duplicate.statusCode,409,duplicate.body);
 const self=await app.inject({method:'PATCH',url:`/team/${ownerId}`,payload:{active:false}});assert.equal(self.statusCode,409,self.body);
 const platformId=randomUUID();await db.insert(tables.users).values({id:platformId,phone:'+989130000001',isPlatformAdmin:true});await db.insert(tables.workspaceMembers).values({workspaceId,userId:platformId,role:'viewer'});
 const protectedUser=await app.inject({method:'PATCH',url:`/team/${platformId}`,payload:{password:'new strong password'}});assert.equal(protectedUser.statusCode,403,protectedUser.body);
});
test('concurrent member creation cannot exceed one remaining subscription seat',async()=>{
 const members=await db.select().from(tables.workspaceMembers).where(eq(tables.workspaceMembers.workspaceId,workspaceId));await db.update(tables.workspaceSubscriptions).set({maxUsers:members.length+1}).where(eq(tables.workspaceSubscriptions.workspaceId,workspaceId));
 const beforeUsers=(await db.select().from(tables.users)).length;const responses=await Promise.all([app.inject({method:'POST',url:'/team',payload:payload()}),app.inject({method:'POST',url:'/team',payload:payload()})]);assert.deepEqual(responses.map(r=>r.statusCode).sort(),[201,409]);assert.equal((await db.select().from(tables.users)).length,beforeUsers+1);
});

test('platform organization creation atomically creates forced-password manager and trial subscription',async()=>{
 const phone='+989140000001';const created=await app.inject({method:'POST',url:'/platform/workspaces',headers:{'x-platform':'1'},payload:{name:'new organization',slug:'new-organization',managerPhone:phone,managerName:'مدیر',managerPassword:'temporary strong password'}});assert.equal(created.statusCode,201,created.body);
 const id=created.json().workspace.id;const [user]=await db.select().from(tables.users).where(eq(tables.users.phone,phone));assert.equal(user.mustChangePassword,true);assert.equal(user.isPlatformAdmin,false);
 const membership=(await db.select().from(tables.workspaceMembers).where(eq(tables.workspaceMembers.workspaceId,id)))[0];assert.equal(membership.userId,user.id);assert.equal(membership.role,'manager');assert.equal(membership.channelIds,null);
 const subscription=(await db.select().from(tables.workspaceSubscriptions).where(eq(tables.workspaceSubscriptions.workspaceId,id)))[0];assert.equal(subscription.status,'active');assert.equal(subscription.maxUsers,3);assert.equal(subscription.aiTokenLimit,100000);assert.ok(subscription.expiresAt!.getTime()>Date.now());
 const count=(await db.select().from(tables.users)).length;const duplicate=await app.inject({method:'POST',url:'/platform/workspaces',headers:{'x-platform':'1'},payload:{name:'duplicate slug',slug:'new-organization',managerPhone:'+989140000002',managerName:'مدیر',managerPassword:'temporary strong password'}});assert.equal(duplicate.statusCode,409,duplicate.body);assert.equal((await db.select().from(tables.users)).length,count);
});
test('platform activity is isolated and excludes tokens and content payloads',async()=>{
 const foreignWorkflow=randomUUID(),version=randomUUID(),run=randomUUID();await db.insert(tables.workflows).values({id:foreignWorkflow,workspaceId:otherId,name:'foreign'});await db.insert(tables.workflowVersions).values({id:version,workflowId:foreignWorkflow,version:1});await db.insert(tables.runs).values({id:run,workflowId:foreignWorkflow,workflowVersionId:version,input:{secret:'PRIVATE_INPUT'},output:{secret:'PRIVATE_OUTPUT'}});await db.insert(tables.runEvents).values({runId:run,type:'step_completed',message:'PRIVATE_MESSAGE',payload:{token:'PRIVATE_TOKEN'}});
 const activity=await app.inject({method:'GET',url:`/platform/workspaces/${workspaceId}/activity`,headers:{'x-platform':'1'}});assert.equal(activity.statusCode,200,activity.body);assert.ok(!activity.json().runs.some((r:any)=>r.id===run));assert.ok(!activity.body.includes('PRIVATE_'));
 const foreign=await app.inject({method:'GET',url:`/platform/workspaces/${otherId}/activity`,headers:{'x-platform':'1'}});assert.equal(foreign.statusCode,200,foreign.body);assert.equal(foreign.json().runs.length,1);assert.ok(!foreign.body.includes('PRIVATE_'));assert.ok(!foreign.body.includes('passwordHash'));
});
