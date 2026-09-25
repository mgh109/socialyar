/** Reads the publicly visible Eitaa channel page. Eitaayar's API only supports sending. */
export type EitaaPost = { title: string; text: string; url: string; imageUrl: string | null };

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
    if (!raw) continue;
    const text = decode(raw.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]*>/g, " "))
      .replace(/[ \t]+/g, " ").trim().slice(0, 9000);
    if (!text) continue;
    const rawImage = section.match(/class="[^"]*\betme_widget_message_photo_wrap\b[^"]*"[^>]*style="[^"]*background-image:\s*url\('([^']+)'\)/)?.[1];
    const imageUrl = rawImage?.startsWith("/download_") ? `https://eitaa.com${decode(rawImage)}` : null;
    posts.push({ title: text.split("\n")[0].slice(0, 180), text,
      url: `https://eitaa.com/s/${handle}/${wraps[index][1]}`, imageUrl });
  }
  return posts.slice(-3);
}

export async function fetchEitaaPosts(handle: string): Promise<EitaaPost[]> {
  const response = await fetch(`https://eitaa.com/${handle}`, {
    redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { "User-Agent": "Mozilla/5.0 (compatible; HoorNewsBot/1.0)" },
  });
  if (!response.ok) throw new Error(`Eitaa channel returned ${response.status}`);
  return parseEitaaPosts((await response.text()).slice(0, 2_000_000), handle);
}
