const stages:Record<string,string>={authentication:"بررسی دسترسی کانال",source_check:"بررسی لینک ویدئو",upload:"بارگذاری ویدئو",cover_fetch:"دریافت کاور از منبع",cover_upload:"تنظیم کاور در یوتیوب",status_check:"بررسی وضعیت ویدئو در یوتیوب",playlist:"افزودن به پلی‌لیست",complete:"تکمیل انتشار"};
export function youtubePublicationStage(settings:Record<string,unknown>) {
  return stages[String(settings.publicationFailureStage ?? settings.publicationStage)] ?? "تکمیل انتشار";
}
export function youtubeCompletionLabel(confirmed:boolean,status:string) {
  return confirmed && status==="failed" ? "ارسال شد؛ نیازمند تکمیل" : null;
}
export function youtubeFailureTitle(settings:Record<string,unknown>,confirmed:boolean) {
  return `${confirmed ? "ویدئو ارسال شد؛ " : ""}${youtubePublicationStage(settings)} ناموفق بود`;
}
