import {createHash} from "node:crypto";
import {readCollectionMediaRange} from "./collection-media";
import {youtubeMediaType,youtubeVideoLimit} from "./youtube";

export type RemoteVideoSnapshot={size:number;type:string;etag?:string;lastModified?:string;headHash:string};
type RangeReader=typeof readCollectionMediaRange;
export function collectionVideoUrl(settings:Record<string,unknown>) {
  const raw=settings.sourceVideoUrl ?? settings.videoUrl;
  let url:URL;try{url=new URL(String(raw));}catch{throw new Error("لینک ویدئوی مجموعه معتبر نیست؛ لینک شیت را اصلاح کنید.");}
  if(url.protocol!=="https:" || url.username || url.password || url.port)throw new Error("ویدئوی مجموعه باید لینک HTTPS عمومی و بدون اطلاعات ورود داشته باشد.");
  return url.href;
}
/** No filesystem operations: each YouTube chunk is read from the origin into bounded memory. */
export async function openCollectionVideoSource(workspaceId:string,url:string,policy?:unknown,expected?:RemoteVideoSnapshot,reader:RangeReader=readCollectionMediaRange) {
  const changed=()=>Object.assign(new Error("فایل منبع از زمان بررسی تغییر کرده است؛ پیش از شروع آپلود، تلاش مجدد آن را برای بررسی و تأیید تازه برمی‌گرداند. اگر نشست آپلودی آغاز شده باشد، نشست قبلی برای جلوگیری از ارسال تکراری حفظ می‌شود."),{code:"REMOTE_VIDEO_CHANGED"});
  const range=async(start:number,end:number,validator?:string)=>{
    const response=await reader(workspaceId,url,start,end,policy,validator);
    const header=response.headers["content-range"];
    const match=typeof header==="string" ? header.match(/^bytes (\d+)-(\d+)\/(\d+)$/i) : null;
    if(!match)throw new Error("هاست اندازه و بازهٔ فایل را به‌درستی اعلام نکرد؛ Content-Range معتبر لازم است.");
    const size=Number(match[3]);
    if(!Number.isSafeInteger(size) || size<=0 || size>youtubeVideoLimit())throw new Error("حجم ویدئو از سقف انتقال مجاز بیشتر است.");
    if(Number(match[1])!==start || Number(match[2])!==Math.min(end,size)-1 || response.bytes.length!==Math.min(end,size)-start)throw new Error("بازهٔ دریافت‌شده از هاست ناقص یا نادرست است.");
    return {...response,size};
  };
  const first=await range(0,4096);
  const type=youtubeMediaType(first.bytes);if(!type.startsWith("video/"))throw new Error("لینک شیت به فایل ویدئو نمی‌رسد؛ لینک دانلود مستقیم MP4 یا WebM وارد کنید.");
  const get=(key:string)=>typeof first.headers[key]==="string" ? first.headers[key] as string : undefined;
  const etag=get("etag"),lastModified=get("last-modified");
  const snapshot:RemoteVideoSnapshot={size:first.size,type,headHash:createHash("sha256").update(first.bytes).digest("hex"),
    ...(etag && !etag.startsWith("W/") ? {etag} : {}),...(lastModified ? {lastModified} : {})};
  if(!snapshot.etag && !snapshot.lastModified)throw new Error("هاست باید ETag یا Last-Modified فایل را اعلام کند تا ادامهٔ امن انتقال بدون ذخیرهٔ فایل ممکن باشد.");
  if(expected && (expected.size!==snapshot.size || expected.type!==snapshot.type || expected.headHash!==snapshot.headHash || expected.etag && expected.etag!==snapshot.etag || expected.lastModified && expected.lastModified!==snapshot.lastModified))throw changed();
  const validator=snapshot.etag ?? snapshot.lastModified;
  return {size:snapshot.size,type,snapshot,read:async(start:number,end:number)=>{
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0 || end>snapshot.size || end<=start || end-start>8*1024*1024)throw new Error("Invalid video chunk");
    const response=await range(start,end,validator);
    if(response.size!==snapshot.size || snapshot.etag && response.headers.etag!==snapshot.etag || !snapshot.etag && snapshot.lastModified && response.headers["last-modified"]!==snapshot.lastModified)throw changed();
    return response.bytes;
  }};
}
