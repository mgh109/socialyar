export function baleHandle(value: string): string {
  const match = value.trim().match(/^(?:https:\/\/ble\.ir\/(?:s\/)?|@)?([a-zA-Z0-9_]{4,32})\/?$/);
  if (!match) throw new Error("Only public Bale channel handles are supported");
  return match[1].toLowerCase();
}

function plainText(value: string) {
  return value.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<\/(?:span|p|div)>/gi, "\n")
    .replace(/<[^>]*>/g, " ").replace(/&(#(?:x[\da-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/gi, (entity, code: string) => {
      if (code[0] === "#") {
        const number = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : entity;
      }
      return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[code.toLowerCase()] ?? entity;
    }).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim().slice(0, 9000);
}

export function parseBalePosts(html: string, handle: string) {
  const starts = [...html.matchAll(/<div\s+data-sid="([\w-]+)"\s+class="[^"]*MessageItem_messageWrapper__/g)];
  if (!starts.length) throw new Error("Public Bale channel posts are unavailable");
  const posts: { id: string; title: string; text: string; url: string; imageUrl: string | null }[] = [];
  for (let index = 0; index < starts.length; index++) {
    const section = html.slice(starts[index].index, starts[index + 1]?.index ?? html.length);
    const body = section.match(/<div\s+class="Text_text__[^" ]+"[^>]*>([\s\S]*?)<div\s+class="Info_info__/i)?.[1];
    if (!body) continue;
    const text = plainText(body);
    if (!text) continue;
    const image = section.match(/<img\b[^>]*\b(?:src|data-src)="(https:\/\/file-gw[\w.-]*\.ble\.ir\/[^" ]+)"/i)?.[1];
    posts.push({ id: starts[index][1], title: text.split("\n")[0].slice(0, 180), text,
      url: `https://ble.ir/s/${handle}`, imageUrl: image ? image.replace(/&amp;/g, "&") : null });
  }
  return posts.slice(-10);
}

export async function fetchBalePosts(handle: string) {
  const response = await fetch(`https://ble.ir/s/${handle}`, { redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { "User-Agent": "Mozilla/5.0 (compatible; HoorNewsBot/1.0)" } });
  if (!response.ok) throw new Error(`Bale channel returned ${response.status}`);
  return parseBalePosts((await response.text()).slice(0, 2_000_000), handle);
}
