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
  if (!current?.settings.collectionId || current.videoId || current.sessionEnc) return;
  if(typeof current.settings.imageRetryAt === "string" && Date.parse(current.settings.imageRetryAt)>Date.now())return;
  const [item] = await db.update(youtubeItems).set({ status: "preparing", error: null, updatedAt: new Date() })
    .where(and(eq(youtubeItems.id, id), eq(youtubeItems.queueVersion, version), isNull(youtubeItems.approvedAt), inArray(youtubeItems.status, ["waiting_video", "failed", "preparing"]))).returning();
  if (!item || !item.settings.collectionId) return;
  const settings:Record<string,unknown> = { ...item.settings, preparationFailureStage:null };
  const logs = [...item.logs];
  let stage = "video_download";
  const checkpoint = async (nextStage:string, result?:string) => {
    stage = nextStage;
    if(result) logs.push({result,time:new Date().toISOString(),channel:item.channelName});
    await db.update(youtubeItems).set({settings:{...settings,preparationStage:stage},logs:[...logs],updatedAt:new Date()})
      .where(and(eq(youtubeItems.id,id),eq(youtubeItems.queueVersion,version),eq(youtubeItems.status,"preparing")));
  };
  try {
    await services.operational(db,item.workspaceId);
    // A saved database ID is not proof that a file survived a restart or volume change.
    let video: Awaited<ReturnType<typeof services.mediaFile>> | undefined;
    if (typeof settings.videoMediaId === "string") {
      try { video = await services.mediaFile(item.workspaceId,settings.videoMediaId,"video"); }
      catch(error) {
        if((error as NodeJS.ErrnoException).code !== "ENOENT")throw error;
        delete settings.videoMediaId;
        delete settings.videoDetails;
        logs.push({result:"video_recovery",time:new Date().toISOString(),channel:item.channelName});
      }
    }
    if (!settings.videoMediaId) {
      settings.videoDownloadedBytes=0;settings.videoTotalBytes=null;
      await checkpoint("video_download");
      const media = await services.fetchVideo(item.workspaceId,String(settings.sourceVideoUrl ?? settings.videoUrl),settings.mediaConnection,async progress=>{
        settings.videoDownloadedBytes=progress.bytes;settings.videoTotalBytes=progress.total ?? null;
        await checkpoint("video_download");
      });
      settings.videoMediaId = media.mediaId;
      settings.videoBytes = media.size;
      settings.videoDownloadedBytes=media.size;settings.videoTotalBytes=media.size;
      await checkpoint("video_inspection","video_downloaded");
    }
    await checkpoint("video_inspection");
    video ??= await services.mediaFile(item.workspaceId,String(settings.videoMediaId),"video");
    const details = await services.inspect(video.path); settings.videoDetails = details;
    if (settings.videoType === "shorts") assertShorts(details);
    await checkpoint("cover_download","video_inspected");
    if(typeof settings.coverMediaId === "string") {
      try {await services.mediaFile(item.workspaceId,settings.coverMediaId,"image");}
      catch(error){if((error as NodeJS.ErrnoException).code !== "ENOENT")throw error;delete settings.coverMediaId;}
    }
    const imageStep = settings.imageStep as {key:string;config:Record<string,unknown>}|undefined;
    if (imageStep) {
      await checkpoint("image_generation");
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
    await checkpoint("cover_download");
    if (settings.coverUrl && !settings.coverMediaId) {
      const media = await services.fetchMedia(item.workspaceId, String(settings.coverUrl), "image", settings.mediaConnection);
      settings.coverMediaId = (await services.storeMedia(item.workspaceId, media.bytes)).mediaId;
    }
    settings.preparationFailureStage = null;
    await db.update(youtubeItems).set({ settings:{...settings,preparationStage:"ready"}, status: "waiting_approval", error: null, updatedAt: new Date(),
      logs: [...logs, { result: "prepared", time: new Date().toISOString(), channel: item.channelName }] })
      .where(and(eq(youtubeItems.id, id), eq(youtubeItems.queueVersion, version), eq(youtubeItems.status, "preparing")));
  } catch (error) {
    const message=(error as NodeJS.ErrnoException)?.code === "ENOENT"
      ? "فایل دریافت‌شده در فضای ذخیره‌سازی پردازشگر پیدا نشد (ENOENT)؛ اتصال فضای پایدار Worker را بررسی کنید. تلاش بعدی فایل را از منبع دوباره دریافت می‌کند."
      : error instanceof Error ? error.message : "آماده‌سازی ناموفق بود.";
    const code=error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(error.code) ? error.code : undefined;
    await db.update(youtubeItems).set({ settings: {...settings,preparationStage:stage,preparationFailureStage:stage}, status: "failed", error: message, logs:[...logs,{result:"preparation_failed",stage,error:message,...(code ? {code} : {}),time:new Date().toISOString(),channel:item.channelName}], updatedAt: new Date() })
      .where(and(eq(youtubeItems.id, id), eq(youtubeItems.queueVersion, version), eq(youtubeItems.status, "preparing"))); throw error;
  }
  } finally { await lock.query("SELECT pg_advisory_unlock(hashtext($1))",[`youtube-prepare:${id}`]).catch(()=>{}); lock.release(); }
}
