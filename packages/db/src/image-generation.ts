import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import type { ImageConfig } from "@socialyar/shared";
import { getDb } from "./client";
import { imageGenerationJobs, workspaces } from "./schema";
import { assertWorkspaceOperational } from "./tenant-policy";
export class ImageLimitError extends Error { constructor(message:string,public retryAt:string){super(message);} }
export function imagePeriod(now=new Date(),monthly=false) {
  const local=new Date(now.getTime()+210*60000); const boundary=new Date(Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),monthly?1:local.getUTCDate())-210*60000);
  const next=new Date(Date.UTC(local.getUTCFullYear(),local.getUTCMonth()+(monthly?1:0),monthly?1:local.getUTCDate()+1)-210*60000);
  return {boundary,next};
}
export async function reserveImageJob(input:{workspaceId:string;workflowId:string;stepKey:string;cacheKey:string;provider:string;model:string;config:ImageConfig},db=getDb()) {
  return db.transaction(async tx=>{
    await tx.select({id:workspaces.id}).from(workspaces).where(eq(workspaces.id,input.workspaceId)).for("update");
    const subscription=await assertWorkspaceOperational(tx,input.workspaceId);
    const [existing]=await tx.select().from(imageGenerationJobs).where(and(eq(imageGenerationJobs.workspaceId,input.workspaceId),eq(imageGenerationJobs.cacheKey,input.cacheKey)));
    if(existing){if(existing.status==="completed")return {job:existing,cached:true};throw new Error(existing.error ?? "نتیجه درخواست قبلی تصویر نامعلوم است؛ تولید خودکار تکرار نمی‌شود.");}
    const config=input.config; if(config.count>config.maxPerRun)throw new Error("تعداد خروجی از سقف هر اجرا بیشتر است.");
    const reserved=config.count*config.estimatedCostMicros;
    for(const monthly of [false,true]){
      const {boundary,next}=imagePeriod(new Date(),monthly);
      const [totals]=await tx.select({count:sql<number>`coalesce(sum(${imageGenerationJobs.imageCount}),0)::bigint`,cost:sql<number>`coalesce(sum(coalesce(${imageGenerationJobs.costMicros},${imageGenerationJobs.reservedMicros})),0)::bigint`,
        cardCount:sql<number>`coalesce(sum(case when ${imageGenerationJobs.workflowId}=${input.workflowId} and ${imageGenerationJobs.stepKey}=${input.stepKey} then ${imageGenerationJobs.imageCount} else 0 end),0)::bigint`,
        cardCost:sql<number>`coalesce(sum(case when ${imageGenerationJobs.workflowId}=${input.workflowId} and ${imageGenerationJobs.stepKey}=${input.stepKey} then coalesce(${imageGenerationJobs.costMicros},${imageGenerationJobs.reservedMicros}) else 0 end),0)::bigint`})
        .from(imageGenerationJobs).where(and(eq(imageGenerationJobs.workspaceId,input.workspaceId),gte(imageGenerationJobs.createdAt,boundary),sql`${imageGenerationJobs.status} <> 'rejected'`));
      const max=monthly?config.monthlyLimit:config.dailyLimit; const budget=monthly?config.monthlyBudgetMicros:config.dailyBudgetMicros;
      const tenantMax=monthly?subscription.imageMonthlyLimit:subscription.imageDailyLimit;const tenantBudget=monthly?subscription.imageMonthlyBudgetMicros:null;
      if(max!==null&&Number(totals.cardCount)+config.count>max || budget!==null&&Number(totals.cardCost)+reserved>budget || tenantMax!==null&&Number(totals.count)+config.count>tenantMax || tenantBudget!==null&&Number(totals.cost)+reserved>tenantBudget)
        throw new ImageLimitError(monthly?"سهمیه یا بودجه ماهانه تولید تصویر کافی نیست.":"سهمیه یا بودجه روزانه تولید تصویر کافی نیست.",next.toISOString());
    }
    const {config:_,...fields}=input;
    const [job]=await tx.insert(imageGenerationJobs).values({...fields,imageCount:config.count,reservedMicros:reserved}).returning();return {job,cached:false};
  });
}
function imageSignature(workspaceId:string,mediaId:string){const raw=process.env.HOOR_SECRET_KEY;if(!raw||Buffer.from(raw,"base64").length!==32)throw new Error("کلید رمزگذاری سرور برای رسانه تنظیم نشده است.");return createHmac("sha256",Buffer.from(raw,"base64")).update(`generated-image:${workspaceId}:${mediaId}`).digest("hex");}
export function generatedImageUrl(workspaceId:string,mediaId:string){const base=process.env.HOOR_PUBLIC_API_URL;if(!base)throw new Error("HOOR_PUBLIC_API_URL برای لینک تصویر تنظیم نشده است.");const url=new URL(base);if(url.protocol!=="https:")throw new Error("نشانی عمومی API باید HTTPS باشد.");return `${base.replace(/\/$/,"")}/media/generated/${workspaceId}/${mediaId}/${imageSignature(workspaceId,mediaId)}`;}
export function validImageSignature(workspaceId:string,mediaId:string,signature:string){return /^[a-f0-9]{64}$/.test(signature)&&timingSafeEqual(Buffer.from(signature),Buffer.from(imageSignature(workspaceId,mediaId)));}
