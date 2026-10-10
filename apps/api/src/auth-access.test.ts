import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {PGlite} from '@electric-sql/pglite';
import {drizzle} from 'drizzle-orm/pglite';
import {and,eq} from 'drizzle-orm';
import * as tables from '@socialyar/db/schema';
import {getDb} from '@socialyar/db';
import {authPlugin} from './auth';
import {authRoutes} from './routes/auth';
import {hashPassword} from './password';
const engine=new PGlite(),db=drizzle(engine,{schema:tables}),app=Fastify();
const userId=randomUUID(),ownerId=randomUUID(),workspaceId=randomUUID(),secondId=randomUUID(),outsiderId=randomUUID();
const password='temporary test password';let loginToken='';
before(async()=>{
 process.env.JWT_SECRET='auth-integration-test-secret-32-characters';
 for(const name of ['0000_initial.sql','0001_auth.sql','0002_eitaa_automation.sql','0012_tenant_access.sql'])await engine.exec(await readFile(new URL(`../../../packages/db/migrations/${name}`,import.meta.url),'utf8'));
 await db.insert(tables.users).values([{id:ownerId,email:'owner@example.com'},{id:userId,phone:'+989121234567',passwordHash:await hashPassword(password),mustChangePassword:true}]);
 await db.insert(tables.workspaces).values([{id:workspaceId,ownerId,name:'one',slug:'auth-one'},{id:secondId,ownerId,name:'two',slug:'auth-two'},{id:outsiderId,ownerId,name:'private',slug:'auth-private'}]);
 await db.insert(tables.workspaceMembers).values([{workspaceId,userId,role:'editor'},{workspaceId:secondId,userId,role:'viewer'}]);
 await db.insert(tables.workspaceSubscriptions).values([{workspaceId},{workspaceId:secondId},{workspaceId:outsiderId}]);
 await authPlugin(app,{db:db as unknown as ReturnType<typeof getDb>});
 app.setErrorHandler((error,_request,reply)=>reply.code(400).send({error:error instanceof Error?error.message:'خطا'}));
 await app.register(authRoutes,{db:db as unknown as ReturnType<typeof getDb>});
 app.get('/workflows',{onRequest:[app.authenticate]},async()=>({ok:true}));
});after(async()=>{await app.close();await engine.close();});
const headers=(token:string)=>({authorization:`Bearer ${token}`});
test('mobile login normalizes Persian digits and forces password change before product access',async()=>{
 const response=await app.inject({method:'POST',url:'/auth/login',payload:{phone:'۰۹۱۲۱۲۳۴۵۶۷',password}});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().user.mustChangePassword,true);loginToken=response.json().accessToken;
 const me=await app.inject({method:'GET',url:'/auth/me',headers:headers(loginToken)});assert.equal(me.statusCode,200,me.body);
 const blocked=await app.inject({method:'GET',url:'/workflows',headers:headers(loginToken)});assert.equal(blocked.statusCode,403,blocked.body);
});
test('password change enforces length and invalidates previous signed sessions',async()=>{
 const weak=await app.inject({method:'POST',url:'/auth/password',headers:headers(loginToken),payload:{currentPassword:password,newPassword:'short'}});assert.equal(weak.statusCode,400,weak.body);
 const changed=await app.inject({method:'POST',url:'/auth/password',headers:headers(loginToken),payload:{currentPassword:password,newPassword:'new strong password'}});assert.equal(changed.statusCode,200,changed.body);assert.equal(changed.json().user.mustChangePassword,false);
 const stale=await app.inject({method:'GET',url:'/auth/me',headers:headers(loginToken)});assert.equal(stale.statusCode,401,stale.body);loginToken=changed.json().accessToken;
 const fresh=await app.inject({method:'GET',url:'/auth/me',headers:headers(loginToken)});assert.equal(fresh.statusCode,200,fresh.body);
});
test('organization switching uses live membership and never permits outsider access',async()=>{
 const allowed=await app.inject({method:'POST',url:'/auth/switch-workspace',headers:headers(loginToken),payload:{workspaceId:secondId}});assert.equal(allowed.statusCode,200,allowed.body);assert.equal(allowed.json().workspace.id,secondId);assert.equal(allowed.json().membership.role,'viewer');
 const denied=await app.inject({method:'POST',url:'/auth/switch-workspace',headers:headers(loginToken),payload:{workspaceId:outsiderId}});assert.equal(denied.statusCode,403,denied.body);
});
test('membership deactivation revokes existing token without waiting for JWT expiry',async()=>{
 await db.update(tables.workspaceMembers).set({isActive:false}).where(and(eq(tables.workspaceMembers.workspaceId,workspaceId),eq(tables.workspaceMembers.userId,userId)));
 try{const response=await app.inject({method:'GET',url:'/auth/me',headers:headers(loginToken)});assert.equal(response.statusCode,401,response.body);}finally{await db.update(tables.workspaceMembers).set({isActive:true}).where(and(eq(tables.workspaceMembers.workspaceId,workspaceId),eq(tables.workspaceMembers.userId,userId)));}
});
test('account deactivation revokes all existing sessions',async()=>{
 await db.update(tables.users).set({isActive:false}).where(eq(tables.users.id,userId));
 const response=await app.inject({method:'GET',url:'/auth/me',headers:headers(loginToken)});assert.equal(response.statusCode,401,response.body);
});
