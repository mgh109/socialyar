import { generateContentImages } from "@socialyar/workflow/image-generation";
import { imageConfigSchema } from "@socialyar/shared";
import { ImageLimitError } from "@socialyar/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { assertWorkspaceOperational, getDb, getPool, youtubeItems, fetchCollectionMedia, storeYoutubeMedia, inspectVideo, assertShorts, fetchCollectionVideo, youtubeMediaFile } from "@socialyar/db";
const preparationServices = {
  lock: () => getPool().connect(), fetchMedia: fetchCollectionMedia, storeMedia: storeYoutubeMedia,
  inspect: inspectVideo, operational: assertWorkspaceOperational,
  fetchVideo:fetchCollectionVideo, mediaFile:youtubeMediaFile,
};
export async function prepareCollectionVideo(id: string, version: number, db = getDb(), services = preparationServices) {
  const lock = await services.lock();
  try {
  await lock.query("SELECT pg_advisory_lock(hashtext($1))",[`youtube-prepare:${id}`]);
  const [current] = await db.select().from(youtubeItems).where(eq(youtubeItems.id,id));
  if (!current?.settings.collectionId) return;
  if(typeof current.settings.imageRetryAt === "string" && Date.parse(current.settings.imageRetryAt)>Date.now())return;
  const [item] = await db.update(youtubeItems).set({ status: "preparing", error: null, updatedAt: new Date() })
    .where(and(eq(youtubeItems.id, id), eq(youtubeItems.queueVersion, version), isNull(youtubeItems.approvedAt), inArray(youtubeItems.status, ["waiting_video", "failed", "preparing"]))).returning();
  if (!item || !item.settings.collectionId) return;
  const settings = { ...item.settings };
  let stage = "video_download";
  try {
    await services.operational(db,item.workspaceId);
    if (!settings.videoMediaId) {
      const media = await services.fetchVideo(item.workspaceId,String(settings.sourceVideoUrl ?? settings.videoUrl),settings.mediaConnection);
      settings.videoMediaId = media.mediaId;
    }
    stage = "video_inspection";
    const video = await services.mediaFile(item.workspaceId,String(settings.videoMediaId),"video");
    const details = await services.inspect(video.path); settings.videoDetails = details;
    if (settings.videoType === "shorts") assertShorts(details);
    const imageStep = settings.imageStep as {key:string;config:Record<string,unknown>}|undefined;
    if (imageStep) {
      stage = "image_generation";
      const config=imageConfigSchema.parse(imageStep.config);
      try {
        const result=await generateContentImages({workspaceId:item.workspaceId,workflowId:item.workflowId!,stepKey:imageStep.key,itemKey:`collection:${settings.collectionId}:${settings.collectionRowId}`,config:imageStep.config,item:{title:item.title,text:item.description,imageUrl:typeof settings.coverUrl === "string" ? settings.coverUrl : null}},db);
        settings.coverUrl=result.imageUrl; settings.images=result.images; settings.imageGeneration=result.imageGeneration; settings.imageRetryAt=null;
        const images=result.images as Array<{mediaId:string}>|undefined;
        if(images?.[0])settings.coverMediaId=images[0].mediaId;
      }catch(error){
        if(error instanceof ImageLimitError && config.onLimit === "wait"){
          await db.update(youtubeItems).set({status:"waiting_video",settings:{...settings,imageRetryAt:error.retryAt},error:error.message,updatedAt:new Date()}).where(and(eq(youtubeItems.id,id),eq(youtubeItems.queueVersion,version),eq(youtubeItems.status,"preparing")));return;
        }
        if(error instanceof ImageLimitError ? config.onLimit !== "continue" : config.onError === "stop")throw error;
        settings.imageGeneration={status:"failed",error:error instanceof Error?error.message:"تولید تصویر ناموفق بود."};
      }
    }
    stage = "cover_download";
    if (settings.coverUrl && !settings.coverMediaId) {
      const media = await services.fetchMedia(item.workspaceId, String(settings.coverUrl), "image", settings.mediaConnection);
      settings.coverMediaId = (await services.storeMedia(item.workspaceId, media.bytes)).mediaId;
    }
    settings.preparationFailureStage = null;
    await db.update(youtubeItems).set({ settings, status: "waiting_approval", error: null, updatedAt: new Date(),
      logs: [...item.logs, { result: "prepared", time: new Date().toISOString(), channel: item.channelName }] })
      .where(and(eq(youtubeItems.id, id), eq(youtubeItems.queueVersion, version), eq(youtubeItems.status, "preparing")));
  } catch (error) {
    await db.update(youtubeItems).set({ settings: {...settings,preparationFailureStage:stage}, status: "failed", error: error instanceof Error ? error.message : "آماده‌سازی ناموفق بود.", logs:[...item.logs,{result:"preparation_failed",stage,time:new Date().toISOString(),channel:item.channelName}], updatedAt: new Date() })
      .where(and(eq(youtubeItems.id, id), eq(youtubeItems.queueVersion, version), eq(youtubeItems.status, "preparing"))); throw error;
  }
  } finally { await lock.query("SELECT pg_advisory_unlock(hashtext($1))",[`youtube-prepare:${id}`]).catch(()=>{}); lock.release(); }
}
