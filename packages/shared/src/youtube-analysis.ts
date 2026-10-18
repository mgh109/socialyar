import { z } from "zod";
export const youtubeAnalysisConfig = z.object({
  accountId: z.string().uuid(), profileId: z.union([z.literal("default"), z.string().uuid()]).default("default"),
  days: z.number().int().min(7).max(90).default(28), videoLimit: z.number().int().min(1).max(50).default(20),
  commentLimit: z.number().int().min(0).max(200).default(50), instructions: z.string().max(4000).default(""),
});

const boundedText = z.string().trim().min(1).max(1200);
export const youtubeGrowthPlanSchema = z.object({
  summary: boundedText,
  actions: z.array(z.object({title:z.string().trim().min(1).max(180),evidence:boundedText,metric:boundedText,videoIds:z.array(z.string().max(64)).max(5).default([])})).min(3).max(5),
  ideas:z.array(z.object({title:z.string().trim().min(1).max(180),outline:boundedText,cover:boundedText,commentIds:z.array(z.string().max(100)).max(5).default([])})).max(3),
});
export type YoutubeGrowthPlan = z.infer<typeof youtubeGrowthPlanSchema>;
export type AnalysisActionState = {completedAt:string;baselineAt:string;videoViews:Record<string,number|null>};
export type AnalysisFollowUp = {title:string;completedAt:string;baselineAt:string;videoId:string;baselineViews:number|null;currentViews:number|null;delta:number|null};

export function videoComparison(duration: string | undefined, publishedAt: string | undefined, views:number|null, now=new Date()) {
  const match = duration?.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  const seconds = match && match.slice(1).some(Boolean) ? Number(match[1]||0)*3600+Number(match[2]||0)*60+Number(match[3]||0) : null;
  const elapsed = publishedAt ? (now.getTime()-Date.parse(publishedAt))/86400000 : NaN;
  const ageDays=Number.isFinite(elapsed)&&elapsed>=0?Math.max(1,elapsed):null;
  return {durationSeconds:seconds,format:seconds===null?"unknown":seconds<=180?"short_candidate":"long",
    ageDays:ageDays===null?null:Math.floor(ageDays),ageGroup:ageDays===null?"unknown":ageDays<8?"week":ageDays<31?"month":ageDays<91?"quarter":"older",
    viewsPerDay:views===null||ageDays===null?null:Math.round(views/ageDays*10)/10};
}
export function compareActionSnapshots(states:Array<{title:string;state:AnalysisActionState}>, videos:Array<{id:string;views:number|null}>, generatedAt:string):AnalysisFollowUp[] {
  return states.flatMap(({title,state})=>Date.parse(generatedAt)<=Date.parse(state.completedAt)?[]:Object.entries(state.videoViews).map(([videoId,baselineViews])=>{
    const currentViews=videos.find(v=>v.id===videoId)?.views??null;
    return {title,completedAt:state.completedAt,baselineAt:state.baselineAt,videoId,baselineViews,currentViews,delta:currentViews===null||baselineViews===null?null:currentViews-baselineViews};
  }));
}
