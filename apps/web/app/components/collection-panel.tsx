"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { collectionColumns, collectionRowsSchema, type CollectionRow, type CollectionChange, type CollectionRecord } from "@socialyar/shared";
import { apiFetch } from "../lib/session";
import { faDigits, weekNames } from "../lib/persian-calendar";
import { inferMapping, readCollectionSheet, mapCollectionRows, scheduleCollectionRows, downloadCollectionTemplate, type SheetData, type ColumnMapping } from "../lib/collection-sheet";
import { PersianDateTimeField } from "./persian-date-time-field";
import { ConnectionSelector } from "./connection-selector";
import { YoutubeReview, youtubeStatus, type YoutubeItem } from "./youtube-panel";
import { persianError } from "../lib/persian";
const labels = { added: "جدید", changed: "ویرایش‌شده", removed: "حذف از برنامه", unchanged: "بدون تغییر" };
export function CollectionPanel({ workflowId, stepKey, targets, config, update, refresh, items }: {
  items: YoutubeItem[]; workflowId?: string | null; stepKey: string; targets: Array<{ key: string; name: string; config: Record<string,unknown> }>;
  config: Record<string,unknown>; update: (key: string, value: unknown) => void; refresh: () => void;
}) {
  const [sheet,setSheet] = useState<SheetData | null>(null); const [mapping,setMapping] = useState<ColumnMapping>({});
  const [rows,setRows] = useState<CollectionRow[]>([]); const [errors,setErrors] = useState<string[]>([]);
  const [preview,setPreview] = useState<{ revision: number; changes: CollectionChange[] } | null>(null);
  const [selected,setSelected] = useState<string[]>([]); const [busy,setBusy] = useState(false); const [message,setMessage] = useState("");
  const [saved,setSaved] = useState<Array<{ targetStepKey: string; records: CollectionRecord[]; updatedAt: string }>>([]);
  const [privateOnly,setPrivateOnly] = useState(true); const [reviewId,setReviewId] = useState(""); const [approvalIds,setApprovalIds] = useState<string[]>([]); const [visible,setVisible] = useState(20);
  const [start,setStart] = useState(""); const [interval,setIntervalDays] = useState(1); const [weekdays,setWeekdays] = useState([0,1,2,3,4,5,6]);
  const targetKey = String(config.collectionTargetKey ?? targets[0]?.key ?? ""); const target = targets.find((t) => t.key === targetKey);
  const load = async () => {
    if (!workflowId) return;
    try { const r = await apiFetch(`/content-collections?workflowId=${workflowId}&sourceStepKey=${encodeURIComponent(stepKey)}`); if (!r.ok) throw new Error("دریافت مجموعه ناموفق بود."); setSaved(await r.json()); }
    catch (e) { setMessage(persianError(e,"خطا")); }
  };
  useEffect(() => { void load(); }, [workflowId,stepKey]);
  useEffect(() => { void apiFetch("/youtube/config").then((r) => r.ok ? r.json() : null).then((data) => { if (data) setPrivateOnly(data.privateOnly); }).catch(()=>{}); },[]);
  const current = saved.find((c) => c.targetStepKey === targetKey);
  const itemMap = new Map(items.map((i) => [i.id,i]));
  const outputs = (current?.records ?? []).filter((r) => r.active).sort((a,b) => a.row.order-b.row.order).map((r) => itemMap.get(r.itemId)).filter((i): i is YoutubeItem => Boolean(i));
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
    if (!file) return; setBusy(true); setPreview(null); setRows([]); setErrors([]); setMessage("");
    try { const data = await readCollectionSheet(file); setSheet(data); setMapping(inferMapping(data.headers)); }
    catch (e) { setSheet(null); setMessage(persianError(e,"خواندن اکسل ناموفق بود.")); } finally { setBusy(false); }
  };
  const prepare = () => {
    if (!sheet) return;
    try { const result = mapCollectionRows(sheet,mapping,{ privacy:target?.config.privacy as CollectionRow["privacy"] ?? "private", videoType:target?.config.videoType as CollectionRow["videoType"] ?? "video", playlist:String(target?.config.playlist ?? ""), tags:Array.isArray(target?.config.tags) ? target.config.tags as string[] : [], madeForKids:target?.config.madeForKids === true }); const past=result.rows.filter((row) => row.scheduledAt && Date.parse(row.scheduledAt)<=Date.now()); setRows(result.rows.filter((row) => !past.includes(row))); setErrors([...result.errors,...past.map((row) => `شناسه ${row.id}: زمان انتشار گذشته است؛ تاریخ را اصلاح کنید.`)]); setPreview(null); setMessage("پیش‌نمایش محتوا را بررسی و سپس تغییرات را مقایسه کنید."); }
    catch (e) { setMessage(persianError(e,"خطا")); }
  };
  const change = (id: string, patch: Partial<CollectionRow>) => { setRows((r) => r.map((row) => row.id === id ? { ...row,...patch } : row)); setPreview(null); };
  const compare = async () => {
    if (!workflowId || !target) { setMessage("کارت مجموعه را به انتشار یوتیوب وصل و جریان را ذخیره کنید."); return; }
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
      setPreview(null); setSelected([]); setMessage(`${faDigits(data.applied.length)} تغییر ثبت شد. فایل‌های جدید دریافت می‌شوند و انتشار نیازمند تأیید انسانی است.${data.queueFailures ? " برخی فایل‌ها وارد صف نشدند؛ دریافت مجدد را بزنید." : ""}`); await load(); refresh();
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
    <h3>مجموعه محتوا از اکسل</h3><p>هر ردیف یک ویدئو؛ با شناسه ثابت، نسخه‌های بعدی را بدون آپلود تکراری مقایسه کنید.</p>
    {privateOnly ? <p role="status">پروژه یوتیوب هنوز برای انتشار عمومی تأیید نشده است؛ خروجی‌ها به‌صورت خصوصی آپلود می‌شوند.</p> : null}
    <p><Link href="/calendar">مدیریت در تقویم انتشار</Link></p>
    {!workflowId ? <p role="alert">ابتدا جریان را ذخیره کنید.</p> : null}
    {!targets.length ? <p role="alert">این کارت را مستقیم به کارت انتشار با مقصد یوتیوب وصل کنید.</p> : <label>کارت مقصد<select value={targetKey} disabled={busy} onChange={(e) => { update("collectionTargetKey",e.target.value); setPreview(null); }}>
      {targets.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}</select></label>}
    {current ? <p>مجموعه ثبت‌شده: {faDigits(current.records.filter((r) => r.active).length)} محتوا · آخرین تغییر: {new Date(current.updatedAt).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })}</p> : null}
    <ConnectionSelector target="media" testRequest={workflowId && target && rows[0] ? { path:"/content-collections/test-media",body:{ workflowId,sourceStepKey:stepKey,targetStepKey:targetKey,videoUrl:rows[0].videoUrl } } : undefined} value={config.mediaConnection} onChange={(value) => update("mediaConnection",value)} />
    <small>لینک فایل روی کوبیت، هاست شخصی یا سرویس ذخیره‌سازی باید HTTPS و قابل دانلود توسط سرور باشد. مسیر دریافت فایل مستقل از اتصال یوتیوب است؛ پس از ذخیره جریان و ساخت پیش‌نمایش، اتصال اولین فایل را تست کنید.</small>
    <div className="collection-actions"><button type="button" disabled={busy} onClick={() => { setBusy(true); void downloadCollectionTemplate().catch((e) => setMessage(persianError(e,"دانلود نمونه ناموفق بود."))).finally(() => setBusy(false)); }}>دانلود اکسل نمونه</button>
      <label className="collection-file">انتخاب اکسل جدید یا نسخه به‌روزشده<input type="file" accept=".xlsx" disabled={busy} onChange={(e) => { void read(e.target.files?.[0]); e.target.value = ""; }} /></label></div>
    {sheet ? <details open><summary>تطبیق ستون‌های اکسل</summary><div className="collection-mapping">{collectionColumns.map(([key,label]) => <label key={key}>{label}{["id","title","videoUrl"].includes(key) ? " *" : ""}<select disabled={busy} value={mapping[key] ?? -1} onChange={(e) => { setMapping((m) => ({ ...m,[key]: Number(e.target.value) })); setPreview(null); setRows([]); }}>
      <option value={-1}>بدون ستون / مقدار پیش‌فرض</option>{sheet.headers.map((h,i) => <option key={i} value={i}>{h || `ستون ${faDigits(i+1)}`}</option>)}</select></label>)}</div>
      <button type="button" disabled={busy || !target} onClick={prepare}>ساخت پیش‌نمایش محتوا</button></details> : null}
    {errors.length ? <div role="alert"><strong>{faDigits(errors.length)} ردیف نیازمند اصلاح است؛ ردیف‌های سالم قابل ورودند.</strong>{errors.map((e,i) => <p key={i}>{e}</p>)}<p>برای جلوگیری از حذف اشتباه، در این نوبت ردیف‌های غایب حذف نمی‌شوند.</p></div> : null}
    {rows.length ? <><details><summary>زمان‌بندی ردیف‌های بدون تاریخ</summary><PersianDateTimeField value={start} onChange={setStart} />
      <label>فاصله انتشار (روز)<input type="number" min={1} max={365} value={interval} onChange={(e) => setIntervalDays(Number(e.target.value))} /></label>
      <fieldset><legend>روزهای مجاز انتشار</legend>{weekNames.map((name,i) => <label key={name}><input type="checkbox" checked={weekdays.includes(i)} onChange={(e) => setWeekdays((days) => e.target.checked ? [...days,i] : days.filter((d) => d!==i))} />{name}</label>)}</fieldset>
      <button type="button" disabled={busy} onClick={() => { try { setRows(scheduleCollectionRows(rows,start,interval,weekdays)); setPreview(null); } catch (e) { setMessage(persianError(e,"خطا")); } }}>اعمال برنامه پیشنهادی</button></details>
      <h4>پیش‌نمایش {faDigits(rows.length)} محتوا</h4><div className="collection-rows">{rows.map((row) => <details key={row.id}><summary>{faDigits(row.order)} · {row.title} · {row.videoType === "shorts" ? "Shorts" : "ویدئو"}<small>{row.scheduledAt ? new Date(row.scheduledAt).toLocaleString("fa-IR",{ timeZone:"Asia/Tehran" }) : "بدون زمان‌بندی"}</small></summary>
        <label>شناسه ثابت<input value={row.id} readOnly dir="ltr" /></label><label>ترتیب قسمت<input type="number" min={1} value={row.order} onChange={(e) => change(row.id,{ order:Number(e.target.value) })} /></label>
        <label>عنوان<input maxLength={100} value={row.title} onChange={(e) => change(row.id,{ title:e.target.value })} /></label>
        <label>توضیحات<textarea maxLength={5000} value={row.description} onChange={(e) => change(row.id,{ description:e.target.value })} /></label>
        <label>لینک ویدئو<input dir="ltr" value={row.videoUrl} onChange={(e) => change(row.id,{ videoUrl:e.target.value })} /></label>
        <label>لینک کاور<input dir="ltr" value={row.coverUrl} onChange={(e) => change(row.id,{ coverUrl:e.target.value })} /></label>
        <label>نوع محتوا<select value={row.videoType} onChange={(e) => change(row.id,{ videoType:e.target.value as CollectionRow["videoType"] })}><option value="video">ویدئوی معمولی</option><option value="shorts">ویدئوی کوتاه / Shorts</option></select></label>
        <label>پلی‌لیست<input value={row.playlist} onChange={(e) => change(row.id,{ playlist:e.target.value })} /></label>
        <label>برچسب‌ها<input value={row.tags.join("، ")} onChange={(e) => change(row.id,{ tags:e.target.value.split(/[,،]/).map((t) => t.trim()).filter(Boolean) })} /></label>
        <label>وضعیت نمایش<select value={row.privacy} onChange={(e) => change(row.id,{ privacy:e.target.value as CollectionRow["privacy"] })}><option value="private">خصوصی</option><option value="public">عمومی</option><option value="unlisted">فهرست‌نشده</option></select></label>
        <label><input type="checkbox" checked={row.madeForKids} onChange={(e) => change(row.id,{ madeForKids:e.target.checked })} />مخصوص کودکان</label>
        <PersianDateTimeField value={row.scheduledAt} onChange={(v) => change(row.id,{ scheduledAt:v || null })} />
      </details>)}</div></> : null}
    {sheet && (rows.length > 0 || sheet.rows.length === 0) ? <button type="button" disabled={busy || !target} onClick={() => void compare()}>مقایسه با مجموعه قبلی</button> : null}
    {preview ? <section className="collection-diff"><h4>تغییرات پیش از ثبت</h4><p>{Object.entries(labels).map(([kind,label]) => `${label}: ${faDigits(preview.changes.filter((c) => c.kind===kind).length)}`).join(" · ")}</p>
      {preview.changes.filter((c) => c.kind!=="unchanged").map((c) => <details key={c.id}><summary><label><input type="checkbox" disabled={busy || Boolean(c.blocked)} checked={selected.includes(c.id)} onClick={(e) => e.stopPropagation()} onChange={(e) => setSelected((ids) => e.target.checked ? [...ids,c.id] : ids.filter((id) => id!==c.id))} />{labels[c.kind]} · {c.row.title}</label></summary>
        {c.blocked ? <p role="alert">{c.blocked}</p> : null}{c.remoteEligible ? <button type="button" disabled={busy} onClick={() => void updatePublished(c)}>به‌روزرسانی اطلاعات در یوتیوب، بدون آپلود مجدد</button> : null}{c.status === "published" && c.fields.includes("videoUrl") ? <p>برای انتشار نسخه جدید فایل، ردیفی با شناسه محتوای جدید اضافه کنید.</p> : null}{c.kind === "removed" ? <p>فقط برنامه انتشار متوقف می‌شود؛ ویدئوی یوتیوب حذف نخواهد شد.</p> : null}
        {c.fields.map((key) => <p key={key}><b>{collectionColumns.find(([field]) => field===key)?.[1] ?? (key==="scheduledAt" ? "زمان انتشار" : key)}</b>: {String(c.before?.[key as keyof CollectionRow] ?? "—")} ← {String(c.row[key as keyof CollectionRow] ?? "—")}</p>)}
      </details>)}<button type="button" disabled={busy || !selected.length} onClick={() => void apply()}>تأیید و ثبت {faDigits(selected.length)} تغییر انتخاب‌شده</button><p>ثبت مجموعه مجوز انتشار نیست؛ هر ویدئو بعد از دریافت فایل نیازمند تأیید انسانی است.</p></section> : null}
    {outputs.length ? <section className="collection-outputs"><h4>خروجی‌های مجموعه · {faDigits(outputs.length)} ویدئو</h4>
      <button type="button" onClick={() => setApprovalIds(outputs.filter((i) => i.status === "waiting_approval").map((i) => i.id))}>انتخاب همه ویدئوهای آماده تأیید</button>
      {outputs.slice(0,visible).map((item) => <details key={item.id} open={reviewId===item.id} onToggle={(e) => { if (e.currentTarget.open) setReviewId(item.id); else if(reviewId===item.id) setReviewId(""); }}><summary>{item.title} · {youtubeStatus(item)}</summary>
        {item.status === "waiting_approval" ? <label><input type="checkbox" checked={approvalIds.includes(item.id)} onChange={(e) => setApprovalIds((ids) => e.target.checked ? [...ids,item.id] : ids.filter((id) => id!==item.id))} />انتخاب برای تأیید انتشار</label> : null}
        {reviewId===item.id ? <YoutubeReview item={item} refresh={refresh} /> : null}
      </details>)}{outputs.length>visible ? <button type="button" onClick={() => setVisible((v) => v+20)}>نمایش ۲۰ مورد بعدی</button> : null}
      <button type="button" disabled={!ready.length} onClick={() => void approveSelected()}>تأیید انتشار {faDigits(ready.length)} ویدئوی انتخاب‌شده</button>
    </section> : null}
    </fieldset><p role="status">{message}</p>
  </section>;
}
