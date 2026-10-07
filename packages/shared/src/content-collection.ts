import { z } from "zod";
const mediaUrl = z.string().trim().url().refine((value) => {
  try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !u.port; } catch { return false; }
}, "لینک فایل باید HTTPS عمومی باشد.");
export const collectionRowSchema = z.object({
  id: z.string().trim().min(1).max(100), order: z.number().int().min(1).max(10000),
  title: z.string().trim().min(1).max(100), description: z.string().max(5000).default(""),
  videoUrl: mediaUrl, coverUrl: z.union([mediaUrl, z.literal("")]).default(""),
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
        fields.every((key) => ["title","description","tags","privacy","madeForKids","coverUrl"].includes(key)) && (!fields.includes("coverUrl") || Boolean(row.coverUrl)) });
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
  if (state.videoId || state.sessionEnc || ["uploading", "processing", "published", "preparing"].includes(state.status))
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
  ["videoType", "نوع محتوا"], ["playlist", "پلی‌لیست"], ["tags", "برچسب‌ها"], ["privacy", "وضعیت نمایش"], ["madeForKids", "مخصوص کودکان"],
] as const;
