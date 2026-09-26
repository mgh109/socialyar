/** Reads the publicly visible Eitaa channel page. Eitaayar's API only supports sending. */
export type EitaaPost = { title: string; text: string; url: string; imageUrl: string | null; videoUrl: string | null;
  videoUnavailable?: boolean };

export function channelHandle(value: string): string {
  const match = value.trim().match(/^(?:https:\/\/eitaa\.com\/(?:s\/)?|@)?([a-zA-Z0-9_]{4,32})\/?$/);
  if (!match) throw new Error("Only public Eitaa channel handles are supported");
  return match[1].toLowerCase();
}

function decode(value: string): string {
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/gi, (entity, code: string) => {
    if (code[0] === "#") {
      const numeric = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isInteger(numeric) && numeric > 0 && numeric <= 0x10ffff ? String.fromCodePoint(numeric) : entity;
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[code.toLowerCase()] ?? entity;
  });
}

export function parseEitaaPosts(html: string, handle: string): EitaaPost[] {
  const wraps = [...html.matchAll(/<div\s+class="[^"]*\bjs-widget_message_wrap\b[^"]*"\s+id="(\d+)"/g)];
  if (!wraps.length) throw new Error("Public channel posts are unavailable");
  const posts: EitaaPost[] = [];
  for (let index = 0; index < wraps.length; index++) {
    const section = html.slice(wraps[index].index, wraps[index + 1]?.index ?? html.length);
    if (!section.includes(`data-post="${handle}/${wraps[index][1]}"`)) continue;
    const raw = section.match(/<div\s+class="[^"]*\bjs-message_text\b[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1];
    const text = raw ? decode(raw.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]*>/g, " "))
      .replace(/[ \t]+/g, " ").trim().replace(/\n\s*@[A-Za-z0-9_]{4,32}\s*$/, "").trim().slice(0, 9000) : "";
    const photoTag = section.match(/<[^>]*\b(?:etme_widget_message_photo_wrap|tgme_widget_message_photo_wrap)\b[^>]*>/)?.[0];
    const rawImage = photoTag && decode(photoTag).match(/background-image\s*:\s*url\(\s*['"]?([^'"\s)]+)['"]?\s*\)/i)?.[1];
    let imageUrl: string | null = null;
    if (rawImage) {
      try { const url = new URL(decode(rawImage), "https://eitaa.com");
        if (url.protocol === "https:" && url.hostname === "eitaa.com") imageUrl = url.href;
      } catch { /* Ignore an unusable photo URL. */ }
    }
    const videoTag = section.match(/<video\b[^>]*>/i)?.[0];
    const rawVideo = videoTag?.match(/\b(?:src|data-src)=["']([^"']+)["']/i)?.[1] ??
      section.match(/<source\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/i)?.[1] ??
      section.match(/<[^>]*\b(?:data-video|data-video-url|data-mp4)=["']([^"']+)["'][^>]*>/i)?.[1];
    let videoUrl: string | null = null;
    if (rawVideo) try { const url = new URL(decode(rawVideo), "https://eitaa.com");
      if (url.protocol === "https:" && !url.username && !url.password) videoUrl = url.href;
    } catch { /* Ignore an unusable video URL. */ }
    const hasVideo = /<(?:video|source)\b|\b(?:etme|tgme)_widget_message_video(?:_|\b)|\bdata-video(?:-url)?=|\bvideo_duration\b/i.test(section);
    if (!text && !videoUrl) continue;
    posts.push({ title: text.split("\n")[0].slice(0, 180) || "ویدئو", text: text || "ویدئو",
      url: `https://eitaa.com/s/${handle}/${wraps[index][1]}`, imageUrl, videoUrl,
      videoUnavailable: hasVideo && !videoUrl });
  }
  return posts.slice(-10);
}

export async function fetchEitaaPosts(handle: string): Promise<EitaaPost[]> {
  const response = await fetch(`https://eitaa.com/${handle}`, {
    redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { "User-Agent": "Mozilla/5.0 (compatible; HoorNewsBot/1.0)" },
  });
  if (!response.ok) throw new Error(`Eitaa channel returned ${response.status}`);
  return parseEitaaPosts((await response.text()).slice(0, 2_000_000), handle);
}
