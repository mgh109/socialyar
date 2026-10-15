"use client";
import type {YoutubeItem} from "../lib/approval-types";
import { youtubeCompletionLabel,youtubeFailureTitle,youtubePublicationStage } from "../lib/youtube-publication";
import { YOUTUBE_COVER_MAX_BYTES } from "@socialyar/shared";
import { FieldHelp } from "./field-help";
import { persianError, diagnosticErrorCode } from "../lib/persian";
import { useEffect, useState, useRef } from "react";
import { apiFetch } from "../lib/session";
import { ConnectionHistory } from "./connection-history";
import { faDigits } from "../lib/persian-calendar";
import { PersianDateTimeField } from "./persian-date-time-field";

export type {YoutubeItem} from "../lib/approval-types";
const preparationStageNames: Record<string,string> = {queued:"در صف آماده‌سازی",video_link:"در حال بررسی لینک ویدئو",cover_link:"در حال بررسی لینک کاور",video_download:"در حال دریافت ویدئو",video_inspection:"در حال بررسی ویدئو",image_generation:"در حال تولید کاور",cover_download:"در حال آماده‌سازی کاور",ready:"آماده تأیید"};
const preparationStageLabels: Record<string,string> = {video_link:"بررسی لینک ویدئو ناموفق",cover_link:"بررسی لینک کاور ناموفق",cover_download:"دریافت کاور ناموفق",video_inspection:"بررسی ویدئو ناموفق",image_generation:"تولید تصویر ناموفق",video_download:"دریافت ویدئو ناموفق"};
export const youtubeStatus = (item?: YoutubeItem) => !item ? "منتظر ویدئو" : ({ waiting_video: item.settings.collectionId ? "در صف آماده‌سازی" : "منتظر ویدئو", preparing: preparationStageNames[String(item.settings.preparationStage)] ?? "در حال آماده‌سازی", waiting_approval: "منتظر تأیید",
  approved: "بدون زمان‌بندی",
  queued: "در صف انتشار", uploading: `در حال بارگذاری — ${faDigits(item.progress)}٪`, processing: item.videoId ? `ویدئو ارسال شد؛ ${youtubePublicationStage(item.settings)}` : "در حال پردازش یوتیوب",
  prepared: "محتوا آماده تأیید است", published: "منتشر شد", failed: youtubeCompletionLabel(Boolean(item.videoId),item.status) ?? preparationStageLabels[String(item.settings.preparationFailureStage)] ?? "عملیات ناموفق", rejected: "رد شد", cancelled: "متوقف شد" }[item.status] ?? "نامشخص");
