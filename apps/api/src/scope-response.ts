import { filterScopedAccessResponse } from './access';
import type { FastifyInstance } from 'fastify';
import { and,eq,inArray } from 'drizzle-orm';
import { getDb,workflowSteps,workflowVersions,workflows } from '@socialyar/db';
export function scopeResponseHook(app:FastifyInstance,db:ReturnType<typeof getDb>) {
 app.addHook('onSend',async(request,reply,payload)=>{
  const auth=request.auth;
  if(!auth||reply.statusCode!==200||typeof payload!=='string')return payload;
  const path=request.url.split('?')[0];
  if(['/calendar/items','/youtube/items','/workflow-approvals','/approvals'].includes(path)){
    const filtered=await filterScopedAccessResponse(db,request,JSON.parse(payload));
    return JSON.stringify(filtered);
  }
  if(path!=='/social-accounts'&&path!=='/workflows')return payload;
  const ids=path==='/social-accounts'?auth.channelIds:auth.workflowIds;
  if(ids==null&&(path!=='/workflows'||auth.channelIds==null))return payload;
  let rows:Record<string,unknown>[];try{rows=JSON.parse(payload);}catch{return payload;}
  if(!Array.isArray(rows))return payload;
  rows=rows.filter(row=>ids==null||ids.includes(String(row.id)));
  if(path==='/workflows'&&auth.channelIds!=null&&rows.length){
   const steps=await db.select({workflowId:workflows.id,config:workflowSteps.config}).from(workflows)
    .innerJoin(workflowVersions,and(eq(workflowVersions.workflowId,workflows.id),eq(workflowVersions.version,workflows.currentVersion)))
    .innerJoin(workflowSteps,eq(workflowSteps.workflowVersionId,workflowVersions.id))
    .where(and(eq(workflows.workspaceId,auth.workspaceId),inArray(workflows.id,rows.map(r=>String(r.id)))));
   const denied=new Set(steps.filter(s=>typeof s.config.accountId==='string'&&!auth.channelIds!.includes(s.config.accountId)).map(s=>s.workflowId));
   rows=rows.filter(r=>!denied.has(String(r.id)));
  }
  return JSON.stringify(rows);
 });
}
