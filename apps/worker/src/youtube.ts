import { YOUTUBE_COVER_MAX_BYTES } from "@socialyar/shared";
import { and, eq } from "drizzle-orm";
import { setTimeout as pause } from "node:timers/promises";
import { assertWorkspaceOperational, getDb, youtubeItems, youtubeToken, fetchYoutubeMedia, googleJson, encryptSecret, decryptSecret, readYoutubeMedia, uploadYoutubeVideo, publishingTransport, publicationConnectionEvents, inspectVideo, assertShorts, youtubeMediaFile, youtubeFileSource, openCollectionVideoSource, inspectRemoteVideo, fetchCollectionMedia, type RemoteVideoSnapshot, AmbiguousDeliveryError, collectionVideoUrl, isConnectionError, connectionErrorReason } from "@socialyar/db";

import { attachYoutubePlaylist } from "./youtube-playlist";

const youtubeServices = {operational:assertWorkspaceOperational,transport:publishingTransport,token:youtubeToken,openVideo:openCollectionVideoSource,inspectRemote:inspectRemoteVideo,fetchMedia:fetchCollectionMedia,pause:(ms:number)=>pause(ms),playlist:attachYoutubePlaylist};
export async function executeYoutube(id: string, db = getDb(), queueVersion = 0, services = youtubeServices) {
  let [item] = await db.select().from(youtubeItems).where(eq(youtubeItems.id, id));
  if (!item || !item.approvedAt || !["queued", "uploading", "processing"].includes(item.status)) return;
  if (item.queueVersion !== queueVersion) return;
  const [claimed] = await db.update(youtubeItems).set({ status: item.videoId ? "processing" : "uploading", error: null, updatedAt: new Date() })
    .where(and(eq(youtubeItems.id, id), eq(youtubeItems.status, item.status), eq(youtubeItems.queueVersion, queueVersion))).returning();
  if (!claimed) return;
  item = claimed;
  const log = async (result: string, extra: Record<string, unknown> = {}) => {
    const entry = { channel: item.channelName, time: new Date().toISOString(), result, ...extra };
    item.logs = [...item.logs, entry];
    await db.update(youtubeItems).set({ logs: item.logs, updatedAt: new Date() }).where(eq(youtubeItems.id, id));
  };
  let stage="authentication";
  const checkpoint=async(next:string,extra:Record<string,unknown>={})=>{
    stage=next;item.settings={...item.settings,...extra,publicationStage:stage,publicationFailureStage:null};
    await db.update(youtubeItems).set({settings:item.settings,updatedAt:new Date()}).where(eq(youtubeItems.id,id));
  };
  let transport: Awaited<ReturnType<typeof publishingTransport>> | undefined;
  try {
    await services.operational(db,item.workspaceId);
    await checkpoint("authentication");
    transport = await services.transport(item.workspaceId, item.settings.connection, "youtube", async (event) => {
      await db.insert(publicationConnectionEvents).values({ workspaceId: item.workspaceId, youtubeItemId: item.id, ...event });
      await log("connection", event);
    });
    const request: typeof fetch = async (url, init) => {
      if (init?.method && !["GET", "HEAD"].includes(init.method.toUpperCase())) await services.operational(db, item.workspaceId);
      const read=["GET","HEAD"].includes((init?.method??"GET").toUpperCase());
      for(let attempt=0;;attempt++){
        let response:Response;
        try {response=await transport!.fetch(url,attempt && init?.signal?.aborted && init.signal.reason?.name==="TimeoutError" ? {...init,signal:AbortSignal.timeout(15000)} : init);}
        catch(error){
          const transient=isConnectionError(error)||error instanceof TypeError||error instanceof Error && ["اتصال شبکه برقرار نشد یا مهلت پاسخ پایان یافت.","اتصال به پروکسی یا سرویس مقصد ناموفق بود."].includes(error.message);
          if(!read||!transient||attempt>=2)throw error;
          await log("read_retry",{stage,attempt:attempt+1,error:connectionErrorReason(error)});
          await services.pause(1000*(attempt+1));continue;
        }
        if(!read||attempt>=2||![429,500,502,503,504].includes(response.status))return response;
        await response.body?.cancel();await log("read_retry",{stage,attempt:attempt+1,httpStatus:response.status});await services.pause(1000*(attempt+1));
      }
    };
    const { token } = await services.token(item.accountId, item.workspaceId, request);
    const requestedPrivacy = item.settings.privacy ?? "private";
    const headers = { Authorization: `Bearer ${token}` };
    const media = async (kind: "video" | "image") => {
      if(kind === "image" && item.settings.collectionId && !(item.settings.imageStep && Array.isArray(item.settings.images) && item.settings.images.some(image=>image?.mediaId===item.settings.coverMediaId))) {
        return services.fetchMedia(item.workspaceId,String(item.settings.coverUrl ?? item.settings.sourceCoverUrl),"image",item.settings.mediaConnection);
      }
      const mediaId = item.settings[kind === "video" ? "videoMediaId" : "coverMediaId"];
      if (typeof mediaId === "string") return readYoutubeMedia(item.workspaceId, mediaId, kind);
      const url = item.settings[kind === "video" ? "videoUrl" : "coverUrl"];
      if (typeof url !== "string") throw new Error("Video is missing");
      return fetchYoutubeMedia(url, kind === "video" ? 250_000_000 : YOUTUBE_COVER_MAX_BYTES, kind);
    };
    if (!item.videoId) {
      if(item.settings.uploadSessionUnknown===true)throw new Error("نتیجه شروع آپلود قبلی نامعلوم است؛ پیش از ساخت آیتم جدید، رکورد مقصد را در یوتیوب بررسی کنید. ساخت خودکار ویدئوی تکراری متوقف شد.");
      await checkpoint("source_check");
      if(item.settings.collectionId && item.sessionEnc && !item.settings.remoteVideo)throw new Error("نشست قبلی با فایل محلی آغاز شده است؛ پیش از تغییر روش انتقال، وضعیت همان آپلود در یوتیوب باید بررسی شود.");
      const remote=item.settings.collectionId ? await services.openVideo(item.workspaceId,collectionVideoUrl(item.settings),item.settings.mediaConnection,item.settings.remoteVideo as RemoteVideoSnapshot|undefined) : null;
      if(remote) {
        // Save source identity before the resumable session. A retry must never mix file versions.
        item.settings={...item.settings,mediaTransfer:"remote",remoteVideo:remote.snapshot};
        delete item.settings.videoMediaId;
        if(!item.settings.imageStep)delete item.settings.coverMediaId;
        await db.update(youtubeItems).set({settings:item.settings,updatedAt:new Date()}).where(eq(youtubeItems.id,id));
      }
      const stored = !remote && typeof item.settings.videoMediaId === "string" ? await youtubeMediaFile(item.workspaceId,item.settings.videoMediaId,"video") : null;
      const video = remote || stored ? null : await media("video");
      if (item.settings.videoType === "shorts") assertShorts(remote ? await services.inspectRemote(remote) : await inspectVideo(stored ? stored.path : video!.bytes));
      await checkpoint("upload");
      await log("upload_started", { requestedPrivacy, submittedPrivacy: requestedPrivacy });
      item.videoId = await uploadYoutubeVideo({ bytes: video?.bytes, source: remote ?? (stored ? youtubeFileSource(stored) : undefined), type: remote?.type ?? stored?.type ?? video!.type, token,
        session: item.sessionEnc ? decryptSecret(item.sessionEnc) : undefined,
        metadata: { snippet: { title: item.title, description: item.description, tags: item.settings.tags ?? [], categoryId: "22" },
          status: { privacyStatus: requestedPrivacy, selfDeclaredMadeForKids: item.settings.madeForKids === true } },
        saveSession: async (session) => { item.sessionEnc=encryptSecret(session); await db.update(youtubeItems).set({ sessionEnc:item.sessionEnc }).where(eq(youtubeItems.id, id)); },
        onRecovery: async (event) => { await log("upload_recovery",event); },
        saveProgress: async (progress, videoId, details) => {
          item.progress=progress;if(videoId)item.videoId=String(videoId);
          if(details)item.settings={...item.settings,uploadProgress:details};
          await db.update(youtubeItems).set({ progress,settings:item.settings,...(videoId ? { videoId } : {}),updatedAt:new Date() }).where(eq(youtubeItems.id,id));
          if(details?.confirmed)await log("upload_confirmed",{...details,videoUrl:`https://www.youtube.com/watch?v=${videoId}`});
        },
      }, request);
      await db.update(youtubeItems).set({ status: "processing", progress: 100, videoId: item.videoId, updatedAt: new Date() }).where(eq(youtubeItems.id, id));
    }
    if ((item.settings.coverMediaId || item.settings.coverUrl) && !item.settings.coverUploaded) {
      await checkpoint("cover_fetch");
      const cover = await media("image");
      await checkpoint("cover_upload");
      await googleJson(await request(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(item.videoId!)}&uploadType=media`, {
        method: "POST", headers: { ...headers, "Content-Type": cover.type }, body: new Uint8Array(cover.bytes), signal: AbortSignal.timeout(30000) }));
      await checkpoint("status_check",{coverUploaded:true});
    }
    await checkpoint("status_check");
    let lastProcessingState="";
    for (let poll = 0; poll < 60; poll++) {
      const data = await googleJson(await request(`https://www.googleapis.com/youtube/v3/videos?part=status,processingDetails&id=${encodeURIComponent(item.videoId!)}`, {
        headers, signal: AbortSignal.timeout(15000) }));
      const result = data.items?.[0]; if (!result) throw new Error("Uploaded video is not visible to the connected channel");
      const status = result.status; const processing = result.processingDetails?.processingStatus;
      const processingState=JSON.stringify([status.uploadStatus,processing,result.processingDetails?.processingFailureReason]);
      if(processingState!==lastProcessingState){
        lastProcessingState=processingState;
        await log("processing_status",{uploadStatus:status.uploadStatus,processingStatus:processing??"unavailable",videoUrl:`https://www.youtube.com/watch?v=${item.videoId}`});
      }
      await db.update(youtubeItems).set({ actualPrivacy: status.privacyStatus, updatedAt: new Date() }).where(eq(youtubeItems.id, id));
      if (["failed", "terminated"].includes(processing) || ["failed", "rejected", "deleted"].includes(status.uploadStatus))
        throw new Error(`YouTube processing failed: ${status.rejectionReason ?? status.failureReason ?? result.processingDetails?.processingFailureReason ?? processing}`);
      if (status.uploadStatus === "processed" && processing !== "processing") {
        await checkpoint("playlist",{videoProcessingConfirmed:true});
        const playlistId=await services.playlist(item,token,request);
        await checkpoint("complete",playlistId ? {playlistId} : {});
        await db.update(youtubeItems).set({ status: "published", actualPrivacy: status.privacyStatus, error: null, updatedAt: new Date() }).where(eq(youtubeItems.id, id));
        await log("published", { videoUrl: `https://www.youtube.com/watch?v=${item.videoId}`, actualPrivacy: status.privacyStatus,
          requestedPrivacy, privacyRestricted: status.privacyStatus !== requestedPrivacy }); return;
      }
      await services.pause(10000);
    }
    throw new Error("YouTube is still processing; retry to check this same video without reuploading");
  } catch (error) {
    const message = error instanceof Error ? error.message : "YouTube publication failed";
    const changed=(error as NodeJS.ErrnoException)?.code==="REMOTE_VIDEO_CHANGED";
    item.settings={...item.settings,publicationStage:stage,publicationFailureStage:stage,...(stage==="upload" && !item.sessionEnc && !item.videoId && error instanceof AmbiguousDeliveryError ? {uploadSessionUnknown:true} : {}),...(changed?{remoteVideoChanged:true}:{})};
    await db.update(youtubeItems).set({ status: "failed", error: message,settings:item.settings,updatedAt: new Date() }).where(eq(youtubeItems.id, id));
    const code=(error as NodeJS.ErrnoException)?.code;
    await log("failed", { error: message,stage,...(typeof code==="string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(code) ? {code} : {}),progress:item.progress, videoUrl: item.videoId ? `https://www.youtube.com/watch?v=${item.videoId}` : null });
    throw error;
  } finally { await transport?.close(); }
}