const privacyLabels: Record<string,string> = { public: "عمومی", private: "خصوصی", unlisted: "فهرست‌نشده" };
const logLabels: Record<string,string> = { approved_and_queued: "تأیید و ورود به صف", rejected: "رد شد", cancelled: "متوقف شد", retry_queued: "تلاش مجدد در صف", upload_started: "شروع بارگذاری", read_retry:"تکرار خودکار بررسی ارتباط", video_link_checked:"لینک ویدئو آماده انتقال است", prepared: "محتوا آماده تأیید است", published: "منتشر شد", failed: "خطا", preparation_failed: "آماده‌سازی ناموفق", preparation_queued:"در صف آماده‌سازی", video_downloaded:"ویدئو دریافت شد", video_inspected:"ویدئو بررسی شد", video_recovery:"فایل قبلی در دسترس نبود؛ دریافت دوباره از منبع", connection: "بررسی مسیر اتصال", calendar_schedule: "تغییر زمان از تقویم", calendar_edit: "ویرایش از تقویم", calendar_unschedule: "حذف از برنامه", calendar_approve: "تأیید از تقویم", calendar_reject: "رد از تقویم", calendar_stop: "توقف از تقویم", calendar_retry: "تلاش مجدد از تقویم" };
export function YoutubeIcon() {
  return <svg width="22" height="16" viewBox="0 0 24 18" role="img" aria-label="یوتیوب"><rect width="24" height="18" rx="5" fill="#ff0033" /><path d="M10 4.5v9l7-4.5z" fill="white" /></svg>;
}
export function MediaPreview({ mediaId, url, video, compact }: { mediaId?: unknown; url?: unknown; video?: boolean; compact?: boolean }) {
  const [src, setSrc] = useState(""); const [loadVideo,setLoadVideo] = useState(false); const [loadError,setLoadError] = useState("");
  useEffect(() => {
    let objectUrl = ""; let disposed = false; setSrc(""); setLoadError("");
    const remote = typeof url === "string" && url.startsWith("https://") ? url : "";
    // Collection videos can be hundreds of MB. Preview the host URL without eagerly
    // downloading the entire authenticated file into a browser Blob on every open.
    if(remote && (video || !mediaId)) {setSrc(remote);return;}
    if(video && !loadVideo)return;
    if (typeof mediaId === "string") void apiFetch(`/youtube/media/${mediaId}`).then(async (response) => {
      if (!response.ok) throw new Error("پیش‌نمایش فایل در دسترس نیست؛ این وضعیت به‌تنهایی نتیجهٔ آماده‌سازی را تغییر نمی‌دهد.");
      const blob = await response.blob(); if (disposed) return;
      objectUrl = URL.createObjectURL(blob); setSrc(objectUrl);
    }).catch(error=>{if(!disposed)setLoadError(persianError(error));}); else setSrc(remote);
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [mediaId, url, video, loadVideo]);
  if(loadError)return <p className="media-preview-note" role="status">{loadError}</p>;
  if (!src) return video && mediaId && !loadVideo ? <button type="button" className="ghost-button" onClick={()=>setLoadVideo(true)}>دریافت پیش‌نمایش ویدئو</button> : null;
  return video ? <video src={src} controls={!compact} muted={compact} preload="none" style={{ width: compact ? 48 : "100%", height: compact ? 40 : undefined, maxHeight: 250, objectFit: "contain" }} /> : <img src={src} alt="کاور ویدئو" style={{ width: compact ? 48 : "100%", height: compact ? 40 : undefined, maxHeight: 200, objectFit: compact ? "cover" : "contain" }} />;
}
function PreparationProgress({item}:{item:YoutubeItem}) {
  if(!item.settings.collectionId)return null;
  const stage=String(item.settings.preparationFailureStage ?? item.settings.preparationStage ?? "queued");
  const active=({queued:0,video_link:0,video_download:0,video_inspection:1,image_generation:2,cover_link:2,cover_download:2,ready:3} as Record<string,number>)[stage] ?? 0;
  const ready=["waiting_approval","queued","uploading","processing","published"].includes(item.status);
  return <ol className="youtube-stages" aria-label="وضعیت آماده‌سازی">
    {["بررسی لینک","مشخصات ویدئو","بررسی کاور","تأیید انتشار"].map((label,index)=>{
      const done=ready ? index<3 : index<active;
      const failed=item.status==="failed" && !item.videoId && index===active;
      return <li key={label} className={failed ? "failed" : done ? "done" : index===active ? "active" : ""}><span aria-hidden="true">{failed ? "!" : done ? "✓" : faDigits(index+1)}</span>{label}</li>;
    })}
  </ol>;
}
function DownloadProgress({item}:{item:YoutubeItem}) {
  if(item.settings.mediaTransfer==="remote")return null;
  if(item.status!=="preparing" || item.settings.preparationStage!=="video_download")return null;
  const bytes=Number(item.settings.videoDownloadedBytes) || 0,total=Number(item.settings.videoTotalBytes) || 0;
  const mb=(value:number)=>(value/1_000_000).toLocaleString("fa-IR",{maximumFractionDigits:1});
  return <div className="youtube-download-progress" role="status"><span>{mb(bytes)}{total ? ` از ${mb(total)}` : ""} مگابایت دریافت شد</span><progress aria-label="دریافت ویدئو" max={total || undefined} value={total ? bytes : undefined}/></div>;
}

export function YoutubeReview({ item, refresh,reviewMode=false,disabled=false,onBusyChange,onActionResult }: { item: YoutubeItem; refresh: () => void;reviewMode?:boolean;disabled?:boolean;onBusyChange?:(busy:boolean)=>void;onActionResult?:(action:string)=>void }) {
  const [title, setTitle] = useState(item.title); const [description, setDescription] = useState(item.description);
  const [editing,setEditing]=useState(!reviewMode);
  const previousReviewVersion=useRef(item.updatedAt);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [actionResult,setActionResult] = useState("");
  useEffect(()=>{setActionResult("");setError("");if(previousReviewVersion.current!==item.updatedAt && (!reviewMode||!editing)){setTitle(item.title);setDescription(item.description);}previousReviewVersion.current=item.updatedAt;},[item.id,item.updatedAt,editing,reviewMode]);
  const action = async (name: string) => {
    if(disabled)return;
    setBusy(true);onBusyChange?.(true);setError("");
    try {
      const response = await apiFetch(`/youtube/items/${item.id}/${["approve", "reject"].includes(name) ? "resolve" : name}`, {
        method: "POST", body: ["approve", "reject"].includes(name) ? JSON.stringify({ action: name, title, description }) : undefined });
      if (!response.ok) { const data = await response.json(); throw new Error(data.error ?? "ثبت تصمیم ناموفق بود"); }
      setActionResult(name === "retry" ? "درخواست ثبت شد؛ وضعیت آماده‌سازی به‌روز می‌شود…" : "تصمیم ثبت شد؛ وضعیت به‌روز می‌شود…"); onActionResult?.(name);refresh();
    } catch (err) { setError(persianError(err, "خطا")); } finally { setBusy(false);onBusyChange?.(false); }
  };
  return <article className={`youtube-review${reviewMode?" review-reading-card":""}`}>
    {!reviewMode?<strong>{item.channelName} · {youtubeStatus(item)}</strong>:null}
    {item.status === "waiting_video" && item.error ? <p role="status">{persianError(item.error)}</p> : null}
    {!reviewMode?<><PreparationProgress item={item}/><DownloadProgress item={item}/></>:null}
    {!reviewMode && item.settings.collectionId ? <p className="media-preview-note">پس از تأیید، ویدئو از لینک منبع به یوتیوب منتقل می‌شود؛ ویدئو و کاورِ لینک‌شده روی سرور ذخیره نمی‌شوند.</p> : null}
    {actionResult ? <p role="status" className="collection-feedback success">{actionResult}</p> : null}
    <details className="youtube-media-preview"><summary>پیش‌نمایش ویدئو</summary><MediaPreview video mediaId={item.settings.videoMediaId} url={item.settings.videoUrl} /></details>
    {item.settings.imageGeneration && (item.settings.imageGeneration as {error?:string}).error ? <p role="status">{String((item.settings.imageGeneration as {error?:string}).error)}</p> : null}
    <MediaPreview mediaId={item.settings.collectionId && !item.settings.imageStep ? undefined : item.settings.coverMediaId} url={item.settings.coverUrl} />
    {item.status === "waiting_approval" ? <>
      <div className="review-copy">
      {editing?<><label className="review-field">عنوان<input autoFocus={reviewMode} maxLength={100} disabled={busy||disabled} value={title} onChange={event=>setTitle(event.target.value)}/></label><label className="review-field">توضیحات<textarea maxLength={5000} rows={8} disabled={busy||disabled} value={description} onChange={event=>setDescription(event.target.value)}/></label>{reviewMode?<button type="button" className="ghost-button review-edit" disabled={busy||disabled} onClick={()=>setEditing(false)}>پایان ویرایش</button>:null}</>:<><h2>{title}</h2><p className="review-body">{description||"بدون توضیحات"}</p><button type="button" className="ghost-button review-edit" disabled={busy||disabled} onClick={()=>setEditing(true)}>ویرایش متن</button></>}
      </div>
      <p className="review-content-meta">{item.settings.videoType === "shorts" ? "ویدئوی کوتاه / Shorts" : "ویدئوی معمولی"}{item.settings.playlist?` · پلی‌لیست: ${String(item.settings.playlist)}`:""}</p>
      <footer className={reviewMode?"review-decision-actions":"youtube-review-actions"}><button type="button" className="primary-button" disabled={busy||disabled||!!actionResult||!title.trim()} onClick={()=>void action("approve")}>{busy?"در حال ثبت…":item.scheduledAt?"تأیید انتشار زمان‌بندی‌شده":"تأیید و انتشار اکنون"}</button><button type="button" className={reviewMode?"review-reject":"ghost-button"} disabled={busy||disabled} onClick={()=>void action("reject")}>رد</button></footer>
    </> : <h2>{item.title}</h2>}
    {item.scheduledAt ? <p>زمان انتشار: {new Date(item.scheduledAt).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })}</p> : null}
    {item.status === "queued" ? <button type="button" disabled={busy||disabled} onClick={() => void action("cancel")}>توقف پیش از آپلود</button> : null}
    {item.status === "failed" ? <button type="button" className="primary-button" disabled={busy || disabled || !!actionResult} onClick={() => void action("retry")}>{busy || actionResult ? "در حال ثبت درخواست…" : item.videoId ? "تکمیل همین ویدئو" : item.settings.collectionId && !item.approvedAt ? "ادامه آماده‌سازی" : "تلاش مجدد"}</button> : null}
    {item.videoId ? <a href={`https://www.youtube.com/watch?v=${item.videoId}`} target="_blank" rel="noreferrer">مشاهده در یوتیوب</a> : null}
    {item.actualPrivacy ? <p>وضعیت واقعی در یوتیوب: {({ public: "عمومی", private: "خصوصی", unlisted: "فهرست‌نشده" })[item.actualPrivacy] ?? item.actualPrivacy}
      {item.actualPrivacy !== item.settings.privacy ? " — محدودیت انتشار: وضعیت درخواستی اعمال نشده است." : ""}</p> : null}
    {(!actionResult && item.status === "failed" && item.error) || error ? <div className="collection-feedback error" role="alert"><strong>{error ? "عملیات انجام نشد" : item.videoId || item.settings.publicationFailureStage ? youtubeFailureTitle(item.settings,Boolean(item.videoId)) : ({video_link:"بررسی لینک ویدئو ناموفق بود",cover_link:"ویدئو بررسی شد؛ لینک کاور مشکل دارد",cover_download:"ویدئو دریافت شد؛ دریافت کاور ناموفق بود",video_inspection:"ویدئو دریافت شد؛ بررسی فایل ناموفق بود",image_generation:"ویدئو دریافت شد؛ تولید تصویر ناموفق بود",video_download:"دریافت ویدئو ناموفق بود"} as Record<string,string>)[String(item.settings.preparationFailureStage)] ?? "عملیات یوتیوب ناموفق بود"}</strong><span>{persianError(error || item.error)}</span>{diagnosticErrorCode(error || item.error) ? <code dir="ltr">{diagnosticErrorCode(error || item.error)}</code> : null}</div> : null}
    {reviewMode?<details className="review-extra"><summary>جزئیات و گزارش‌ها</summary><p>{youtubeStatus(item)}</p><ConnectionHistory youtubeItemId={item.id}/>{item.runId?<a href={`/runs/${item.runId}`}>گزارش اجرای جریان ←</a>:null}</details>:<>
    <details><summary>مسیر اتصال</summary><ConnectionHistory youtubeItemId={item.id} /></details>
    <details><summary>گزارش اجرا</summary>{item.runId ? <a href={`/runs/${item.runId}`}>اجرای جریان {item.runId.slice(0,8)}</a> : <p>{item.settings.collectionId ? "ورود از مجموعه اکسل / گوگل‌شیت" : "بارگذاری دستی"}</p>}{item.logs.map((entry, i) => <p key={i}>{String(entry.channel ?? "یوتیوب")} · {new Date(String(entry.time)).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })} · {entry.result === "preparation_failed" ? preparationStageLabels[String(entry.stage)] ?? "آماده‌سازی ناموفق" : logLabels[String(entry.result)] ?? "تغییر وضعیت انتشار"}{entry.stage && entry.result!=="preparation_failed" ? ` · ${youtubePublicationStage({publicationStage:entry.stage})}` : ""}{entry.route ? ` · ${entry.route === "proxy" ? `پروکسی: ${entry.proxyName}` : "مستقیم"}` : ""}{entry.actualPrivacy ? ` · ${privacyLabels[String(entry.actualPrivacy)] ?? "نامشخص"}` : ""}{entry.error ? ` · ${persianError(entry.error)}` : ""}{typeof entry.code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(entry.code) ? <code dir="ltr"> · {entry.code}</code> : null}{entry.videoUrl ? <a href={String(entry.videoUrl)} target="_blank" rel="noreferrer"> لینک ویدئو</a> : null}</p>)}</details>
    </>}
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
    if (!file) return; setBusy(true); setMessage("");
    try {
      if (file.size > (cover ? YOUTUBE_COVER_MAX_BYTES : 250_000_000)) throw new Error(cover ? "حجم کاور نباید بیشتر از ۵۰ مگابایت باشد" : "ویدئو باید کمتر از ۲۵۰ مگابایت باشد");
      const response = await apiFetch("/youtube/media", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file });
      const data = await response.json(); if (!response.ok || data.kind !== (cover ? "image" : "video")) throw new Error(data.error ?? "نوع فایل معتبر نیست");
      if (cover) setCoverMediaId(data.mediaId); else setVideoMediaId(data.mediaId); setMessage("فایل دریافت شد؛ برای ارسال به صف تأیید دکمه را بزنید.");
    } catch (err) { setMessage(persianError(err, "خطای آپلود")); } finally { setBusy(false); if (coverInput.current) coverInput.current.value=""; if (videoInput.current) videoInput.current.value=""; }
  };
  const submit = async () => {
    if (!workflowId) { setMessage("ابتدا جریان را ذخیره کنید."); return; } setBusy(true);
    try {
      const waiting = items.find((item) => item.stepKey === stepKey && item.status === "waiting_video");
      const response = await apiFetch(waiting ? `/youtube/items/${waiting.id}/media` : "/youtube/items", { method: waiting ? "PATCH" : "POST", body: JSON.stringify({ workflowId, stepKey, accountId, videoMediaId,
        coverMediaId: coverMediaId || undefined, title: config.youtubeTitle || "ویدئوی جدید", description: config.youtubeDescription ?? "",
        videoType: config.videoType ?? "video", playlist: config.playlist ?? "", privacy: config.privacy ?? "private", tags: config.tags ?? [], madeForKids: config.madeForKids === true, scheduledAt: config.scheduledAt || null, connection: config.connection }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "ثبت آیتم ناموفق بود"); refresh(); setVideoMediaId(""); setCoverMediaId(""); setMessage("ویدئو منتظر تأیید انسانی است.");
    } catch (err) { setMessage(persianError(err, "خطا")); } finally { setBusy(false); }
  };
  return <section className="youtube-panel">
    <p><YoutubeIcon /> یوتیوب · تأیید انسانی اجباری</p>
    {privateOnly ? <p role="status">این پروژه برای انتشار عمومی تأیید نشده است؛ آپلودها به‌صورت خصوصی انجام می‌شوند.</p> : null}
    <label><span>نوع محتوا<FieldHelp>تشخیص Shorts با یوتیوب است؛ فایل باید مربع یا عمودی و حداکثر ۳ دقیقه باشد. فایل خودکار برش نمی‌خورد.</FieldHelp></span><select value={String(config.videoType ?? "video")} onChange={(e) => update("videoType",e.target.value)}><option value="video">ویدئوی معمولی</option><option value="shorts">ویدئوی کوتاه / Shorts</option></select></label>

    <details className="youtube-settings-group"><summary>تنظیمات پیش‌فرض محتوا<FieldHelp>برای مجموعهٔ شیت، اطلاعات هر ردیف در اولویت است؛ این تنظیمات برای فیلدهای خالی استفاده می‌شوند.</FieldHelp></summary><label>پلی‌لیست (نام یا شناسه)<input value={String(config.playlist ?? "")} onChange={(e) => update("playlist",e.target.value)} /></label>
    <label>عنوان<input maxLength={100} value={String(config.youtubeTitle ?? "")} onChange={(e) => update("youtubeTitle", e.target.value)} placeholder="عنوان از کارت قبلی" /></label>
    <label>توضیحات<textarea maxLength={5000} value={String(config.youtubeDescription ?? "")} onChange={(e) => update("youtubeDescription", e.target.value)} /></label>
    <label>برچسب‌ها (جداشده با ویرگول)<input value={Array.isArray(config.tags) ? config.tags.join(",") : ""} onChange={(e) => update("tags", e.target.value.split(",").map((v) => v.trim()).filter(Boolean))} /></label>
    <label><input type="checkbox" checked={config.madeForKids === true} onChange={(e) => update("madeForKids", e.target.checked)} /> محتوای مخصوص کودکان</label>
    <label>نوع انتشار<select value={String(config.privacy ?? "private")} onChange={(e) => update("privacy", e.target.value)}>
      <option value="private">خصوصی</option><option value="public" disabled={privateOnly}>عمومی</option><option value="unlisted" disabled={privateOnly}>فهرست‌نشده</option></select></label>
    <div>زمان انتشار<PersianDateTimeField value={config.scheduledAt} onChange={(value) => update("scheduledAt", value)} /></div>
    </details>
    <details className="youtube-settings-group"><summary>افزودن ویدئو به‌صورت دستی</summary><label>آدرس امن ویدئو از کارت قبلی<input dir="ltr" value={String(config.videoUrl ?? "")} onChange={(e) => update("videoUrl", e.target.value)} /></label>
    <label>آدرس کاور<input dir="ltr" value={String(config.coverUrl ?? "")} onChange={(e) => update("coverUrl", e.target.value)} /></label>
    <input ref={videoInput} className="sr-only" aria-label="انتخاب فایل ویدئو" type="file" accept="video/mp4,video/webm" disabled={busy} onChange={(e) => void upload(e.target.files?.[0], false)} />
    <button type="button" disabled={busy} onClick={() => videoInput.current?.click()}>انتخاب فایل ویدئو</button>
    <input ref={coverInput} className="sr-only" aria-label="انتخاب فایل کاور" type="file" accept="image/jpeg,image/png" disabled={busy} onChange={(e) => void upload(e.target.files?.[0], true)} />
    <button type="button" disabled={busy} onClick={() => coverInput.current?.click()}>انتخاب تصویر کاور</button>
    <MediaPreview video mediaId={videoMediaId || undefined} /><MediaPreview mediaId={coverMediaId || undefined} />
    <button type="button" disabled={busy || !videoMediaId} onClick={() => void submit()}>ارسال ویدئو به صف تأیید</button><p role="status">{message}</p>
    </details>
    <section className="youtube-output-list"><h3>ویدئوهای این کارت · {faDigits(items.filter(item=>item.stepKey===stepKey).length)}</h3>
    {!items.some(item=>item.stepKey===stepKey) ? <p>هنوز ویدئویی ثبت نشده است. محتوا را از کارت مجموعه وارد کن یا ویدئو را دستی اضافه کن.</p> : null}
    {items.filter((item) => item.stepKey === stepKey).map((item) => <details key={item.id} className={`youtube-output ${item.status === "failed" ? "has-error" : ""}`}><summary><strong>{item.title}</strong><span>{youtubeStatus(item)}</span></summary><YoutubeReview item={item} refresh={refresh} /></details>)}
    </section>
  </section>;
}
export function YoutubeApprovalQueue() {
  const [items, setItems] = useState<YoutubeItem[]>([]);
  const refresh = () => { void apiFetch("/youtube/items").then((r) => r.ok ? r.json() : []).then(setItems); };
  useEffect(() => { refresh(); const timer = setInterval(refresh, 5000); return () => clearInterval(timer); }, []);
  return <section className="workflow-approval-section"><h2>تأیید و انتشار یوتیوب</h2>{items.filter((item) => ["waiting_approval", "queued", "uploading", "processing", "failed"].includes(item.status)).map((item) => <YoutubeReview key={item.id} item={item} refresh={refresh} />)}</section>;
}
