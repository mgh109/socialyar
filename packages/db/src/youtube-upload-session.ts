/** Upload session locations may rotate, but credentials must stay on Google's upload endpoint. */
export function isYoutubeUploadSession(url: URL) {
  return url.protocol === "https:" && url.hostname === "www.googleapis.com" && !url.username && !url.password && !url.port && !url.hash &&
    ["/upload/youtube/v3/videos", "/resumable/upload/youtube/v3/videos"].includes(url.pathname) && !!url.searchParams.get("upload_id");
}

export function youtubeUploadSession(raw: string, base?: string) {
  let url: URL;
  try { url = new URL(raw, base); } catch { throw new Error("نشانی نشست بارگذاری یوتیوب معتبر نیست."); }
  if (!isYoutubeUploadSession(url)) throw new Error("نشانی نشست بارگذاری یوتیوب معتبر نیست.");
  return url.href;
}
