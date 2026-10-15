import { Agent, request as undiciRequest, type Dispatcher } from "undici";
import { lookup } from "node:dns/promises";
import { connectionPolicy, createProxyDispatcher, loadPublishingProxy, isConnectionError } from "./publishing-connection";
import { dropboxDownloadUrl } from "@socialyar/shared";
import { youtubeMediaType, storeYoutubeVideoStream, youtubeVideoLimit } from "./youtube";
export async function publicMediaAddress(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("فایل باید لینک HTTPS عمومی و بدون اطلاعات ورود داشته باشد.");
  const addresses = (await lookup(url.hostname,{ all:true })).filter((a) => a.family===4);
  if (!addresses.length || addresses.some(({ address }) => /^(?:0\.|10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|198\.(?:18|19)\.|22[4-9]\.|23\d\.|24\d\.|25\d\.)/.test(address)))
    throw new Error("هاست فایل باید آدرس IPv4 عمومی داشته باشد؛ شبکه داخلی مجاز نیست.");
  return { url,address:addresses[0].address };
}
/** Fetch strips Host headers. The low-level client must retain the virtual host
 * while TLS and the TCP destination remain pinned to the validated address. */
export function requestPinnedMedia(url: URL, address: string, dispatcher: Dispatcher, signal: AbortSignal, verifyOnly: boolean) {
  const pinned = new URL(url); pinned.hostname = address;
  return undiciRequest(pinned, { method:"GET", dispatcher,
    headers:{ host:url.host, ...(verifyOnly ? { range:"bytes=0-4095" } : {}) },
    signal });
}
/** Pin the checked destination IP for direct, HTTP proxy and SOCKS paths.
 * Keep the original HTTPS hostname for certificate validation and Host headers on every redirect. */
async function downloadCollectionMedia<T>(workspaceId:string,raw:string,kind:"video"|"image",policyInput:unknown,verifyOnly:boolean,limit:number,
  consume:(body:AsyncIterable<Uint8Array>)=>Promise<T>, timeout=180000) {
  const policy = connectionPolicy(policyInput);
  let dispatcher: Dispatcher | undefined;
  const download = async (proxy: boolean) => {
    let current = dropboxDownloadUrl(raw); const signal = AbortSignal.timeout(timeout);
    for (let redirect = 0; redirect <= 5; redirect++) {
      const { url,address } = await publicMediaAddress(current);
      dispatcher = proxy ? await createProxyDispatcher(await loadPublishingProxy(workspaceId,policy.proxyId!),undefined,url.hostname)
        : new Agent({ connect:{ servername:url.hostname,rejectUnauthorized:true } });
      try {
        const response = await requestPinnedMedia(url,address,dispatcher,signal,verifyOnly);
        if ([301,302,303,307,308].includes(response.statusCode)) {
          const location = response.headers.location; response.body.destroy();
          if (typeof location !== "string") throw new Error("نشانی دانلود پیدا نشد."); current = new URL(location,url).toString(); continue;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) { response.body.destroy(); throw new Error(response.statusCode===401 || response.statusCode===403 ? `هاست فایل اجازهٔ دریافت ${kind==="video" ? "ویدئو" : "کاور"} را نداد (HTTP ${response.statusCode})؛ عمومی‌بودن لینک و محدودیت دانلود هاست را بررسی کنید. این خطا از حساب یوتیوب نیست.` : `دریافت ${kind==="video" ? "ویدئو" : "کاور"} از هاست ناموفق بود (HTTP ${response.statusCode}). لینک فایل را بررسی کنید.`); }
        if (!verifyOnly && Number(response.headers["content-length"]) > limit) { response.body.destroy(); throw new Error(`حجم فایل بیش از سقف ${Math.floor(limit/1_000_000)} مگابایت است.`); }
        try { return await consume(response.body); }
        finally { response.body.destroy(); }

      } finally { await dispatcher.destroy(); dispatcher = undefined; }
    }
    throw new Error("تعداد تغییر مسیر دانلود بیش از حد مجاز است.");
  };
  try { return await download(policy.mode === "proxy"); }
  catch (error) { if (policy.mode !== "auto" || !isConnectionError(error)) throw error; return download(true); }
}

export async function fetchCollectionMedia(workspaceId: string, raw: string, kind: "video" | "image", policyInput?: unknown, verifyOnly = false) {
  const limit=kind === "video" ? 250_000_000 : 2_000_000;
  return downloadCollectionMedia(workspaceId,raw,kind,policyInput,verifyOnly,limit,async(body)=>{
    let size=0;const chunks:Uint8Array[]=[];
    for await(const part of body){
      size+=part.length;if(size>limit && !verifyOnly)throw new Error(`حجم فایل بیش از سقف ${Math.floor(limit/1_000_000)} مگابایت است.`);
      chunks.push(verifyOnly ? part.subarray(0,4096) : part);if(verifyOnly && size>=32)break;
    }
    const bytes=Buffer.concat(chunks);const type=youtubeMediaType(bytes);
    if(!type.startsWith(`${kind}/`))throw new Error(kind === "video" ? "لینک به فایل ویدئو نمی‌رسد؛ صفحه دانلود یا ورود به حساب قابل استفاده نیست." : "کاور باید PNG یا JPEG باشد.");
    return {bytes,type};
  });
}
export async function fetchCollectionVideo(workspaceId:string,raw:string,policyInput?:unknown) {
  const limit=youtubeVideoLimit();
  return downloadCollectionMedia(workspaceId,raw,"video",policyInput,false,limit,
    body=>storeYoutubeVideoStream(workspaceId,body,limit),20*60*1000);
}
