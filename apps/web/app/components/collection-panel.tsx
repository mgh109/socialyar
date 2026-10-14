"use client";
import { FieldHelp } from "./field-help";
import Link from "next/link";
import { InstagramFields } from "./instagram-fields";
import { useEffect, useState } from "react";
import { collectionColumns, collectionRowsSchema, validateCollectionDestination, type CollectionRow, type CollectionChange, type CollectionRecord, type CalendarItem } from "@socialyar/shared";
import { apiFetch } from "../lib/session";
import { faDigits, weekNames } from "../lib/persian-calendar";
import { inferMapping, readCollectionSheet, mapCollectionRows, scheduleCollectionRows, downloadCollectionTemplate, type SheetData, type ColumnMapping } from "../lib/collection-sheet";
import { PersianDateTimeField } from "./persian-date-time-field";
import { ConnectionSelector } from "./connection-selector";
import { YoutubeReview, youtubeStatus, type YoutubeItem } from "./youtube-panel";
import { calendarLabels, networkLabels } from "./calendar-detail";
import { persianError } from "../lib/persian";
const labels = { added: "جدید", changed: "ویرایش‌شده", removed: "حذف از برنامه", unchanged: "بدون تغییر" };
export function CollectionPanel({ workflowId, stepKey, targets, config, update, refresh, items, calendarOutputs }: {
  calendarOutputs?:CalendarItem[];items: YoutubeItem[]; workflowId?: string | null; stepKey: string; targets: Array<{ key: string; name: string; config: Record<string,unknown> }>;
  config: Record<string,unknown>; update: (key: string, value: unknown) => void; refresh: () => void;
}) {
  const [sheet,setSheet] = useState<SheetData | null>(null); const [mapping,setMapping] = useState<ColumnMapping>((config.sheetMapping as ColumnMapping) ?? {});
  const [rows,setRows] = useState<CollectionRow[]>([]); const [errors,setErrors] = useState<string[]>([]);
  const [reading,setReading] = useState(false);
  const [readError,setReadError] = useState(""); const [loadError,setLoadError] = useState("");
  const [preview,setPreview] = useState<{ revision: number; changes: CollectionChange[] } | null>(null);
  const [selected,setSelected] = useState<string[]>([]); const [busy,setBusy] = useState(false); const [message,setMessage] = useState("");
  const [saved,setSaved] = useState<Array<{ targetStepKey: string; records: CollectionRecord[]; updatedAt: string }>>([]);
  const [privateOnly,setPrivateOnly] = useState(true); const [reviewId,setReviewId] = useState(""); const [approvalIds,setApprovalIds] = useState<string[]>([]); const [visible,setVisible] = useState(20);
  const [start,setStart] = useState(""); const [interval,setIntervalDays] = useState(1); const [weekdays,setWeekdays] = useState([0,1,2,3,4,5,6]);
  const [calendarItems,setCalendarItems] = useState<CalendarItem[]>([]);
  const [snapshot,setSnapshot] = useState<{ data:SheetData|null;error:string|null;checkedAt:string;sourceUrl:string;sheetGid:string }|null>(null);
  const targetKey = targets.some((target) => target.key === config.collectionTargetKey)
    ? String(config.collectionTargetKey) : targets[0]?.key ?? ""; const target = targets.find((t) => t.key === targetKey);
  const isYoutube = items.some((i)=>i.stepKey===targetKey) || target?.config.collectionChannel === "youtube";
  const load = async () => {
    if (!workflowId) return;
    try { const r = await apiFetch(`/content-collections?workflowId=${workflowId}&sourceStepKey=${encodeURIComponent(stepKey)}`); if (!r.ok) throw new Error("دریافت مجموعه ناموفق بود."); setSaved(await r.json()); setLoadError("");
      const response=await apiFetch("/calendar/items");if(response.ok)setCalendarItems(await response.json()); }
    catch (e) { setLoadError(persianError(e,"دریافت وضعیت مجموعه ناموفق بود.")); }
  };
  useEffect(() => { void load(); }, [workflowId,stepKey]);
  useEffect(() => { void apiFetch("/youtube/config").then((r) => r.ok ? r.json() : null).then((data) => { if (data) setPrivateOnly(data.privateOnly); }).catch(()=>{}); },[]);
  useEffect(()=>{
    if(!workflowId || config.collectionSource!=="google_sheet")return;
    let live=true;
    const poll=async()=>{try{const r=await apiFetch(`/content-collections/google-sheet/snapshot?workflowId=${workflowId}&sourceStepKey=${encodeURIComponent(stepKey)}`);if(r.ok && live)setSnapshot(await r.json());}catch{/* Next refresh can recover. */}};
    void poll();const timer=setInterval(()=>void poll(),30000);return()=>{live=false;clearInterval(timer);};
  },[workflowId,stepKey,config.collectionSource]);
  const readGoogleSheet = async()=>{
    if(!workflowId){setMessage("ابتدا جریان را ذخیره کنید؛ برای خواندن شیت نیازی به مقصد انتشار نیست.");return;}
    setBusy(true);setReading(true);setPreview(null);setRows([]);setErrors([]);setReadError("");setMessage("");
    try{const r=await apiFetch("/content-collections/google-sheet",{method:"POST",body:JSON.stringify({workflowId,sourceStepKey:stepKey,targetStepKey:targetKey,url:config.sheetUrl,gid:String(config.sheetGid??"0")})});const data=await r.json();if(!r.ok)throw new Error(data.error);setSheet(data);setMapping((config.sheetMapping as ColumnMapping) ?? inferMapping(data.headers));setMessage("برگه خوانده شد؛ پیش‌نمایش را بسازید و تغییرات را بررسی کنید.");}
    catch(e){setSheet(null);setReadError(persianError(e,"خواندن گوگل‌شیت ناموفق بود."));}finally{setBusy(false);setReading(false);}
  };
  const current = saved.find((c) => c.targetStepKey === targetKey);
  const itemMap = new Map(items.map((i) => [i.id,i]));
  const outputs = (current?.records ?? []).filter((r) => r.active).sort((a,b) => a.row.order-b.row.order).map((r) => itemMap.get(r.itemId)).filter((i): i is YoutubeItem => Boolean(i));
  const genericOutputs=(calendarOutputs??calendarItems).filter((i)=>i.kind==="variant" && i.settings.collectionId && i.settings.collectionSourceKey===stepKey && i.stepKey===targetKey && i.workflowId===workflowId);
  const ready = outputs.filter((i) => i.status === "waiting_approval" && approvalIds.includes(i.id));
  const approveSelected = async () => {
    if (!ready.length || !window.confirm(`${faDigits(ready.length)} ویدئوی انتخاب‌شده برای انتشار طبق برنامه تأیید شوند؟`)) return;
    setBusy(true); let count=0; const failures:string[]=[];
    for (const item of ready) {
      try { const r=await apiFetch(`/youtube/items/${item.id}/resolve`,{ method:"POST",body:JSON.stringify({ action:"approve" }) }); const data=await r.json(); if (!r.ok) throw new Error(data.error ?? "تأیید ناموفق بود."); count++; }
      catch(e){failures.push(`${item.title}: ${persianError(e,"خطا")}`);}
    }
    setApprovalIds([]);setMessage(`${faDigits(count)} ویدئو تأیید شد.${failures.length ? ` ${failures.join("؛ ")}` : ""}`);refresh();setBusy(false);
  };
  const read = async (file?: File) => {
    if (!file) return; setBusy(true); setReading(true); setPreview(null); setRows([]); setErrors([]); setMessage(""); setReadError("");
    try { const data = await readCollectionSheet(file); setSheet(data); setMapping((config.sheetMapping as ColumnMapping) ?? inferMapping(data.headers)); setMessage("فایل اکسل خوانده شد؛ ستون‌ها را بررسی کن."); }
    catch (e) { setSheet(null); setReadError(persianError(e,"خواندن اکسل ناموفق بود.")); } finally { setBusy(false); setReading(false); }
  };
  const prepare = () => {
    if (!sheet) return;
    try {
      const result=mapCollectionRows(sheet,mapping,{privacy:target?.config.privacy as CollectionRow["privacy"] ?? "private",videoType:target?.config.videoType as CollectionRow["videoType"] ?? "video",playlist:String(target?.config.playlist??""),tags:Array.isArray(target?.config.tags)?target.config.tags as string[]:[],madeForKids:target?.config.madeForKids===true});
      const valid:CollectionRow[]=[];const issues=[...result.errors];
      for(const row of result.rows){
        try{if(row.scheduledAt && Date.parse(row.scheduledAt)<=Date.now())throw new Error("زمان انتشار گذشته است؛ تاریخ را اصلاح کنید.");if (target) validateCollectionDestination([row],String(target.config.collectionChannel));valid.push(row);}
        catch(e){issues.push(`شناسه ${row.id}: ${persianError(e,"اطلاعات مقصد معتبر نیست.")}`);}
      }
      setRows(valid);setErrors(issues);setPreview(null);setMessage("پیش‌نمایش محتوا را بررسی و سپس تغییرات را مقایسه کنید.");
    }
    catch (e) { setMessage(persianError(e,"خطا")); }
  };
  const change = (id: string, patch: Partial<CollectionRow>) => { setRows((r) => r.map((row) => row.id === id ? { ...row,...patch } : row)); setPreview(null); };
  const compare = async () => {
    if (!workflowId || !target) { setMessage("کارت مجموعه را به کارت انتشار وصل و جریان را ذخیره کنید."); return; }
    setBusy(true); setMessage("");
    try {
      const validated = collectionRowsSchema.parse(rows);
      const r = await apiFetch("/content-collections/preview", { method: "POST", body: JSON.stringify({ workflowId, sourceStepKey: stepKey, targetStepKey: targetKey, rows: validated, detectRemovals: errors.length === 0 }) });
      const data = await r.json(); if (!r.ok) throw new Error(data.error ?? "مقایسه ناموفق بود.");
      setPreview(data); setSelected(data.changes.filter((c: CollectionChange) => ["added","changed"].includes(c.kind) && !c.blocked).map((c: CollectionChange) => c.id));
    } catch (e) { setMessage(persianError(e,"اطلاعات ردیف‌ها معتبر نیست.")); } finally { setBusy(false); }
  };
  const apply = async () => {
    if (!preview) return; setBusy(true);
    try {
      const r = await apiFetch("/content-collections/apply", { method: "POST", body: JSON.stringify({ workflowId, sourceStepKey: stepKey, targetStepKey: targetKey,
        rows, detectRemovals: errors.length === 0, revision: preview.revision, selected: preview.changes.filter((c) => selected.includes(c.id)).map(({ id,version,updatedAt }) => ({ id,version,updatedAt })) }) });
      const data = await r.json(); if (!r.ok) throw new Error(data.error ?? "ثبت ناموفق بود.");
      setPreview(null); setSelected([]); setMessage(`${faDigits(data.applied.length)} تغییر ثبت شد. ${isYoutube ? "فایل‌های جدید دریافت می‌شوند؛" : "خروجی‌ها در تقویم آماده‌اند؛"} انتشار نیازمند تأیید انسانی است.${data.queueFailures ? " برخی فایل‌ها وارد صف نشدند؛ دریافت مجدد را بزنید." : ""}`); await load(); refresh();
    } catch (e) { setMessage(persianError(e,"خطا")); setPreview(null); } finally { setBusy(false); }
  };
  const updatePublished = async (change:CollectionChange) => {
    if (!preview || !window.confirm(`اطلاعات «${change.row.title}» در همان ویدئوی منتشرشده یوتیوب به‌روزرسانی شود؟`)) return;
    setBusy(true);
    try {
      const r=await apiFetch("/content-collections/update-published",{ method:"POST",body:JSON.stringify({ workflowId,sourceStepKey:stepKey,targetStepKey:targetKey,row:change.row,revision:preview.revision,version:change.version,updatedAt:change.updatedAt }) });
      const data=await r.json();if (!r.ok) throw new Error(data.error ?? "به‌روزرسانی ناموفق بود.");setMessage("اطلاعات همان ویدئوی یوتیوب به‌روزرسانی شد؛ آپلود مجدد انجام نشد.");setPreview(null);await load();refresh();
    } catch(e) { setMessage(persianError(e,"خطا")); } finally { setBusy(false); }
  };
  return <section className="collection-panel" aria-label="ورود و به‌روزرسانی مجموعه محتوا" aria-busy={busy}>
    <fieldset disabled={busy} className="collection-fields"><legend className="sr-only">تنظیمات مجموعه محتوا</legend>
    <ol className="collection-steps" aria-label="مراحل ورود مجموعه">
      {["خواندن منبع", "بررسی محتوا", "ثبت برای مقصد"].map((label,index)=><li key={label} aria-current={(preview ? 2 : sheet ? 1 : 0)===index ? "step" : undefined} className={(preview ? 2 : sheet ? 1 : 0)>index ? "done" : ""}><b>{faDigits(index+1)}</b><span>{label}</span></li>)}
    </ol>
    <section className="collection-stage"><header><h3>۱. خواندن منبع<FieldHelp>هر ردیف یک محتوا با شناسه ثابت است. برای هر مقصد، تغییرات را جداگانه مقایسه و ثبت کن.</FieldHelp></h3></header>
    <label>نوع منبع<select value={String(config.collectionSource??"excel")} onChange={(e)=>{update("collectionSource",e.target.value);setSheet(null);setRows([]);setPreview(null);setErrors([]);setReadError("");setMessage("");}}><option value="excel">فایل اکسل</option><option value="google_sheet">گوگل‌شیت</option></select></label>
    {config.collectionSource==="google_sheet" ? <div className="collection-fields">
      <label><span>لینک گوگل‌شیت<FieldHelp>شیت باید با لینک قابل خواندن باشد؛ اتصال حساب برای شیت خصوصی هنوز فعال نیست. لینک فایل ویدئو یا تصویر می‌تواند روی هر هاست عمومی HTTPS باشد.</FieldHelp></span><input type="url" dir="ltr" value={String(config.sheetUrl??"")} onChange={(e)=>{update("sheetUrl",e.target.value);
        try { const url = new URL(e.target.value); const gid = url.searchParams.get("gid") ?? new URLSearchParams(url.hash.slice(1)).get("gid"); if (gid && /^\d{1,15}$/.test(gid)) update("sheetGid",gid); } catch { /* Wait for a complete URL. */ }
        setPreview(null);setSheet(null);setRows([]);}} /></label>
      <details><summary>انتخاب برگه و بررسی خودکار</summary><label>شناسه برگه (gid)<input dir="ltr" inputMode="numeric" value={String(config.sheetGid??"0")} onChange={(e)=>{update("sheetGid",e.target.value);setPreview(null);setSheet(null);setRows([]);}} /></label>


      <label><input type="checkbox" checked={config.sheetAutoRefresh===true} onChange={(e)=>update("sheetAutoRefresh",e.target.checked)} />بررسی دوره‌ای روی سرور؛ تغییرات با تأیید من اعمال شوند</label>
      <label><span>فاصله بررسی (دقیقه)<FieldHelp>پس از ذخیره و فعال‌کردن جریان، بررسی با بسته‌بودن مرورگر ادامه دارد.</FieldHelp></span><input type="number" min={5} max={1440} value={Number(config.sheetRefreshMinutes??5)} onChange={(e)=>update("sheetRefreshMinutes",Number(e.target.value))} /></label>

      </details>
      <button type="button" className="primary-button" disabled={busy || !workflowId || !String(config.sheetUrl ?? "").trim()} onClick={()=>void readGoogleSheet()}>{reading ? "در حال خواندن…" : sheet ? "خواندن دوباره شیت" : "خواندن شیت"}</button>
      {snapshot && snapshot.sourceUrl===config.sheetUrl && snapshot.sheetGid===String(config.sheetGid??"0") ? <div><p>آخرین بررسی سرور: {new Date(snapshot.checkedAt).toLocaleString("fa-IR",{timeZone:"Asia/Tehran"})}</p>{snapshot.error ? <p role="alert">{snapshot.error}</p> : snapshot.data ? <button type="button" onClick={()=>{setSheet(snapshot.data);setMapping((config.sheetMapping as ColumnMapping)??inferMapping(snapshot.data!.headers));setRows([]);setPreview(null);setErrors([]);}}>بررسی نسخه دریافت‌شده توسط سرور</button> : null}</div> : null}
    </div> : null}
    <div className="collection-actions"><button type="button" className="ghost-button" disabled={busy} onClick={() => { setBusy(true); void downloadCollectionTemplate().catch((e) => setMessage(persianError(e,"دانلود نمونه ناموفق بود."))).finally(() => setBusy(false)); }}>دانلود اکسل نمونه</button>
      {config.collectionSource!=="google_sheet" ? <label className="collection-file">انتخاب اکسل جدید یا نسخه به‌روزشده<input type="file" accept=".xlsx" disabled={busy} onChange={(e) => { void read(e.target.files?.[0]); e.target.value = ""; }} /></label> : null}</div>
    {reading && config.collectionSource!=="google_sheet" ? <p role="status">در حال خواندن فایل اکسل…</p> : null}
    {readError ? <p className="collection-feedback error" role="alert">{readError}</p> : null}
    {sheet ? <div className="collection-feedback success" role="status"><strong>منبع خوانده شد</strong><span>{faDigits(sheet.rows.length)} ردیف · {faDigits(sheet.headers.length)} ستون</span><small>هنوز چیزی برای انتشار ثبت نشده است.</small></div> : null}
    {!workflowId && config.collectionSource==="google_sheet" ? <p role="status">ابتدا دکمهٔ ذخیرهٔ جریان را بزن تا خواندن شیت فعال شود.</p> : null}
    </section>
    {isYoutube && privateOnly ? <p role="status">پروژه یوتیوب هنوز برای انتشار عمومی تأیید نشده است؛ خروجی‌ها به‌صورت خصوصی آپلود می‌شوند.</p> : null}
    {sheet ? <section className="collection-stage"><header><h3>۲. بررسی محتوا</h3><span>ستون شناسه و عنوان را مشخص کن.</span></header><details open><summary>تطبیق ستون‌ها</summary><div className="collection-mapping">{collectionColumns.filter(([key]) => ["id","title","videoUrl","description","date","time"].includes(key)).map(([key,label]) => <label key={key}>{label}{["id","title"].includes(key) ? " *" : ""}<select disabled={busy} value={mapping[key] ?? -1} onChange={(e) => { const next={...mapping,[key]:Number(e.target.value)}; setMapping(next); update("sheetMapping",next); setPreview(null); setRows([]); }}>
      <option value={-1}>بدون ستون / مقدار پیش‌فرض</option>{sheet.headers.map((h,i) => <option key={i} value={i}>{h || `ستون ${faDigits(i+1)}`}</option>)}</select></label>)}</div>
      <details><summary>ستون‌های بیشتر؛ کاور، شبکه‌ها و تنظیمات ویدئو</summary><div className="collection-mapping">{collectionColumns.filter(([key])=>!["id","title","videoUrl","description","date","time"].includes(key)).map(([key,label])=><label key={key}>{label}<select value={mapping[key] ?? -1} onChange={e=>{const next={...mapping,[key]:Number(e.target.value)};setMapping(next);update("sheetMapping",next);setPreview(null);setRows([]);}}><option value={-1}>بدون ستون / پیش‌فرض</option>{sheet.headers.map((header,index)=><option key={index} value={index}>{header || `ستون ${faDigits(index+1)}`}</option>)}</select></label>)}</div></details>
      </details><button type="button" className="primary-button" disabled={busy || (mapping.id ?? -1)<0 || (mapping.title ?? -1)<0} onClick={()=>{update("sheetMapping",mapping);prepare();}}>نمایش محتوا</button></section> : null}
    {errors.length ? <div role="alert"><strong>{faDigits(errors.length)} ردیف نیازمند اصلاح است؛ ردیف‌های سالم قابل ورودند.</strong>{errors.map((e,i) => <p key={i}>{e}</p>)}<p>برای جلوگیری از حذف اشتباه، در این نوبت ردیف‌های غایب حذف نمی‌شوند.</p></div> : null}
    {rows.length ? <><details><summary>زمان‌بندی ردیف‌های بدون تاریخ</summary><PersianDateTimeField value={start} onChange={setStart} />
      <label>فاصله انتشار (روز)<input type="number" min={1} max={365} value={interval} onChange={(e) => setIntervalDays(Number(e.target.value))} /></label>
      <fieldset><legend>روزهای مجاز انتشار</legend>{weekNames.map((name,i) => <label key={name}><input type="checkbox" checked={weekdays.includes(i)} onChange={(e) => setWeekdays((days) => e.target.checked ? [...days,i] : days.filter((d) => d!==i))} />{name}</label>)}</fieldset>
      <button type="button" disabled={busy} onClick={() => { try { setRows(scheduleCollectionRows(rows,start,interval,weekdays)); setPreview(null); } catch (e) { setMessage(persianError(e,"خطا")); } }}>اعمال برنامه پیشنهادی</button></details>
      <div className="collection-feedback success" role="status"><strong>{faDigits(rows.length)} محتوا آماده بررسی است</strong><span>برای ویرایش، روی عنوان هر محتوا بزن.</span></div><div className="collection-rows">{rows.map((row) => <details key={row.id}><summary>{faDigits(row.order)} · {row.title} · {row.videoUrl ? row.videoType === "shorts" ? "ویدئوی کوتاه" : "ویدئو" : row.coverUrl ? "تصویر" : "متن"}<small>{row.scheduledAt ? new Date(row.scheduledAt).toLocaleString("fa-IR",{ timeZone:"Asia/Tehran" }) : "بدون زمان‌بندی"}</small></summary>
        <label>شناسه ثابت<input value={row.id} readOnly dir="ltr" /></label><label>ترتیب قسمت<input type="number" min={1} value={row.order} onChange={(e) => change(row.id,{ order:Number(e.target.value) })} /></label>
        <label>عنوان<input maxLength={100} value={row.title} onChange={(e) => change(row.id,{ title:e.target.value })} /></label>
        <label>توضیحات<textarea maxLength={5000} value={row.description} onChange={(e) => change(row.id,{ description:e.target.value })} /></label>
        <details><summary>متن اختصاصی شبکه‌ها (اختیاری)</summary>{(["youtubeDescription","instagramCaption","telegramText","eitaaText","baleText"] as const).map((key)=><label key={key}>{collectionColumns.find(([field])=>field===key)?.[1]}<textarea value={row[key]??""} onChange={(e)=>change(row.id,{[key]:e.target.value})} /></label>)}<small>فیلد خالی از توضیحات مشترک استفاده می‌کند.</small></details>
        {String(target?.config.collectionChannel) !== "instagram" ? <label>لینک ویدئو<input dir="ltr" value={row.videoUrl} onChange={(e) => change(row.id,{ videoUrl:e.target.value })} /></label> : null}
        {String(target?.config.collectionChannel) === "instagram" ? <InstagramFields settings={{instagramType:row.instagramType,instagramImages:row.instagramImages,imageUrl:row.coverUrl,videoUrl:row.videoUrl}} caption={row.instagramCaption || row.description} setCaption={(value)=>change(row.id,{instagramCaption:value})} setSetting={(key,value)=>change(row.id,{[key === "imageUrl" ? "coverUrl" : key]:value ?? ""})} /> : null}
        {String(target?.config.collectionChannel) !== "instagram" ? <label>لینک تصویر / کاور<input dir="ltr" value={row.coverUrl} onChange={(e) => change(row.id,{ coverUrl:e.target.value })} /></label> : null}
        {isYoutube ? <><label>نوع محتوا<select value={row.videoType} onChange={(e) => change(row.id,{ videoType:e.target.value as CollectionRow["videoType"] })}><option value="video">ویدئوی معمولی</option><option value="shorts">ویدئوی کوتاه / Shorts</option></select></label>
        <label>پلی‌لیست<input value={row.playlist} onChange={(e) => change(row.id,{ playlist:e.target.value })} /></label>
        <label>برچسب‌ها<input value={row.tags.join("، ")} onChange={(e) => change(row.id,{ tags:e.target.value.split(/[,،]/).map((t) => t.trim()).filter(Boolean) })} /></label>
        <label>وضعیت نمایش<select value={row.privacy} onChange={(e) => change(row.id,{ privacy:e.target.value as CollectionRow["privacy"] })}><option value="private">خصوصی</option><option value="public">عمومی</option><option value="unlisted">فهرست‌نشده</option></select></label>
        <label><input type="checkbox" checked={row.madeForKids} onChange={(e) => change(row.id,{ madeForKids:e.target.checked })} />مخصوص کودکان</label></> : target?.config.collectionChannel==="instagram" ? <p>ویدئو به‌صورت Reels و تصویر به‌صورت پست ارسال می‌شود؛ فایل خودکار برش نمی‌خورد.</p> : null}
        <PersianDateTimeField value={row.scheduledAt} onChange={(v) => change(row.id,{ scheduledAt:v || null })} />
      </details>)}</div></> : null}
    {rows.length > 0 || sheet?.rows.length === 0 || current ? <section className="collection-stage"><header><h3>۳. ثبت برای مقصد</h3><span>پس از ثبت، فایل‌ها آماده و برای تأیید نمایش داده می‌شوند.</span></header>
    <p><Link href="/calendar">مدیریت در تقویم انتشار</Link></p>
    {!workflowId ? <p className="collection-feedback" role="status">برای خواندن گوگل‌شیت، ابتدا جریان را ذخیره کن. اکسل را می‌توان همین حالا انتخاب کرد.</p> : null}
    {!targets.length ? <p role="alert">برای ثبت و انتشار، این کارت را مستقیم یا از طریق کارت تولید تصویر به مقصد فعال وصل کن؛ خواندن اکسل و پیش‌نمایش به مقصد نیاز ندارد.</p> : <label><span>کارت مقصد<FieldHelp>لینک فایل روی کوبیت، هاست شخصی یا سرویس ذخیره‌سازی باید HTTPS و قابل دانلود توسط سرور باشد. مسیر دریافت فایل مستقل از اتصال مقصد است؛ پس از ذخیره جریان و ساخت پیش‌نمایش، اتصال اولین فایل را تست کنید.</FieldHelp></span><select value={targetKey} disabled={busy} onChange={(e) => { update("collectionTargetKey",e.target.value); setPreview(null); }}>
      {targets.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}</select></label>}
    {current ? <p>مجموعه ثبت‌شده: {faDigits(current.records.filter((r) => r.active).length)} محتوا · آخرین تغییر: {new Date(current.updatedAt).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })}</p> : null}
    <details><summary>تنظیمات دریافت فایل و تست اتصال</summary><ConnectionSelector target="media" testRequest={workflowId && target && rows[0]?.videoUrl ? { path:"/content-collections/test-media",body:{ workflowId,sourceStepKey:stepKey,targetStepKey:targetKey,videoUrl:rows[0].videoUrl } } : undefined} value={config.mediaConnection} onChange={(value) => update("mediaConnection",value)} /></details>

    {sheet && (rows.length > 0 || sheet.rows.length === 0) ? <button type="button" disabled={busy || !target} onClick={() => void compare()}>بررسی تغییرات پیش از ثبت</button> : null}
    {preview ? <section className="collection-diff"><h4>تغییرات پیش از ثبت</h4><p>{Object.entries(labels).map(([kind,label]) => `${label}: ${faDigits(preview.changes.filter((c) => c.kind===kind).length)}`).join(" · ")}</p>
      {preview.changes.filter((c) => c.kind!=="unchanged").map((c) => <details key={c.id}><summary><label><input type="checkbox" disabled={busy || Boolean(c.blocked)} checked={selected.includes(c.id)} onClick={(e) => e.stopPropagation()} onChange={(e) => setSelected((ids) => e.target.checked ? [...ids,c.id] : ids.filter((id) => id!==c.id))} />{labels[c.kind]} · {c.row.title}</label></summary>
        {c.blocked ? <p role="alert">{c.blocked}</p> : null}{c.remoteEligible ? <button type="button" disabled={busy} onClick={() => void updatePublished(c)}>به‌روزرسانی اطلاعات در یوتیوب، بدون آپلود مجدد</button> : null}{c.status === "published" && c.fields.includes("videoUrl") ? <p>برای انتشار نسخه جدید فایل، ردیفی با شناسه محتوای جدید اضافه کنید.</p> : null}{c.kind === "removed" ? <p>فقط برنامه انتشار متوقف می‌شود؛ محتوای منتشرشده در مقصد حذف نخواهد شد.</p> : null}
        {c.fields.map((key) => <p key={key}><b>{collectionColumns.find(([field]) => field===key)?.[1] ?? (key==="scheduledAt" ? "زمان انتشار" : key)}</b>: {String(c.before?.[key as keyof CollectionRow] ?? "—")} ← {String(c.row[key as keyof CollectionRow] ?? "—")}</p>)}
      </details>)}<button type="button" disabled={busy || !selected.length} onClick={() => void apply()}>تأیید و ثبت {faDigits(selected.length)} تغییر انتخاب‌شده</button><p>ثبت مجموعه مجوز انتشار نیست؛ هر مقصد پیش از ارسال نیازمند تأیید انسانی است.</p></section> : null}
    </section> : null}
    {loadError ? <p role="status" className="collection-feedback error">{loadError} <button type="button" className="ghost-button" onClick={()=>void load()}>تازه‌سازی وضعیت</button></p> : null}
    {genericOutputs.length ? <section className="collection-outputs"><h4>خروجی‌های این مقصد · {faDigits(genericOutputs.length)} محتوا</h4>{genericOutputs.slice(0,visible).map((item)=><p key={item.id}>{item.title} · {networkLabels[item.channel]} · {calendarLabels[item.status]}{item.error ? ` · ${item.error}` : ""}</p>)}<Link href="/calendar">پیش‌نمایش، ویرایش، تأیید و زمان‌بندی در تقویم انتشار</Link></section> : null}
    {outputs.length ? <section className="collection-outputs"><h4>خروجی‌های مجموعه · {faDigits(outputs.length)} ویدئو</h4>
      <button type="button" onClick={() => setApprovalIds(outputs.filter((i) => i.status === "waiting_approval").map((i) => i.id))}>انتخاب همه ویدئوهای آماده تأیید</button>
      {outputs.slice(0,visible).map((item) => <details key={item.id} open={reviewId===item.id} onToggle={(e) => { if (e.currentTarget.open) setReviewId(item.id); else if(reviewId===item.id) setReviewId(""); }}><summary>{item.title} · {youtubeStatus(item)}</summary>
        {item.status === "waiting_approval" ? <label><input type="checkbox" checked={approvalIds.includes(item.id)} onChange={(e) => setApprovalIds((ids) => e.target.checked ? [...ids,item.id] : ids.filter((id) => id!==item.id))} />انتخاب برای تأیید انتشار</label> : null}
        {reviewId===item.id ? <YoutubeReview item={item} refresh={refresh} /> : null}
      </details>)}{outputs.length>visible ? <button type="button" onClick={() => setVisible((v) => v+20)}>نمایش ۲۰ مورد بعدی</button> : null}
      <button type="button" disabled={!ready.length} onClick={() => void approveSelected()}>تأیید انتشار {faDigits(ready.length)} ویدئوی انتخاب‌شده</button>
    </section> : null}
    </fieldset>{message ? <p className="collection-feedback" role="status">{message}</p> : null}
  </section>;
}
