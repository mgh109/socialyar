import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";
import { lookup } from "node:dns/promises";
import { connectionPolicy, createProxyDispatcher, loadPublishingProxy, isConnectionError } from "./publishing-connection";
import { dropboxDownloadUrl } from "@socialyar/shared";
import { youtubeMediaType } from "./youtube";
export async function publicMediaAddress(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("فایل باید لینک HTTPS عمومی و بدون اطلاعات ورود داشته باشد.");
  const addresses = (await lookup(url.hostname,{ all:true })).filter((a) => a.family===4);
  if (!addresses.length || addresses.some(({ address }) => /^(?:0\.|10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|198\.(?:18|19)\.|22[4-9]\.|23\d\.|24\d\.|25\d\.)/.test(address)))
    throw new Error("هاست فایل باید آدرس IPv4 عمومی داشته باشد؛ شبکه داخلی مجاز نیست.");
  return { url,address:addresses[0].address };
}
/** Pin the checked destination IP for direct, HTTP proxy and SOCKS paths.
 * Keep the original HTTPS hostname for certificate validation and Host headers on every redirect. */
export async function fetchCollectionMedia(workspaceId: string, raw: string, kind: "video" | "image", policyInput?: unknown, verifyOnly = false) {
  const limit = kind === "video" ? 250_000_000 : 2_000_000; const policy = connectionPolicy(policyInput);
  let dispatcher: Dispatcher | undefined;
  const download = async (proxy: boolean) => {
    let current = dropboxDownloadUrl(raw); const signal = AbortSignal.timeout(180000);
    for (let redirect = 0; redirect <= 5; redirect++) {
      const { url,address } = await publicMediaAddress(current);
      dispatcher = proxy ? await createProxyDispatcher(await loadPublishingProxy(workspaceId,policy.proxyId!),undefined,url.hostname)
        : new Agent({ connect:{ servername:url.hostname,rejectUnauthorized:true } });
      const pinned = new URL(url); pinned.hostname = address;
      try {
        const response = await undiciFetch(pinned, { dispatcher, headers:{ Host:url.host, ...(verifyOnly ? { Range:"bytes=0-4095" } : {}) }, redirect:"manual",signal });
        if ([301,302,303,307,308].includes(response.status)) {
          const location = response.headers.get("location"); await response.body?.cancel();
          if (!location) throw new Error("نشانی دانلود پیدا نشد."); current = new URL(location,url).toString(); continue;
        }
        if (!response.ok) { await response.body?.cancel(); throw new Error(`دریافت فایل ناموفق بود (HTTP ${response.status}). لینک عمومی یا مجوز دانلود را بررسی کنید.`); }
        if (!verifyOnly && Number(response.headers.get("content-length")) > limit) { await response.body?.cancel(); throw new Error("حجم فایل بیش از حد مجاز است."); }
        const reader = response.body?.getReader(); if (!reader) throw new Error("فایل خالی است.");
        let size = 0; const chunks: Uint8Array[] = [];
        try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > limit && !verifyOnly) throw new Error("حجم فایل بیش از حد مجاز است."); chunks.push(verifyOnly ? part.value.subarray(0,4096) : part.value); if (verifyOnly && size >= 32) break; } }
        finally { await reader.cancel().catch(()=>{}); }
        const bytes = Buffer.concat(chunks); const type = youtubeMediaType(bytes);
        if (!type.startsWith(`${kind}/`)) throw new Error(kind === "video" ? "لینک به فایل ویدئو نمی‌رسد؛ صفحه دانلود یا ورود به حساب قابل استفاده نیست." : "کاور باید PNG یا JPEG باشد.");
        return { bytes,type };
      } finally { await dispatcher.destroy(); dispatcher = undefined; }
    }
    throw new Error("تعداد تغییر مسیر دانلود بیش از حد مجاز است.");
  };
  try { return await download(policy.mode === "proxy"); }
  catch (error) { if (policy.mode !== "auto" || !isConnectionError(error)) throw error; return download(true); }
}
