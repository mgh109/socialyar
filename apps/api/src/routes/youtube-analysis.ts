import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { getDb, workflows, runs, runSteps, workflowSteps, setYoutubeAnalysisAction } from "@socialyar/db";

export async function youtubeAnalysisRoutes(app:FastifyInstance, db=getDb()) {
  // Registered inside the authenticated workflows plugin, including access policy hooks.
  app.get("/workflows/:workflowId/youtube-analysis", async(request,reply)=>{
    const {workflowId}=z.object({workflowId:z.string().uuid()}).parse(request.params);
    const {stepKey}=z.object({stepKey:z.string().min(1).max(200).optional()}).parse(request.query);
    const [owned]=await db.select({id:workflows.id}).from(workflows).where(and(eq(workflows.id,workflowId),eq(workflows.workspaceId,request.auth.workspaceId))).limit(1);
    if(!owned)return reply.code(404).send({error:"جریان پیدا نشد."});
    return db.select({runId:runs.id,stepKey:workflowSteps.key,status:runSteps.status,output:runSteps.output,error:runSteps.error,at:runSteps.startedAt,inputTokens:runSteps.inputTokens,outputTokens:runSteps.outputTokens,costMicros:runSteps.costMicros,model:runSteps.model})
      .from(runSteps).innerJoin(runs,eq(runSteps.runId,runs.id)).innerJoin(workflowSteps,eq(workflowSteps.id,runSteps.workflowStepId))
      .where(and(eq(runs.workflowId,workflowId),eq(workflowSteps.type,"youtube_analysis"),stepKey?eq(workflowSteps.key,stepKey):undefined)).orderBy(desc(runSteps.startedAt)).limit(30);
  });
  app.patch("/workflows/:workflowId/youtube-analysis/:runId/actions", async(request,reply)=>{
    const {workflowId,runId}=z.object({workflowId:z.string().uuid(),runId:z.string().uuid()}).parse(request.params);
    const {stepKey,index,completed}=z.object({stepKey:z.string().min(1).max(200),index:z.number().int().min(0).max(4),completed:z.boolean()}).parse(request.body);
    const states=await setYoutubeAnalysisAction(db,request.auth.workspaceId,workflowId,runId,stepKey,index,completed);
    return states??reply.code(404).send({error:"اقدام یا گزارش پیدا نشد."});
  });
}
