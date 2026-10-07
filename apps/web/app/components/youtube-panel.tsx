"use client";
import { persianError } from "../lib/persian";
import { useEffect, useState, useRef } from "react";
import { apiFetch } from "../lib/session";
import { ConnectionHistory } from "./connection-history";
import { faDigits } from "../lib/persian-calendar";
import { PersianDateTimeField } from "./persian-date-time-field";

export type YoutubeItem = { id: string; runId: string | null; stepKey: string; status: string; title: string; description: string; channelName: string;
  progress: number; videoId: string | null; actualPrivacy: string | null; error: string | null; updatedAt: string;
  scheduledAt: string | null; settings: Record<string, unknown>; logs: Array<Record<string, unknown>> };
export const youtubeStatus = (item?: YoutubeItem) => !item ? "منتظر ویدئو" : ({ waiting_video: "منتظر ویدئو", preparing: "در حال دریافت فایل", waiting_approval: "منتظر تأیید",
  approved: "بدون زمان‌بندی",
  queued: "در صف انتشار", uploading: `در حال بارگذاری — ${faDigits(item.progress)}٪`, processing: "در حال پردازش یوتیوب",
  prepared: "فایل آماده تأیید است", published: "منتشر شد", failed: "خطا", rejected: "رد شد", cancelled: "متوقف شد" }[item.status] ?? "نامشخص");
