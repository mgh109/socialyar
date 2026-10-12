import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, desc, gte } from "drizzle-orm";
import { imageGenerationJobs, getDb, validImageSignature, readYoutubeMedia } from "@socialyar/db";
export async function generatedMediaRoutes(app:FastifyInstance){
 app.get("/media/generated/:workspaceId/:mediaId/:signature",async(request,reply)=>{
  const value=z.object({workspaceId:z.string().uuid(),mediaId:z.string().regex(/^[a-f0-9]{64}$/),signature:z.string().regex(/^[a-f0-9]{64}$/)}).safeParse(request.params);
  if(!value.success)return reply.code(404).send();const {workspaceId,mediaId,signature}=value.data;
  if(!validImageSignature(workspaceId,mediaId,signature))return reply.code(404).send();
  try{const media=await readYoutubeMedia(workspaceId,mediaId,"image");return reply.header("Cache-Control","private, max-age=86400").header("X-Content-Type-Options","nosniff").type(media.type).send(media.bytes);}catch{return reply.code(404).send();}
 });
}
export async function imageUsageRoutes(app:FastifyInstance){
 app.addHook("onRequest",app.authenticate);
 app.get("/analytics/image-usage",async(request)=>{
  const q=z.object({workflowId:z.string().uuid().optional(),stepKey:z.string().optional(),period:z.enum(["7d","30d","90d","all"]).default("30d")}).parse(request.query);const db=getDb();
  const rows=await db.select().from(imageGenerationJobs).where(and(eq(imageGenerationJobs.workspaceId,request.auth.workspaceId),q.workflowId?eq(imageGenerationJobs.workflowId,q.workflowId):undefined,q.stepKey?eq(imageGenerationJobs.stepKey,q.stepKey):undefined,q.period!=="all"?gte(imageGenerationJobs.createdAt,new Date(Date.now()-Number.parseInt(q.period)*86400000)):undefined)).orderBy(desc(imageGenerationJobs.createdAt)).limit(1000);
  const totals={requests:rows.length,images:rows.reduce((n,r)=>n+(r.status==="completed"?r.imageCount:0),0),failed:rows.filter(r=>["failed","rejected"].includes(r.status)).length,costMicros:rows.reduce((n,r)=>n+(r.status==="rejected"?0:r.costMicros??r.reservedMicros),0),estimated:rows.some(r=>r.status!=="rejected"&&r.costEstimated),inputTokens:rows.reduce((n,r)=>n+(r.inputTokens??0),0),outputTokens:rows.reduce((n,r)=>n+(r.outputTokens??0),0)};
  return {totals,jobs:rows.slice(0,50).map(({cacheKey:_,...r})=>r),capped:rows.length===1000};
 });
}
