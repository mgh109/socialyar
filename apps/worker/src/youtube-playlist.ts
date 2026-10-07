import { and, eq } from "drizzle-orm";
import { getDb, getPool, youtubeItems, googleJson } from "@socialyar/db";
export async function attachYoutubePlaylist(item: typeof youtubeItems.$inferSelect, token: string, request: typeof fetch, privateOnly: boolean) {
  const name = String(item.settings.playlist ?? "").trim(); if (!name || !item.videoId) return;
  // Serialize playlist creation and ordering across all workers for this channel.
  const client = await getPool().connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))",[`youtube-playlist:${item.accountId}`]);
    const api = async (path: string, init?: RequestInit) => googleJson(await request(`https://www.googleapis.com/youtube/v3/${path}`, {
      ...init, headers:{ Authorization:`Bearer ${token}`, "Content-Type":"application/json", ...init?.headers }, signal:AbortSignal.timeout(15000) }));
    const list = async (path: string) => {
      const items: any[] = []; let page = "";
      do { const result = await api(`${path}${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`); items.push(...(result.items ?? [])); page = result.nextPageToken ?? ""; }
      while (page && items.length < 10000);
      if (page) throw new Error("پلی‌لیست بسیار بزرگ است؛ شناسه پلی‌لیست کوچک‌تر را انتخاب کنید."); return items;
    };
    let playlistId: string;
    if (/^PL[\w-]+$/.test(name)) {
      const result = await api(`playlists?part=snippet&id=${encodeURIComponent(name)}`);
      if (result.items?.[0]?.snippet?.channelId !== (await getChannelId(item.accountId))) throw new Error("پلی‌لیست متعلق به کانال مقصد نیست.");
      playlistId = name;
    } else {
      const found = (await list("playlists?part=snippet&mine=true&maxResults=50")).find((p) => p.snippet?.title === name);
      playlistId = found?.id ?? (await api("playlists?part=snippet,status",{ method:"POST", body:JSON.stringify({ snippet:{ title:name },status:{ privacyStatus:privateOnly ? "private" : item.settings.privacy ?? "private" } }) })).id;
    }
    if (!playlistId) throw new Error("پلی‌لیست ساخته نشد.");
    const entries = await list(`playlistItems?part=snippet&playlistId=${encodeURIComponent(playlistId)}&maxResults=50`);
    if (!entries.some((e) => e.snippet?.resourceId?.videoId === item.videoId)) {
      const related = item.settings.collectionId ? await getDb().select().from(youtubeItems).where(and(eq(youtubeItems.workflowId,item.workflowId),eq(youtubeItems.accountId,item.accountId))) : [];
      const lower = new Set(related.filter((r) => r.settings.collectionId === item.settings.collectionId && r.videoId && Number(r.settings.order) < Number(item.settings.order)).map((r) => r.videoId));
      const higher = new Set(related.filter((r) => r.settings.collectionId === item.settings.collectionId && r.videoId && Number(r.settings.order) > Number(item.settings.order)).map((r) => r.videoId));
      const firstHigher = entries.findIndex((e) => higher.has(e.snippet?.resourceId?.videoId));
      const lastLower = entries.reduce((index,e,i) => lower.has(e.snippet?.resourceId?.videoId) ? i : index,-1);
      const position = firstHigher >= 0 ? firstHigher : lastLower >= 0 ? lastLower+1 : entries.length;
      await api("playlistItems?part=snippet",{ method:"POST",body:JSON.stringify({ snippet:{ playlistId,position,resourceId:{ kind:"youtube#video",videoId:item.videoId } } }) });
    }
    await getDb().update(youtubeItems).set({ settings:{ ...item.settings,playlistId },updatedAt:new Date() }).where(eq(youtubeItems.id,item.id));
  } finally { await client.query("SELECT pg_advisory_unlock(hashtext($1))",[`youtube-playlist:${item.accountId}`]).catch(()=>{}); client.release(); }
}
async function getChannelId(accountId: string) {
  const { socialAccounts } = await import("@socialyar/db"); const [account] = await getDb().select().from(socialAccounts).where(eq(socialAccounts.id,accountId)); return account?.externalAccountId;
}