const privacyLabels: Record<string,string> = { public: "عمومی", private: "خصوصی", unlisted: "فهرست‌نشده" };
const logLabels: Record<string,string> = { approved_and_queued: "تأیید و ورود به صف", rejected: "رد شد", cancelled: "متوقف شد", retry_queued: "تلاش مجدد در صف", upload_started: "شروع بارگذاری", prepared: "فایل آماده تأیید است", published: "منتشر شد", failed: "خطا", preparation_failed: "خطا در دریافت فایل", connection: "بررسی مسیر اتصال", calendar_schedule: "تغییر زمان از تقویم", calendar_edit: "ویرایش از تقویم", calendar_unschedule: "حذف از برنامه", calendar_approve: "تأیید از تقویم", calendar_reject: "رد از تقویم", calendar_stop: "توقف از تقویم", calendar_retry: "تلاش مجدد از تقویم" };
export function YoutubeIcon() {
  return <svg width="22" height="16" viewBox="0 0 24 18" role="img" aria-label="یوتیوب"><rect width="24" height="18" rx="5" fill="#ff0033" /><path d="M10 4.5v9l7-4.5z" fill="white" /></svg>;
}
export function MediaPreview({ mediaId, url, video, compact }: { mediaId?: unknown; url?: unknown; video?: boolean; compact?: boolean }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let objectUrl = ""; let disposed = false;
    if (typeof mediaId === "string") void apiFetch(`/youtube/media/${mediaId}`).then(async (response) => {
      if (!response.ok) return; const blob = await response.blob(); if (disposed) return;
      objectUrl = URL.createObjectURL(blob); setSrc(objectUrl);
    }); else setSrc(typeof url === "string" && url.startsWith("https://") ? url : "");
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [mediaId, url]);
  if (!src) return null;
  return video ? <video src={src} controls={!compact} muted={compact} preload="metadata" style={{ width: compact ? 48 : "100%", height: compact ? 40 : undefined, maxHeight: 250, objectFit: "cover" }} /> : <img src={src} alt="کاور ویدئو" style={{ width: compact ? 48 : "100%", height: compact ? 40 : undefined, maxHeight: 200, objectFit: compact ? "cover" : "contain" }} />;
}
export function YoutubeReview({ item, refresh }: { item: YoutubeItem; refresh: () => void }) {
  const [title, setTitle] = useState(item.title); const [description, setDescription] = useState(item.description);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const action = async (name: string) => {
    setBusy(true); setError("");
    try {
      const response = await apiFetch(`/youtube/items/${item.id}/${["approve", "reject"].includes(name) ? "resolve" : name}`, {
        method: "POST", body: ["approve", "reject"].includes(name) ? JSON.stringify({ action: name, title, description }) : undefined });
      if (!response.ok) { const data = await response.json(); throw new Error(data.error ?? "ثبت تصمیم ناموفق بود"); }
      refresh();
    } catch (err) { setError(persianError(err, "خطا")); } finally { setBusy(false); }
  };
  return <article className="youtube-review">
    <strong>{item.channelName} · {youtubeStatus(item)}</strong>
    <MediaPreview video mediaId={item.settings.videoMediaId} url={item.settings.videoUrl} />
    <MediaPreview mediaId={item.settings.coverMediaId} url={item.settings.coverUrl} />
    {item.status === "waiting_approval" ? <>
      <p>نوع محتوا: {item.settings.videoType === "shorts" ? "ویدئوی کوتاه / Shorts" : "ویدئوی معمولی"}{item.settings.playlist ? ` · پلی‌لیست: ${String(item.settings.playlist)}` : ""}</p>
    <label>عنوان<input maxLength={100} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label>توضیحات<textarea maxLength={5000} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      <button type="button" disabled={busy || !title.trim()} onClick={() => void action("approve")}>تأیید و انتشار</button>
      <button type="button" disabled={busy} onClick={() => void action("reject")}>رد</button>
    </> : <p>{item.title}</p>}
    {item.scheduledAt ? <p>زمان انتشار: {new Date(item.scheduledAt).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })}</p> : null}
    {item.status === "queued" ? <button type="button" disabled={busy} onClick={() => void action("cancel")}>توقف پیش از آپلود</button> : null}
    {item.status === "failed" ? <button type="button" disabled={busy} onClick={() => void action("retry")}>تلاش مجدد</button> : null}
    {item.status === "published" && item.videoId ? <a href={`https://www.youtube.com/watch?v=${item.videoId}`} target="_blank" rel="noreferrer">مشاهده در یوتیوب</a> : null}
    {item.actualPrivacy ? <p>وضعیت واقعی در یوتیوب: {({ public: "عمومی", private: "خصوصی", unlisted: "فهرست‌نشده" })[item.actualPrivacy] ?? item.actualPrivacy}
      {item.actualPrivacy !== item.settings.privacy ? " — محدودیت انتشار: وضعیت درخواستی اعمال نشده است." : ""}</p> : null}
    {item.error || error ? <p role="alert">{persianError(error || item.error)}</p> : null}
    <ConnectionHistory youtubeItemId={item.id} />
    <details><summary>گزارش اجرا</summary>{item.runId ? <a href={`/runs/${item.runId}`}>اجرای جریان {item.runId.slice(0,8)}</a> : <p>بارگذاری دستی</p>}{item.logs.map((entry, i) => <p key={i}>{String(entry.channel ?? "یوتیوب")} · {new Date(String(entry.time)).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })} · {logLabels[String(entry.result)] ?? "تغییر وضعیت انتشار"}{entry.route ? ` · ${entry.route === "proxy" ? `پروکسی: ${entry.proxyName}` : "مستقیم"}` : ""}{entry.actualPrivacy ? ` · ${privacyLabels[String(entry.actualPrivacy)] ?? "نامشخص"}` : ""}{entry.error ? ` · ${persianError(entry.error)}` : ""}{entry.videoUrl ? <a href={String(entry.videoUrl)} target="_blank" rel="noreferrer"> لینک ویدئو</a> : null}</p>)}</details>
  </article>;
}
export function YoutubePanel({ workflowId, stepKey, accountId, config, update, items, refresh }: {
  workflowId: string | null; stepKey: string; accountId: string; config: Record<string, unknown>;
  update: (key: string, value: unknown) => void; items: YoutubeItem[]; refresh: () => void;
}) {
  const [privateOnly, setPrivateOnly] = useState(true); const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  const [videoMediaId, setVideoMediaId] = useState(""); const [coverMediaId, setCoverMediaId] = useState("");
  const videoInput = useRef<HTMLInputElement>(null); const coverInput = useRef<HTMLInputElement>(null);
  useEffect(() => { void apiFetch("/youtube/config").then((r) => r.json()).then((c) => setPrivateOnly(c.privateOnly)); }, []);
  const upload = async (file: File | undefined, cover: boolean) => {
    if (!file) return; setBusy(true);
    try {
      if (file.size > (cover ? 2_000_000 : 250_000_000)) throw new Error(cover ? "کاور باید کمتر از ۲ مگابایت باشد" : "ویدئو باید کمتر از ۲۵۰ مگابایت باشد");
      const response = await apiFetch("/youtube/media", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file });
      const data = await response.json(); if (!response.ok || data.kind !== (cover ? "image" : "video")) throw new Error(data.error ?? "نوع فایل معتبر نیست");
      if (cover) setCoverMediaId(data.mediaId); else setVideoMediaId(data.mediaId); setMessage("فایل دریافت شد؛ برای ارسال به صف تأیید دکمه را بزنید.");
    } catch (err) { setMessage(persianError(err, "خطای آپلود")); } finally { setBusy(false); }
  };
  const submit = async () => {
    if (!workflowId) { setMessage("ابتدا جریان را ذخیره کنید."); return; } setBusy(true);
    try {
      const waiting = items.find((item) => item.stepKey === stepKey && item.status === "waiting_video");
      const response = await apiFetch(waiting ? `/youtube/items/${waiting.id}/media` : "/youtube/items", { method: waiting ? "PATCH" : "POST", body: JSON.stringify({ workflowId, stepKey, accountId, videoMediaId,
        coverMediaId: coverMediaId || undefined, title: config.youtubeTitle || "ویدئوی جدید", description: config.youtubeDescription ?? "",
        videoType: config.videoType ?? "video", playlist: config.playlist ?? "", privacy: config.privacy ?? "private", tags: config.tags ?? [], madeForKids: config.madeForKids === true, scheduledAt: config.scheduledAt || null, connection: config.connection }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "ثبت آیتم ناموفق بود"); refresh(); setVideoMediaId(""); setMessage("ویدئو منتظر تأیید انسانی است.");
    } catch (err) { setMessage(persianError(err, "خطا")); } finally { setBusy(false); }
  };
  return <section className="youtube-panel">
    <p><YoutubeIcon /> یوتیوب · تأیید انسانی اجباری</p>
    {privateOnly ? <p role="status">این پروژه برای انتشار عمومی تأیید نشده است؛ آپلودها به‌صورت خصوصی انجام می‌شوند.</p> : null}
    <label>نوع محتوا<select value={String(config.videoType ?? "video")} onChange={(e) => update("videoType",e.target.value)}><option value="video">ویدئوی معمولی</option><option value="shorts">ویدئوی کوتاه / Shorts</option></select></label>
    <small>تشخیص Shorts با یوتیوب است؛ فایل باید مربع یا عمودی و حداکثر ۳ دقیقه باشد. فایل خودکار برش نمی‌خورد.</small>
    <label>پلی‌لیست (نام یا شناسه)<input value={String(config.playlist ?? "")} onChange={(e) => update("playlist",e.target.value)} /></label>
    <label>عنوان<input maxLength={100} value={String(config.youtubeTitle ?? "")} onChange={(e) => update("youtubeTitle", e.target.value)} placeholder="عنوان از کارت قبلی" /></label>
    <label>توضیحات<textarea maxLength={5000} value={String(config.youtubeDescription ?? "")} onChange={(e) => update("youtubeDescription", e.target.value)} /></label>
    <label>برچسب‌ها (جداشده با ویرگول)<input value={Array.isArray(config.tags) ? config.tags.join(",") : ""} onChange={(e) => update("tags", e.target.value.split(",").map((v) => v.trim()).filter(Boolean))} /></label>
    <label><input type="checkbox" checked={config.madeForKids === true} onChange={(e) => update("madeForKids", e.target.checked)} /> محتوای مخصوص کودکان</label>
    <label>نوع انتشار<select value={String(config.privacy ?? "private")} onChange={(e) => update("privacy", e.target.value)}>
      <option value="private">خصوصی</option><option value="public" disabled={privateOnly}>عمومی</option><option value="unlisted" disabled={privateOnly}>فهرست‌نشده</option></select></label>
    <div>زمان انتشار<PersianDateTimeField value={config.scheduledAt} onChange={(value) => update("scheduledAt", value)} /></div>
    <label>آدرس امن ویدئو از کارت قبلی<input dir="ltr" value={String(config.videoUrl ?? "")} onChange={(e) => update("videoUrl", e.target.value)} /></label>
    <label>آدرس کاور<input dir="ltr" value={String(config.coverUrl ?? "")} onChange={(e) => update("coverUrl", e.target.value)} /></label>
    <input ref={videoInput} className="sr-only" aria-label="انتخاب فایل ویدئو" type="file" accept="video/mp4,video/webm" disabled={busy} onChange={(e) => void upload(e.target.files?.[0], false)} />
    <button type="button" disabled={busy} onClick={() => videoInput.current?.click()}>انتخاب فایل ویدئو</button>
    <input ref={coverInput} className="sr-only" aria-label="انتخاب فایل کاور" type="file" accept="image/jpeg,image/png" disabled={busy} onChange={(e) => void upload(e.target.files?.[0], true)} />
    <button type="button" disabled={busy} onClick={() => coverInput.current?.click()}>انتخاب تصویر کاور</button>
    <MediaPreview video mediaId={videoMediaId || undefined} /><MediaPreview mediaId={coverMediaId || undefined} />
    <button type="button" disabled={busy || !videoMediaId} onClick={() => void submit()}>ارسال ویدئو به صف تأیید</button><p role="status">{message}</p>
    {items.filter((item) => item.stepKey === stepKey).map((item) => <YoutubeReview key={item.id} item={item} refresh={refresh} />)}
  </section>;
}
export function YoutubeApprovalQueue() {
  const [items, setItems] = useState<YoutubeItem[]>([]);
  const refresh = () => { void apiFetch("/youtube/items").then((r) => r.ok ? r.json() : []).then(setItems); };
  useEffect(() => { refresh(); const timer = setInterval(refresh, 5000); return () => clearInterval(timer); }, []);
  return <section className="workflow-approval-section"><h2>تأیید و انتشار یوتیوب</h2>{items.filter((item) => ["waiting_approval", "queued", "uploading", "processing", "failed"].includes(item.status)).map((item) => <YoutubeReview key={item.id} item={item} refresh={refresh} />)}</section>;
}
