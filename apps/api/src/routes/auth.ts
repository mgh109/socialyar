import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb,users,workspaceMembers,workspaces } from '@socialyar/db';
import { hashPassword,normalizePhone,verifyPassword } from '../password';
export async function authRoutes(app:FastifyInstance,options:{db?:ReturnType<typeof getDb>}={}) {
 const db=options.db ?? getDb();
 async function session(user:typeof users.$inferSelect,workspaceId?:string) {
  const memberships=await db.select({id:workspaces.id,name:workspaces.name,slug:workspaces.slug,role:workspaceMembers.role,channelIds:workspaceMembers.channelIds,workflowIds:workspaceMembers.workflowIds,ownerId:workspaces.ownerId}).from(workspaceMembers).innerJoin(workspaces,eq(workspaces.id,workspaceMembers.workspaceId)).where(and(eq(workspaceMembers.userId,user.id),eq(workspaceMembers.isActive,true),eq(workspaces.isActive,true)));
  const ws=workspaceId?memberships.find(w=>w.id===workspaceId):memberships[0];
  if(!ws) return null;
  const platform=user.isPlatformAdmin || (process.env.HOOR_PLATFORM_ADMIN_USER_IDS??'').split(',').map(x=>x.trim()).includes(user.id);
  return {accessToken:app.signAccessToken({sub:user.id,email:user.email??user.phone??'mobile',workspaceId:ws.id,sessionVersion:user.sessionVersion}),user:{id:user.id,name:user.name,email:user.email,phone:user.phone,mustChangePassword:user.mustChangePassword,isPlatformAdmin:platform},workspace:{id:ws.id,name:ws.name,slug:ws.slug},membership:{role:ws.ownerId===user.id?'manager':ws.role,channelIds:ws.channelIds,workflowIds:ws.workflowIds},workspaces:memberships.map(({id,name,slug})=>({id,name,slug}))};
 }
 const attempts=new Map<string,{count:number,reset:number}>();
 app.post('/auth/login',async(request,reply)=>{
  const input=z.object({phone:z.string().optional(),email:z.string().email().optional(),password:z.string().min(1).max(256)}).refine(x=>!!x.phone||!!x.email).parse(request.body);
  const key=request.ip; const now=Date.now();let rate=attempts.get(key);if(!rate||rate.reset<now){rate={count:0,reset:now+600000};attempts.set(key,rate);}if(attempts.size>10000) for(const [k,v]of attempts)if(v.reset<now)attempts.delete(k);
  if(++rate.count>30)return reply.code(429).send({error:'تلاش‌های ورود زیاد است؛ چند دقیقه بعد دوباره تلاش کنید.'});
  let phone:string|undefined;try{if(input.phone)phone=normalizePhone(input.phone);}catch{return reply.code(400).send({error:'شماره موبایل معتبر نیست.'});}
  const [user]=await db.select().from(users).where(phone?eq(users.phone,phone):eq(users.email,input.email!.toLowerCase().trim())).limit(1);
  // Email only permits migration of an existing account that has no mobile yet.
  if(!user?.isActive||(!phone&&user.phone)||!user.passwordHash||!await verifyPassword(input.password,user.passwordHash))return reply.code(401).send({error:'شماره موبایل یا رمز اشتباه است.'});
  const result=await session(user);if(!result)return reply.code(409).send({error:'حساب شما عضو هیچ سازمانی نیست.'});return result;
 });
 app.get('/auth/me',{onRequest:[app.authenticate]},async(request,reply)=>{
  const [user]=await db.select().from(users).where(eq(users.id,request.auth.userId));
  const result=user&&await session(user,request.auth.workspaceId);if(!result)return reply.code(401).send({error:'unauthorized'});return result;
 });
 app.post('/auth/password',{onRequest:[app.authenticate]},async(request,reply)=>{
  const input=z.object({currentPassword:z.string().min(1).max(256),newPassword:z.string().min(10).max(256),phone:z.string().optional()}).parse(request.body);
  const [user]=await db.select().from(users).where(eq(users.id,request.auth.userId));
  if(!user?.passwordHash||!await verifyPassword(input.currentPassword,user.passwordHash))return reply.code(400).send({error:'رمز فعلی اشتباه است.'});
  let phone=user.phone;try{if(input.phone)phone=normalizePhone(input.phone);}catch{return reply.code(400).send({error:'شماره موبایل معتبر نیست.'});}
  const passwordHash=await hashPassword(input.newPassword);
  try {const [updated]=await db.update(users).set({phone,passwordHash,mustChangePassword:false,sessionVersion:sql`${users.sessionVersion}+1`,updatedAt:new Date()}).where(and(eq(users.id,user.id),eq(users.sessionVersion,user.sessionVersion))).returning();if(!updated)return reply.code(409).send({error:'حساب تغییر کرده؛ دوباره وارد شوید.'});return await session(updated,request.auth.workspaceId);}catch(error){if((error as {code?:string}).code==='23505')return reply.code(409).send({error:'این شماره قبلاً ثبت شده است.'});throw error;}
 });
 app.post('/auth/switch-workspace',{onRequest:[app.authenticate]},async(request,reply)=>{
  const {workspaceId}=z.object({workspaceId:z.string().uuid()}).parse(request.body);const[user]=await db.select().from(users).where(eq(users.id,request.auth.userId));const result=user&&await session(user,workspaceId);if(!result)return reply.code(403).send({error:'به این سازمان دسترسی ندارید.'});return result;
 });
}
