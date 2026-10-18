import { and, desc, eq } from "drizzle-orm";
import { compareActionSnapshots, type AnalysisActionState, type YoutubeGrowthPlan } from "@socialyar/shared";
import { getDb } from "./client";
import { runs, runSteps, workflows, workflowSteps } from "./schema";

type StoredOutput = {growthPlan?:YoutubeGrowthPlan;analysisActions?:Record<string,AnalysisActionState>;youtubeAnalysis?:{channel:{id:string};generatedAt:string;videos:Array<{id:string;views:number|null}>}};
export async function setYoutubeAnalysisAction(db:ReturnType<typeof getDb>, workspaceId:string, workflowId:string, runId:string, stepKey:string, index:number, completed:boolean, now=new Date()) {
  return db.transaction(async tx=>{
    const [row]=await tx.select({id:runSteps.id,output:runSteps.output}).from(runSteps).innerJoin(runs,eq(runs.id,runSteps.runId))
      .innerJoin(workflows,eq(workflows.id,runs.workflowId)).innerJoin(workflowSteps,eq(workflowSteps.id,runSteps.workflowStepId))
      .where(and(eq(workflows.workspaceId,workspaceId),eq(workflows.id,workflowId),eq(runs.id,runId),eq(workflowSteps.key,stepKey),eq(workflowSteps.type,"youtube_analysis"),eq(runSteps.status,"completed"))).for("update");
    const output=row?.output as StoredOutput|undefined,action=output?.growthPlan?.actions[index],report=output?.youtubeAnalysis;
    if(!row||!action||!report)return null;
    const states={...output.analysisActions};
    if(completed)states[index]??={completedAt:now.toISOString(),baselineAt:report.generatedAt,videoViews:Object.fromEntries(action.videoIds.map(id=>[id,report.videos.find(v=>v.id===id)?.views??null]))};
    else delete states[index];
    await tx.update(runSteps).set({output:{...row.output,analysisActions:states}}).where(eq(runSteps.id,row.id));
    return states;
  });
}
export async function youtubeAnalysisFollowUps(db:ReturnType<typeof getDb>, workspaceId:string, workflowId:string, stepKey:string, report:{channel:{id:string};generatedAt:string;videos:Array<{id:string;views:number|null}>}) {
  const rows=await db.select({output:runSteps.output}).from(runSteps).innerJoin(runs,eq(runs.id,runSteps.runId)).innerJoin(workflows,eq(workflows.id,runs.workflowId))
    .innerJoin(workflowSteps,eq(workflowSteps.id,runSteps.workflowStepId)).where(and(eq(workflows.workspaceId,workspaceId),eq(workflows.id,workflowId),eq(workflowSteps.key,stepKey),eq(workflowSteps.type,"youtube_analysis"),eq(runSteps.status,"completed"))).orderBy(desc(runSteps.startedAt)).limit(30);
  const states=rows.flatMap(row=>{
    const output=row.output as StoredOutput|undefined;
    if(output?.youtubeAnalysis?.channel.id!==report.channel.id)return [];
    return Object.entries(output.analysisActions??{}).flatMap(([index,state])=>{
      const action=output.growthPlan?.actions[Number(index)];return action?[{title:action.title,state}]:[];
    });
  });
  return compareActionSnapshots(states,report.videos,report.generatedAt).slice(0,50);
}
