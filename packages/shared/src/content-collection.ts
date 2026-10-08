import { z } from "zod";
const mediaUrl = z.string().trim().url().refine((value) => {
  try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !u.port; } catch { return false; }
}, "لینک فایل باید HTTPS عمومی باشد.");
export const collectionRowSchema = z.object({
  id: z.string().trim().min(1).max(100), order: z.number().int().min(1).max(10000),
  title: z.string().trim().min(1).max(100), description: z.string().max(5000).default(""),
  youtubeDescription:z.string().max(5000).optional(),instagramCaption:z.string().max(2200).optional(),
  telegramText:z.string().max(4096).optional(),eitaaText:z.string().max(5000).optional(),baleText:z.string().max(4096).optional(),
  videoUrl: z.union([mediaUrl, z.literal("")]).default(""), coverUrl: z.union([mediaUrl, z.literal("")]).default(""),
  scheduledAt: z.string().datetime().nullable().default(null),
  videoType: z.enum(["video", "shorts"]).default("video"), playlist: z.string().trim().max(150).default(""),
  tags: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  privacy: z.enum(["public", "unlisted", "private"]).default("private"), madeForKids: z.boolean().default(false),
});
export type CollectionRow = z.infer<typeof collectionRowSchema>;
export const collectionRowsSchema = z.array(collectionRowSchema).max(500).superRefine((rows, ctx) => {
  const ids = new Set<string>(); const orders = new Set<number>();
  rows.forEach((row, index) => {
    if (ids.has(row.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: "شناسه محتوا تکراری است." });
    if (orders.has(row.order)) ctx.addIssue({ code: "custom", path: [index, "order"], message: "ترتیب قسمت تکراری است." });
    ids.add(row.id); orders.add(row.order);
  });
});
export type CollectionRecord = { row: CollectionRow; itemId: string; active: boolean };
export type CollectionItemState = { id: string; status: string; queueVersion: number; videoId: string | null; sessionEnc?: string | null; updatedAt: Date | string };
export type CollectionChange = { id: string; kind: "added" | "changed" | "removed" | "unchanged"; row: CollectionRow;
  before: CollectionRow | null; itemId: string | null; version: number | null; updatedAt: string | null; fields: string[]; blocked: string | null; status: string | null; remoteEligible: boolean };
export function collectionDiff(incoming: CollectionRow[], records: CollectionRecord[], items: CollectionItemState[]): CollectionChange[] {
  const old = new Map(records.map((r) => [r.row.id, r])); const states = new Map(items.map((i) => [i.id, i]));
  const next = new Map(incoming.map((r) => [r.id, r]));
  const result: CollectionChange[] = [];
  for (const row of [...incoming].sort((a,b) => a.order - b.order)) {
    const previous = old.get(row.id); const state = previous ? states.get(previous.itemId) : undefined;
    const fields = previous ? (Object.keys(row) as Array<keyof CollectionRow>).filter((key) => JSON.stringify(row[key]) !== JSON.stringify(previous.row[key])) : [];
    const kind = !previous ? "added" : fields.length || !previous.active ? "changed" : "unchanged";
    result.push({ id: row.id, row, before: previous?.row ?? null, itemId: previous?.itemId ?? null,
      version: state?.queueVersion ?? null, updatedAt: state ? new Date(state.updatedAt).toISOString() : null, fields, kind,
      blocked: kind === "unchanged" ? null : locked(state), status: state?.status ?? null,
      remoteEligible: kind === "changed" && state?.status === "published" && Boolean(state.videoId) && Boolean(previous?.active) && fields.length > 0 &&
        fields.every((key) => ["title","description","youtubeDescription","tags","privacy","madeForKids","coverUrl"].includes(key)) && (!fields.includes("coverUrl") || Boolean(row.coverUrl)) });
  }
  for (const record of records.filter((r) => r.active && !next.has(r.row.id))) {
    const state = states.get(record.itemId);
    result.push({ id: record.row.id, kind: "removed", row: record.row, before: record.row, itemId: record.itemId,
      version: state?.queueVersion ?? null, updatedAt: state ? new Date(state.updatedAt).toISOString() : null, fields: [], blocked: locked(state), status: state?.status ?? null, remoteEligible:false });
  }
  return result;
}
function locked(state?: CollectionItemState) {
  if (!state) return null;
  if (state.videoId || state.sessionEnc || ["uploading", "processing", "published", "preparing", "publishing", "delivery_unknown"].includes(state.status))
    return "دریافت یا آپلود آغاز شده یا ویدئو در مقصد ثبت شده است؛ تغییر خودکار مجاز نیست.";
  return null;
}
export function dropboxDownloadUrl(raw: string) {
  const url = new URL(raw);
  if (["www.dropbox.com", "dropbox.com"].includes(url.hostname)) { url.searchParams.delete("dl"); url.searchParams.set("raw", "1"); }
  return url.toString();
}
export const collectionColumns = [
  ["id", "شناسه محتوا"], ["order", "ترتیب قسمت"], ["title", "عنوان"], ["description", "توضیحات"],
  ["videoUrl", "لینک ویدئو"], ["coverUrl", "لینک کاور"], ["date", "تاریخ انتشار شمسی"], ["time", "ساعت انتشار"],
  ["youtubeDescription","توضیحات یوتیوب"],["instagramCaption","کپشن اینستاگرام"],["telegramText","متن تلگرام"],["eitaaText","متن ایتا"],["baleText","متن بله"],
  ["videoType", "نوع محتوا"], ["playlist", "پلی‌لیست"], ["tags", "برچسب‌ها"], ["privacy", "وضعیت نمایش"], ["madeForKids", "مخصوص کودکان"],
] as const;

export const collectionDestinations = ["youtube", "telegram", "eitaa", "bale", "instagram", "website"] as const;
export function collectionBody(row: CollectionRow,channel?:string) {
  const specific=channel==="youtube" ? row.youtubeDescription : channel==="instagram" ? row.instagramCaption : channel==="telegram" ? row.telegramText : channel==="eitaa" ? row.eitaaText : channel==="bale" ? row.baleText : undefined;
  return specific || row.description || (channel==="youtube" ? "" : row.title);
}
export function collectionTextChanged(fields:string[],channel:string) {
  const specific=channel==="youtube" ? "youtubeDescription" : channel==="instagram" ? "instagramCaption" : `${channel}Text`;
  return fields.includes("description") || fields.includes(specific);
}
export function validateCollectionDestination(rows: CollectionRow[], channel: string) {
  if (!collectionDestinations.includes(channel as typeof collectionDestinations[number])) throw new Error("این مقصد برای مجموعه محتوا پشتیبانی نمی‌شود.");
  for (const row of rows) {
    if (channel === "youtube" && !row.videoUrl) throw new Error(`«${row.title}»: یوتیوب به لینک ویدئو نیاز دارد.`);
    if (channel === "instagram" && !row.videoUrl && !row.coverUrl) throw new Error(`«${row.title}»: اینستاگرام به تصویر یا ویدئو نیاز دارد.`);
    const text = `${row.title}\n\n${collectionBody(row,channel)}`;
    if (["telegram", "bale"].includes(channel) && text.length > (row.videoUrl || row.coverUrl ? 1024 : 4096)) throw new Error(`«${row.title}»: متن از محدودیت مقصد طولانی‌تر است.`);
    if (channel === "instagram" && text.length > 2200) throw new Error(`«${row.title}»: کپشن اینستاگرام حداکثر ۲۲۰۰ نویسه است.`);
  }
}
