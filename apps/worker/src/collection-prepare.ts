import { generateContentImages } from "@socialyar/workflow/image-generation";
import { imageConfigSchema } from "@socialyar/shared";
import { ImageLimitError } from "@socialyar/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { assertWorkspaceOperational, getDb, getPool, youtubeItems, fetchCollectionMedia, inspectRemoteVideo, assertShorts, openCollectionVideoSource } from "@socialyar/db";
const preparationServices = {
  lock: () => getPool().connect(), fetchMedia: fetchCollectionMedia,
  inspect: inspectRemoteVideo, operational: assertWorkspaceOperational, openVideo:openCollectionVideoSource,
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
  let stage = "video_link";
  const checkpoint = async (nextStage:string, result?:string) => {
    stage = nextStage;
    if(result) logs.push({result,time:new Date().toISOString(),channel:item.channelName});
    await db.update(youtubeItems).set({settings:{...settings,preparationStage:stage},logs:[...logs],updatedAt:new Date()})
      .where(and(eq(youtubeItems.id,id),eq(youtubeItems.queueVersion,version),eq(youtubeItems.status,"preparing")));
  };
  try {
    await services.operational(db,item.workspaceId);
    const imageStep = settings.imageStep as {key:string;config:Record<string,unknown>}|undefined;
    // Existing collection items also migrate on retry; cached files are never required.
    delete settings.videoMediaId;
    delete settings.remoteVideo;
    delete settings.videoDetails;
    delete settings.coverLinkChecked;
    delete settings.videoDownloadedBytes;
    delete settings.videoTotalBytes;
    if(!(imageStep && Array.isArray(settings.images) && settings.images.some(image=>image?.mediaId===settings.coverMediaId)))delete settings.coverMediaId;
    settings.mediaTransfer="remote";
    await checkpoint("video_link");
    const video=await services.openVideo(item.workspaceId,String(settings.sourceVideoUrl ?? settings.videoUrl),settings.mediaConnection);
    settings.remoteVideo=video.snapshot;
    settings.remoteVideoChanged=false;
    settings.videoBytes=video.size;
    await checkpoint("video_inspection","video_link_checked");
    const details = await services.inspect(video); settings.videoDetails = details;
    if (settings.videoType === "shorts") assertShorts(details);
    await checkpoint("cover_link","video_inspected");
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
    await checkpoint("cover_link");
    if (settings.coverUrl && !settings.coverMediaId) {
      await services.fetchMedia(item.workspaceId, String(settings.coverUrl), "image", settings.mediaConnection, true);
      settings.coverLinkChecked=true;
    }
    settings.preparationFailureStage = null;
    await db.update(youtubeItems).set({ settings:{...settings,preparationStage:"ready"}, status: "waiting_approval", error: null, updatedAt: new Date(),
      logs: [...logs, { result: "prepared", time: new Date().toISOString(), channel: item.channelName }] })
      .where(and(eq(youtubeItems.id, id), eq(youtubeItems.queueVersion, version), eq(youtubeItems.status, "preparing")));
  } catch (error) {
    const message=(error as NodeJS.ErrnoException)?.code === "ENOENT"
      ? "فایل داخلی تولید تصویر پیدا نشد (ENOENT)؛ فضای ذخیره‌سازی تصویرهای تولیدشده در Worker را بررسی کنید."
      : error instanceof Error ? error.message : "آماده‌سازی ناموفق بود.";
    const code=error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(error.code) ? error.code : undefined;
    await db.update(youtubeItems).set({ settings: {...settings,preparationStage:stage,preparationFailureStage:stage}, status: "failed", error: message, logs:[...logs,{result:"preparation_failed",stage,error:message,...(code ? {code} : {}),time:new Date().toISOString(),channel:item.channelName}], updatedAt: new Date() })
      .where(and(eq(youtubeItems.id, id), eq(youtubeItems.queueVersion, version), eq(youtubeItems.status, "preparing"))); throw error;
  }
  } finally { await lock.query("SELECT pg_advisory_unlock(hashtext($1))",[`youtube-prepare:${id}`]).catch(()=>{}); lock.release(); }
}
