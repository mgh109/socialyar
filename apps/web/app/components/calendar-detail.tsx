"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { canMoveCalendarItem, type CalendarItem } from "@socialyar/shared";
import { MediaPreview } from "./youtube-panel";
import { ConnectionSelector } from "./connection-selector";
import { ConnectionHistory } from "./connection-history";
import { apiFetch } from "../lib/session";
import { faDigits } from "../lib/persian-calendar";

export const calendarLabels = { draft: "پیش‌نویس", waiting_approval: "منتظر تأیید", scheduled: "زمان‌بندی‌شده", queued: "در صف", sending: "در حال ارسال", published: "منتشرشده", failed: "ناموفق", stopped: "متوقف‌شده" };
export const networkLabels: Record<string,string> = { youtube: "یوتیوب", telegram: "تلگرام", instagram: "اینستاگرام", eitaa: "ایتا", website: "وب‌سایت", x: "ایکس", linkedin: "لینکدین" };
export type CalendarAccount = { id: string; channel: string; displayName: string | null; externalAccountId: string; isActive: boolean };
export function CalendarDetail({ item, accounts, busy, close, mutate, schedule, timezone, error, message }: { item: CalendarItem; accounts: CalendarAccount[]; busy: boolean; timezone: string; error: string; message: string;
  close: () => void; mutate: (item: CalendarItem, action: string, data?: Record<string, unknown>) => Promise<boolean>; schedule: (item: CalendarItem) => void }) {
  const [title, setTitle] = useState(item.title); const [body, setBody] = useState(item.body); const [settings, setSettings] = useState(item.settings);
  const [accountId, setAccountId] = useState(item.accountId ?? ""); const [dirty, setDirty] = useState(false); const [version, setVersion] = useState(item.version);
  const [editUpdatedAt, setEditUpdatedAt] = useState(item.updatedAt);
  const [checked, setChecked] = useState(false); const [events, setEvents] = useState<Array<{ id: string; action: string; createdAt: string; detail: { scheduledAt?: string; timezone?: string } }>>([]);
  const reset = () => { setTitle(item.title); setBody(item.body); setSettings(item.settings); setAccountId(item.accountId ?? ""); setVersion(item.version); setEditUpdatedAt(item.updatedAt); setDirty(false); };
  useEffect(() => { if (!dirty) reset(); }, [item.version, item.updatedAt]);
  useEffect(() => { void apiFetch(`/calendar/items/${item.kind}/${item.sourceId}/events`).then((r) => r.ok ? r.json() : []).then(setEvents); }, [item.updatedAt]);
  const editable = canMoveCalendarItem(item); const locked = ["sending", "published"].includes(item.status);
  const setSetting = (key: string, value: unknown) => { setSettings((s) => ({ ...s, [key]: value })); setDirty(true); };
  const save = async () => { if (await mutate({ ...item, version, updatedAt: editUpdatedAt }, "edit", { title, body, settings, accountId: accountId || null })) setDirty(false); };
  const stale = version !== item.version || editUpdatedAt !== item.updatedAt;
  const eligibleAccounts = accounts.filter((account) => account.channel === item.channel && account.isActive);
  return <div className="calendar-drawer-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}><aside className="calendar-drawer" role="dialog" aria-modal="true" aria-labelledby="calendar-detail-title">
    <header><div><h2 id="calendar-detail-title">جزئیات انتشار</h2><span className={`publication-status status-${item.status}`}>{calendarLabels[item.status]}</span></div><button type="button" aria-label="بستن جزئیات" onClick={close}>×</button></header>
    <p>{networkLabels[item.channel]} · {item.accountName ?? "مقصد انتخاب نشده"} · {item.workflowName}</p>
    <p>زمان انتشار: {item.scheduledAt ? new Date(item.scheduledAt).toLocaleString("fa-IR-u-ca-persian", { timeZone: timezone }) : "بدون زمان‌بندی"}</p>
    {error ? <p className="calendar-warning" role="alert">{error}</p> : null}{message ? <p className="calendar-success" role="status">{message}</p> : null}
    {item.overdue ? <p className="calendar-warning">زمان انتشار گذشته؛ نیازمند تعیین تکلیف</p> : null}
    <MediaPreview mediaId={item.coverMediaId} url={item.imageUrl} /><MediaPreview video mediaId={item.videoMediaId} url={item.videoUrl} />
    <label>عنوان<input value={title} maxLength={item.kind === "youtube" ? 100 : 300} disabled={!editable || busy} onChange={(e) => { setTitle(e.target.value); setDirty(true); }} /></label>
    <label>{item.kind === "youtube" ? "توضیحات" : "متن خروجی"}<textarea rows={8} value={body} disabled={!editable || busy} onChange={(e) => { setBody(e.target.value); setDirty(true); }} /></label>
    {editable ? <><label>حساب مقصد<select value={accountId} disabled={busy} onChange={(e) => { setAccountId(e.target.value); setDirty(true); }}><option value="">انتخاب حساب</option>
      {accountId && !eligibleAccounts.some((a) => a.id === accountId) ? <option value={accountId} disabled>حساب فعلی غیرفعال است</option> : null}
      {eligibleAccounts.map((account) => <option key={account.id} value={account.id}>{account.displayName ?? account.externalAccountId}</option>)}</select></label>
      <label>آدرس تصویر یا کاور<input dir="ltr" value={String(settings[item.kind === "youtube" ? "coverUrl" : "imageUrl"] ?? "")} onChange={(e) => setSetting(item.kind === "youtube" ? "coverUrl" : "imageUrl", e.target.value || null)} /></label>
      {item.kind !== "youtube" ? <label>آدرس ویدئو<input dir="ltr" value={String(settings.videoUrl ?? "")} onChange={(e) => setSetting("videoUrl", e.target.value || null)} /></label> : <>
        <label>نوع انتشار<select value={String(settings.privacy ?? "private")} onChange={(e) => setSetting("privacy", e.target.value)}><option value="private">خصوصی</option><option value="public">عمومی</option><option value="unlisted">فهرست‌نشده</option></select></label>
        <label>برچسب‌ها<input value={Array.isArray(settings.tags) ? settings.tags.join("،") : ""} onChange={(e) => setSetting("tags", e.target.value.split(/[,،]/).map((t) => t.trim()).filter(Boolean))} /></label>
        <label><input type="checkbox" checked={settings.madeForKids === true} onChange={(e) => setSetting("madeForKids", e.target.checked)} /> محتوای مخصوص کودکان</label>
      </>}
      {["youtube", "telegram", "instagram"].includes(item.channel) ? <ConnectionSelector target={item.channel as "youtube" | "telegram" | "instagram"} value={settings.connection} onChange={(value) => setSetting("connection", value)} /> : null}
      {dirty && stale ? <p className="calendar-warning">این آیتم در جای دیگری تغییر کرده است. پیش از ویرایش، نسخه تازه را دریافت کنید. <button type="button" onClick={reset}>بازخوانی</button></p> : null}
      <button type="button" className="primary-button" disabled={busy || !dirty || !title.trim() || stale} onClick={() => void save()}>ذخیره تغییرات و ارسال برای تأیید</button>
      {item.status === "draft" && !dirty && !item.approved ? <button type="button" disabled={busy} onClick={() => void mutate(item, "edit")}>ارسال برای تأیید</button> : null}
      {item.status === "draft" && item.approved ? <small>محتوا تأیید شده و آمادهٔ تعیین زمان انتشار است.</small> : null}
      {dirty ? <small>پس از ویرایش، محتوا دوباره نیازمند تأیید است.</small> : null}
    </> : <p>محتوای این آیتم قفل است؛ ارسال آغاز شده یا در مقصد ثبت شده است.</p>}
    <div className="calendar-detail-actions">
      {item.deliveryUnknown || item.status === "failed" && item.approved ? <label><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> مقصد و گزارش را بررسی کردم؛ انتشار تکراری رخ نمی‌دهد یا وضعیت همان ویدئوی یوتیوب بررسی می‌شود.</label> : null}
      {editable ? <><button type="button" disabled={busy || dirty} onClick={() => schedule(item)}>تغییر زمان</button>
        {item.scheduledAt ? <button type="button" disabled={busy || dirty} onClick={() => void mutate(item, "unschedule")}>حذف از برنامه و انتقال به بدون زمان‌بندی</button> : null}</> : null}
      {item.status === "waiting_approval" ? <><button type="button" disabled={busy || dirty || item.overdue || item.deliveryUnknown && !checked} onClick={() => void mutate(item, "approve", { destinationChecked: checked })}>تأیید محتوا{item.scheduledAt ? " و اجرای برنامه" : ""}</button>
        <button type="button" disabled={busy} onClick={() => void mutate(item, "reject")}>رد محتوا</button></> : null}
      {!locked && item.status !== "stopped" ? <button type="button" disabled={busy || dirty} onClick={() => void mutate(item, "stop")}>توقف انتشار</button> : null}
      {item.status === "failed" && item.approved && (item.kind === "youtube" || !item.remoteConfirmed) ? <>
        <button type="button" disabled={busy || !checked || dirty} onClick={() => void mutate(item, "retry", { destinationChecked: checked })}>تلاش مجدد</button></> : null}
    </div>
    {item.error ? <p className="calendar-warning" role="alert">علت خطا: {item.error}</p> : null}
    {item.deliveryUnknown ? <p className="calendar-warning">نتیجه ارسال قبلی نامشخص است؛ پیش از تلاش مجدد مقصد را بررسی کنید.</p> : null}
    {item.externalUrl ? <a href={item.externalUrl} target="_blank" rel="noreferrer">مشاهده خروجی در {networkLabels[item.channel]}</a> : null}
    {item.workflowId ? <Link href={`/workflows/new?id=${item.workflowId}${item.stepKey ? `&step=${encodeURIComponent(item.stepKey)}` : ""}`}>رفتن به جریان و کارت مربوطه</Link> : null}
    {item.runId ? <Link href={`/runs/${item.runId}`}>گزارش اجرای جریان</Link> : null}
    {item.publicationId || item.kind === "youtube" ? <ConnectionHistory timezone={timezone} publicationId={item.publicationId ?? undefined} youtubeItemId={item.kind === "youtube" ? item.sourceId : undefined} /> : null}
    <details><summary>گزارش تغییرات برنامه</summary>{events.map((event) => <p key={event.id}>{new Date(event.createdAt).toLocaleString("fa-IR", { timeZone: timezone })} · {({ edit: "ویرایش و درخواست تأیید", schedule: "تغییر زمان", unschedule: "حذف از برنامه", stop: "توقف", approve: "تأیید", reject: "رد", retry: "تلاش مجدد" } as Record<string,string>)[event.action] ?? event.action}
      {event.detail.scheduledAt ? ` · ${new Date(event.detail.scheduledAt).toLocaleString("fa-IR", { timeZone: timezone })}` : ""}</p>)}{!events.length ? <p>هنوز تغییری ثبت نشده است.</p> : null}</details>
    <p className="calendar-note">حذف از برنامه، محتوای منتشرشده را در شبکه مقصد حذف نمی‌کند. نسخهٔ برنامه: {faDigits(item.version)}</p>
  </aside></div>;
}
