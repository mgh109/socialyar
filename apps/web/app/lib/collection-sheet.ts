import { collectionColumns, collectionRowSchema, type CollectionRow } from "@socialyar/shared";
import { latinDigits, persianToDay, wallTimeToUTC, dayInZone, localParts, addDays } from "./persian-calendar";
export type SheetData = { headers: string[]; rows: string[][] };
export type ColumnMapping = Record<string, number>;
export function inferMapping(headers: string[]): ColumnMapping {
  const result: ColumnMapping = {};
  const aliases:Record<string,string[]>={id:["شناسه"],description:["text","body","caption","متن","کپشن"],coverUrl:["imageurl","لینک تصویر","لینک تصویر / کاور"],videoUrl:["لینک فایل ویدئو"],order:["ترتیب"]};
  for (const [key, label] of collectionColumns) result[key] = headers.findIndex((h) => h.trim() === label || h.trim().toLowerCase() === key.toLowerCase() || aliases[key]?.includes(h.trim().toLowerCase()));
  return result;
}
export async function readCollectionSheet(file: File): Promise<SheetData> {
  if (file.size > 5_000_000) throw new Error("فایل اکسل باید کمتر از ۵ مگابایت باشد.");
  if (!/\.xlsx$/i.test(file.name)) throw new Error("فایل را با فرمت XLSX ذخیره و انتخاب کنید.");
  const ExcelJS = await import("exceljs"); const workbook = new ExcelJS.default.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const sheet = workbook.worksheets[0]; if (!sheet) throw new Error("فایل برگه‌ای ندارد.");
  if (sheet.rowCount > 501 || sheet.columnCount > 60) throw new Error("حداکثر ۵۰۰ ردیف محتوا و ۶۰ ستون در هر فایل مجاز است.");
  const value = (cell: import("exceljs").Cell) => {
    const v = cell.value;
    if (v === null || v === undefined) return "";
    if (typeof v === "object") {
      if ("formula" in v || "sharedFormula" in v) throw new Error("سلول‌های فرمول‌دار را به مقدار ثابت تبدیل کنید.");
      if ("hyperlink" in v) return v.hyperlink;
      if ("richText" in v) return v.richText.map((part) => part.text).join("");
      if (v instanceof Date) throw new Error("تاریخ انتشار را به‌صورت متن شمسی، مانند ۱۴۰۵/۰۷/۲۰ وارد کنید.");
    }
    return cell.text.trim();
  };
  const rows: string[][] = [];
  for (let i = 1; i <= sheet.rowCount; i++) rows.push(Array.from({ length: sheet.columnCount }, (_, index) => value(sheet.getRow(i).getCell(index + 1))));
  return { headers: rows[0] ?? [], rows: rows.slice(1).filter((r) => r.some((v) => v.trim())) };
}
export function mapCollectionRows(sheet: SheetData, mapping: ColumnMapping, defaults: Partial<CollectionRow> = {}) {
  for (const key of ["id", "title"]) if ((mapping[key] ?? -1) < 0) throw new Error("ستون شناسه محتوا و عنوان را مشخص کنید.");
  const rows: CollectionRow[] = []; const errors: string[] = []; const ids = new Set<string>(); const orders = new Set<number>();
  sheet.rows.forEach((values, index) => {
    const get = (key: string) => values[mapping[key]]?.trim() ?? "";
    try {
      let scheduledAt: string | null = null;
      if (get("date")) {
        const date = latinDigits(get("date")).match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/);
        const time = latinDigits(get("time") || (date?.[4] ? `${date[4]}:${date[5]}` : "18:00")).match(/^(\d{1,2}):(\d{2})$/);
        if (!date || !time) throw new Error("تاریخ شمسی یا ساعت معتبر نیست.");
        scheduledAt = wallTimeToUTC(persianToDay(Number(date[1]),Number(date[2]),Number(date[3])),Number(time[1]),Number(time[2]),"Asia/Tehran").toISOString();
      } else if (get("time")) throw new Error("ساعت انتشار به تاریخ نیاز دارد.");
      const type = get("videoType").toLowerCase(); const privacy = get("privacy").toLowerCase(); const kids = latinDigits(get("madeForKids")).toLowerCase();
      const videoTypes: Record<string,string> = { video: "video", "ویدئو": "video", "ویدئوی معمولی": "video", shorts: "shorts", "شورت": "shorts", "ویدئوی کوتاه": "shorts" };
      const privacies: Record<string,string> = { public: "public", "عمومی": "public", private: "private", "خصوصی": "private", unlisted: "unlisted", "فهرست‌نشده": "unlisted" };
      if (type && !videoTypes[type]) throw new Error("نوع محتوا باید ویدئو یا Shorts باشد.");
      if (privacy && !privacies[privacy]) throw new Error("وضعیت نمایش معتبر نیست.");
      if (kids && !["true", "false", "بله", "خیر", "1", "0"].includes(kids)) throw new Error("مخصوص کودکان را بله یا خیر وارد کنید.");
      const specific=Object.fromEntries(["youtubeDescription","instagramCaption","telegramText","eitaaText","baleText"].filter((key)=>(mapping[key]??-1)>=0).map((key)=>[key,get(key)]));
      const row = collectionRowSchema.parse({ ...defaults,...specific,
        ...((mapping.instagramType ?? -1) >= 0 ? {instagramType:get("instagramType") || undefined} : {}),
        ...((mapping.instagramImages ?? -1) >= 0 ? {instagramImages:get("instagramImages").split(/\n|\|/).map((value)=>value.trim()).filter(Boolean)} : {}), id: get("id"), order: get("order") ? Number(latinDigits(get("order"))) : index + 1,
        title: get("title"), description: get("description"), videoUrl: get("videoUrl"), coverUrl: get("coverUrl"), scheduledAt,
        videoType: type ? videoTypes[type] : defaults.videoType ?? "video", privacy: privacy ? privacies[privacy] : defaults.privacy ?? "private",
        playlist: get("playlist") || defaults.playlist || "", tags: get("tags") ? get("tags").split(/[,،]/).map((v) => v.trim()).filter(Boolean) : defaults.tags ?? [],
        madeForKids: kids ? ["true", "بله", "1"].includes(kids) : defaults.madeForKids ?? false });
      if (ids.has(row.id)) throw new Error("شناسه تکراری است؛ هر محتوا باید شناسه ثابت و یکتا داشته باشد.");
      if (orders.has(row.order)) throw new Error("ترتیب قسمت تکراری است.");
      ids.add(row.id); orders.add(row.order); rows.push(row);
    } catch (e) { errors.push(`ردیف ${(index + 2).toLocaleString("fa-IR")}: ${e instanceof Error && "issues" in e ? "اطلاعات ضروری، طول متن یا لینک فایل معتبر نیست." : e instanceof Error ? e.message : "نامعتبر"}`); }
  });
  return { rows, errors };
}
export function scheduleCollectionRows(rows: CollectionRow[], start: string, intervalDays: number, weekdays: number[]) {
  if (!start || !Number.isInteger(intervalDays) || intervalDays < 1 || intervalDays > 365 || !weekdays.length) throw new Error("زمان شروع، فاصله و حداقل یک روز هفته را انتخاب کنید.");
  const clock = localParts(new Date(start), "Asia/Tehran"); let day = dayInZone(new Date(start));
  return [...rows].sort((a,b) => a.order-b.order).map((row) => {
    if (row.scheduledAt) return row;
    while (!weekdays.includes((day.getUTCDay()+1)%7)) day = addDays(day,1);
    const scheduledAt = wallTimeToUTC(day,clock.hour,clock.minute,"Asia/Tehran").toISOString(); day = addDays(day, intervalDays);
    return { ...row, scheduledAt };
  });
}
export async function downloadCollectionTemplate() {
  const ExcelJS = await import("exceljs"); const workbook = new ExcelJS.default.Workbook(); const sheet = workbook.addWorksheet("مجموعه محتوا", { views: [{ rightToLeft: true }] });
  sheet.columns = collectionColumns.map(([key,header]) => ({ key, header, width: ["description","videoUrl","coverUrl"].includes(key) ? 40 : 22 }));
  sheet.addRow({ id: "sample-video-01", order: 1, title: "نمونه ویدئوی آموزشی", description: "توضیحات مشترک برای مقصدهایی که متن اختصاصی ندارند.",
    videoUrl: "https://example.com/video.mp4", coverUrl: "", date: "", time: "", videoType: "video", playlist: "آموزش", tags: "آموزش,قرآن,تلاوت", privacy: "private", madeForKids: "خیر" });
  sheet.addRow({ id: "sample-shorts-02", order: 2, title: "نمونه ویدئوی کوتاه", description: "توضیحات مشترک ویدئوی کوتاه.", youtubeDescription: "توضیحات اختصاصی این ویدئو در یوتیوب.",
    videoUrl: "https://example.com/short.mp4", coverUrl: "", date: "", time: "", videoType: "shorts", playlist: "", tags: "ویدئوی کوتاه,آموزش", privacy: "unlisted", madeForKids: "false" });
  sheet.getRow(1).font = { bold: true }; sheet.getColumn("id").numFmt = "@"; sheet.getColumn("date").numFmt = "@"; sheet.getColumn("time").numFmt = "@";
  const help = workbook.addWorksheet("راهنما", { views: [{ rightToLeft: true }] }); help.getColumn(1).width = 100;
  ["دو ردیف اول نمونه‌اند؛ پیش از ورود، آن‌ها را حذف کنید یا با اطلاعات و لینک واقعی خود جایگزین کنید. لینک‌های example.com فایل واقعی نیستند.", "توضیحات متن مشترک است؛ در هر مقصد، اگر متن اختصاصی آن مقصد خالی باشد، همین متن استفاده می‌شود.", "توضیحات یوتیوب، کپشن اینستاگرام و متن تلگرام/ایتا/بله اختیاری‌اند؛ مقدار پرشده فقط در همان مقصد جای توضیحات مشترک را می‌گیرد.", "هر ردیف یک محتوا است. شناسه محتوا ثابت، یکتا و متنی باشد؛ بعداً عوض نشود.", "شناسه و عنوان الزامی‌اند؛ لینک ویدئو برای یوتیوب الزامی است. برای دراپ‌باکس لینک اشتراک عمومی فایل را وارد کنید.",
    "تاریخ را متنی و شمسی مانند ۱۴۰۵/۰۷/۲۰ و ساعت را مانند ۱۸:۰۰ وارد کنید. تاریخ خالی را می‌توان در کارت زمان‌بندی کرد.",
    "نوع محتوا: video یا shorts. وضعیت نمایش: private، public یا unlisted. مخصوص کودکان: بله یا خیر.",
    "برچسب‌ها با ویرگول جدا شوند. نام پلی‌لیست یا شناسه PL… قابل استفاده است.", "برای به‌روزرسانی، نسخه کامل مجموعه را با همان شناسه‌ها بارگذاری کنید. حذف‌ها فقط با تأیید اعمال می‌شوند."].forEach((v) => help.addRow([v]));
  help.addRow([]);
  help.addRow(["عنوان ستون", "اجباری / اختیاری", "راهنما"]);
  help.getColumn(1).width = 50; help.getColumn(2).width = 30; help.getColumn(3).width = 85;
  for (const [key, label] of collectionColumns) {
    const requirement = ["id", "title"].includes(key) ? "اجباری" : key === "videoUrl" ? "برای یوتیوب اجباری" : "اختیاری";
    const note = key === "order" ? "اگر خالی باشد، ترتیب ردیف استفاده می‌شود." : key === "date" ? "شمسی؛ اگر خالی باشد زمان را در کارت تعیین کنید." : key === "time" ? "با تاریخ استفاده شود؛ در صورت خالی‌بودن، ۱۸:۰۰ به وقت تهران." :
      key === "videoType" ? "video یا shorts؛ اگر خالی باشد از تنظیم کارت استفاده می‌شود." : key === "privacy" ? "private / public / unlisted؛ اگر خالی باشد از تنظیم کارت استفاده می‌شود." :
      key === "madeForKids" ? "بله / خیر یا true / false؛ اگر خالی باشد از تنظیم کارت استفاده می‌شود." : key === "tags" ? "برچسب‌ها با ویرگول جدا شوند." :
      key === "instagramType" ? "image برای پست، reel برای ریلز یا carousel برای آلبوم؛ خالی یعنی تشخیص از رسانه." : key === "instagramImages" ? "۲ تا ۱۰ لینک تصویر JPEG؛ هر لینک در یک خط یا جداشده با |." : key === "playlist" ? "نام پلی‌لیست یا شناسه PL…؛ خالی یعنی استفاده از تنظیم کارت در صورت وجود." : key === "description" ? "متن مشترک؛ متن اختصاصی هر شبکه بر آن اولویت دارد." :
      ["youtubeDescription", "instagramCaption", "telegramText", "eitaaText", "baleText"].includes(key) ? "فقط برای همین شبکه؛ خالی یعنی استفاده از توضیحات مشترک." :
      key === "coverUrl" ? "لینک تصویر/کاور؛ برای اینستاگرام حداقل تصویر یا ویدئو لازم است." : key === "videoUrl" ? "لینک عمومی فایل واقعی ویدئو." : key === "id" ? "شناسه متنی ثابت و یکتا." : "عنوان محتوا.";
    help.addRow([label, requirement, note]);
    sheet.getRow(1).getCell(collectionColumns.findIndex(([field]) => field === key) + 1).note = `${requirement} — ${note}`;
  }
  const bytes = await workbook.xlsx.writeBuffer(); const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = "hoor-content-template.xlsx"; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
