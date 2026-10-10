"use client";
import { instagramProblems } from "@socialyar/shared";
import { useEffect, useState } from "react";
import { MediaPreview } from "./youtube-panel";

export function InstagramFields({settings, caption, setSetting, setCaption, disabled = false, inherited = false}: {
  settings: Record<string, unknown>; caption: string; setSetting: (key: string, value: unknown) => void;
  setCaption: (value: string) => void; disabled?: boolean; inherited?: boolean;
}) {
  const type = String(settings.instagramType ?? (settings.videoUrl ? "reel" : "image"));
  const images = Array.isArray(settings.instagramImages) ? settings.instagramImages as string[] : [];
  const imageText = images.join("\n");
  const [albumDraft, setAlbumDraft] = useState(imageText);
  useEffect(() => {
    setAlbumDraft((current) => current.split("\n").map((s) => s.trim()).filter(Boolean).join("\n") === imageText ? current : imageText);
  }, [imageText]);
  const problems = instagramProblems(settings, caption);
  return <section className="instagram-fields" aria-label="تنظیمات انتشار اینستاگرام">
    <label>نوع انتشار<select disabled={disabled} value={type} onChange={(e) => setSetting("instagramType", e.target.value)}>
      <option value="image">پست تصویری</option><option value="reel">ریلز</option><option value="carousel">آلبوم چندتصویری</option>
    </select></label>
    <label>کپشن<textarea rows={5} disabled={disabled} value={caption} onChange={(e) => setCaption(e.target.value)} placeholder={inherited ? "خالی بگذارید تا متن منبع استفاده شود" : "کپشن پست"} /></label>
    <small>{caption.length.toLocaleString("fa-IR")} از ۲۲۰۰ نویسه{inherited ? " · متن اختصاصی شیت بر کپشن پیش‌فرض اولویت دارد." : ""}</small>
    {type === "carousel" ? <label>تصاویر آلبوم؛ هر لینک در یک خط<textarea dir="ltr" rows={5} disabled={disabled} value={albumDraft} onChange={(e) => { setAlbumDraft(e.target.value); setSetting("instagramImages", e.target.value.split("\n").map((s) => s.trim()).filter(Boolean)); }} /></label> : <>
      <label>{type === "reel" ? "لینک ویدئوی ریلز" : "لینک تصویر"}<input dir="ltr" disabled={disabled} value={String(settings[type === "reel" ? "videoUrl" : "imageUrl"] ?? "")} onChange={(e) => setSetting(type === "reel" ? "videoUrl" : "imageUrl", e.target.value || null)} /></label>
      {type === "reel" ? <label>لینک کاور ریلز (اختیاری)<input dir="ltr" disabled={disabled} value={String(settings.imageUrl ?? "")} onChange={(e) => setSetting("imageUrl", e.target.value || null)} /></label> : null}
    </>}
    <small>لینک فایل‌ها باید عمومی و HTTPS باشد؛ تصویر پست و آلبوم را با فرمت JPEG آماده کنید.</small>
    <div className="instagram-preview"><strong>پیش‌نمایش محتوا</strong>
      {type === "carousel" ? images.map((url, index) => <div key={`${index}-${url}`}><small>تصویر {(index + 1).toLocaleString("fa-IR")}</small><MediaPreview url={url} /></div>) : <>
        {type === "reel" ? <MediaPreview video url={String(settings.videoUrl ?? "")} /> : null}
        <MediaPreview url={String(settings.imageUrl ?? "")} />
      </>}
      <p>{caption || (inherited ? "کپشن از منبع دریافت می‌شود." : "بدون کپشن")}</p>
    </div>
    {problems.length ? <div className="connection-note" role="status"><strong>{inherited ? "پیش از انتشار، رسانه را اینجا یا در منبع تکمیل کنید:" : "موارد نیازمند اصلاح:"}</strong>{problems.map((problem) => <p key={problem}>{problem}</p>)}</div> : <small>ساختار محتوا آماده است؛ پذیرش فایل و مجوز انتشار هنگام ارتباط با اینستاگرام بررسی می‌شود.</small>}
  </section>;
}
