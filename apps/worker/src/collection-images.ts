import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, withExecutionLock, contentItems, contentVariants, publications, youtubeItems, ImageLimitError, ExecutionOwnershipError } from "@socialyar/db";
import { generateContentImages } from "@socialyar/workflow/image-generation";
import { imageConfigSchema } from "@socialyar/shared";
import { prepareCollectionVideo } from "./collection-prepare";
export async function prepareCollectionImage(id:string,db=getDb()){
 const [publication]=await db.select({id:publications.id}).from(publications).where(eq(publications.contentVariantId,id)).limit(1);
 return withExecutionLock(publication?`publication:${publication.id}`:`collection-image:${id}`,async assertOwned=>{
  const [row]=await db.select({variant:contentVariants,item:contentItems}).from(contentVariants).innerJoin(contentItems,eq(contentVariants.contentItemId,contentItems.id)).where(eq(contentVariants.id,id));
  if(!row||row.variant.status!=="waiting_approval"||row.variant.settings.imagePrepared!==false||row.variant.settings.calendarPaused)return;
  const {variant,item}=row;const snapshot=variant.settings.imageStep as {key:string;config:Record<string,unknown>}|undefined;
  if(!snapshot)return;const retryAt=variant.settings.imageRetryAt;if(typeof retryAt==="string"&&Date.parse(retryAt)>Date.now())return;
  const config=imageConfigSchema.parse(snapshot.config);
  try{
   const result=await generateContentImages({workspaceId:item.workspaceId,workflowId:String(variant.settings.workflowId),stepKey:snapshot.key,itemKey:`collection:${variant.settings.collectionId}:${variant.settings.collectionRowId}`,config:snapshot.config,item:{title:variant.title,text:variant.body,imageUrl:typeof variant.settings.imageUrl==="string"?variant.settings.imageUrl:null}},db);
   await assertOwned();await db.update(contentVariants).set({settings:{...variant.settings,imageUrl:result.imageUrl,images:result.images,imageGeneration:result.imageGeneration,imagePrepared:true,imageRetryAt:null},calendarVersion:variant.calendarVersion+1,updatedAt:new Date()}).where(and(eq(contentVariants.id,id),eq(contentVariants.calendarVersion,variant.calendarVersion),eq(contentVariants.status,"waiting_approval")));
  }catch(error){if(error instanceof ExecutionOwnershipError)throw error;
   const limit=error instanceof ImageLimitError;const allow=limit?config.onLimit==="continue":config.onError!=="stop";
   await assertOwned();await db.update(contentVariants).set({settings:{...variant.settings,imagePrepared:allow,imageGeneration:{status:limit&&config.onLimit==="wait"?"waiting_quota":"failed",error:error instanceof Error?error.message:"تولید تصویر ناموفق بود."},imageRetryAt:limit&&config.onLimit==="wait"?error.retryAt:null,imageStopped:!allow&&!(limit&&config.onLimit==="wait")},calendarVersion:variant.calendarVersion+1,updatedAt:new Date()}).where(and(eq(contentVariants.id,id),eq(contentVariants.calendarVersion,variant.calendarVersion),eq(contentVariants.status,"waiting_approval")));
  }
 });
}
let running=false;
export async function pollCollectionImages(db=getDb()){
 if(running)return;running=true;
 try{
  const variants=await db.select({id:contentVariants.id}).from(contentVariants).where(and(eq(contentVariants.status,"waiting_approval"),sql`${contentVariants.settings}->>'imagePrepared' = 'false'`,sql`coalesce(${contentVariants.settings}->>'imageStopped','false') <> 'true'`)).limit(20);
  for(const v of variants)try{await prepareCollectionImage(v.id,db);}catch(error){if(!(error instanceof ExecutionOwnershipError))console.error("آماده‌سازی تصویر مجموعه ناموفق بود",error instanceof Error?error.name:"error");}
  const videos=await db.select({id:youtubeItems.id,version:youtubeItems.queueVersion}).from(youtubeItems).where(and(inArray(youtubeItems.status,["waiting_video","preparing"]),sql`${youtubeItems.settings}->'imageStep' IS NOT NULL`)).limit(20);
  for(const v of videos)try{await prepareCollectionVideo(v.id,v.version,db);}catch(error){console.error("آماده‌سازی کاور مجموعه ناموفق بود",error instanceof Error?error.name:"error");}
 }finally{running=false;}
}
