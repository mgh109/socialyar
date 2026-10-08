"use client";
import { persianError } from "../lib/persian";
import { useEffect, useMemo, useState } from "react";
import { canMoveCalendarItem, type CalendarItem } from "@socialyar/shared";
import { apiFetch } from "../lib/session";
import { BrandLogo } from "./brand-logo";
import { CalendarDetail, calendarLabels, networkLabels, type CalendarAccount } from "./calendar-detail";
import { PersianDatePicker } from "./persian-date-picker";
import { MediaPreview } from "./youtube-panel";
import { addDays, dayInZone, dayKey, faDigits, localParts, monthGrid, monthStart, nextMonth, persianLabel, persianParts, wallTimeToUTC, weekNames, weekStart } from "../lib/persian-calendar";

type View = "month" | "week" | "list";
const zones = [{ id: "Asia/Tehran", name: "تهران" }, { id: "UTC", name: "زمان جهانی" }, { id: "Asia/Dubai", name: "دبی" }, { id: "Europe/Istanbul", name: "استانبول" }, { id: "Europe/London", name: "لندن" }, { id: "America/New_York", name: "نیویورک" }];
const normalize = (value: string) => value.normalize("NFKC").replace(/ي/g, "ی").replace(/ك/g, "ک").toLocaleLowerCase("fa-IR");
function PublicationTile({ item, timezone, open, busy }: { item: CalendarItem; timezone: string; open: () => void; busy: boolean }) {
  const image = item.coverMediaId || item.imageUrl; const video = !image && (item.videoMediaId || item.videoUrl);
  return <button type="button" className={`publication-tile status-border-${item.status}`} onClick={open} draggable={!busy && canMoveCalendarItem(item)}
    onDragStart={(event) => { event.dataTransfer.setData("text/plain", item.id); event.dataTransfer.effectAllowed = "move"; }} title={`${item.title} · ${item.workflowName}`}>
    <span className="publication-thumbnail">{image || video ? <MediaPreview compact mediaId={image ? item.coverMediaId : item.videoMediaId} url={image ? item.imageUrl : item.videoUrl} video={Boolean(video)} /> : <span aria-hidden="true">{item.channel === "youtube" ? "▶" : "▤"}</span>}</span>
    <span className="publication-tile-content"><strong>{item.title}</strong><span>{networkLabels[item.channel]} · {item.workflowName}</span>
      <span>{item.scheduledAt ? new Intl.DateTimeFormat("fa-IR", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(item.scheduledAt)) : "بدون زمان"} · {item.accountName ?? "مقصد انتخاب نشده"}</span>
      <span className={`publication-status status-${item.status}`}>{calendarLabels[item.status]}</span>{item.overdue ? <small className="calendar-overdue">زمان انتشار گذشته؛ نیازمند تعیین تکلیف</small> : null}</span>
  </button>;
}
export function CalendarPublish() {
  const [items, setItems] = useState<CalendarItem[]>([]); const [accounts, setAccounts] = useState<CalendarAccount[]>([]);
  const [view, setView] = useState<View>("month"); const [timezone, setTimezone] = useState("Asia/Tehran");
  const [focus, setFocus] = useState(() => dayInZone(new Date())); const [now, setNow] = useState(() => Date.now());
  const [network, setNetwork] = useState(""); const [workflow, setWorkflow] = useState(""); const [status, setStatus] = useState(""); const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<{ kind: string; sourceId: string; publicationId: string | null } | null>(null);
  const [schedule, setSchedule] = useState<{ item: CalendarItem; day: Date; hour: number; minute: number; destinationChecked: boolean } | null>(null);
  const [datePicker, setDatePicker] = useState(false); const [onlyDay, setOnlyDay] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true); const [message, setMessage] = useState(""); const [error, setError] = useState("");
  const refresh = async () => {
    const results = await Promise.all([apiFetch("/calendar/items"), apiFetch("/social-accounts")]);
    if (results.some((response) => !response.ok)) throw new Error("دریافت تقویم انتشار ناموفق بود؛ اتصال سرور و مهاجرت دیتابیس را بررسی کنید.");
    const [data, accountData] = await Promise.all(results.map((response) => response.json())); setItems(data); setAccounts(accountData); setNow(Date.now());
  };
  useEffect(() => {
    if (window.matchMedia("(max-width: 760px)").matches) setView("list");
    void refresh().catch((e) => setError(persianError(e))).finally(() => setLoading(false));
    const timer = setInterval(() => void refresh().catch((e) => setError(persianError(e))), 3000); return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) { setSelected(null); setSchedule(null); setDatePicker(false); } };
    document.addEventListener("keydown", listener); return () => document.removeEventListener("keydown", listener);
  }, [busy]);
  const active = selected ? items.find((item) => item.kind === selected.kind && item.sourceId === selected.sourceId && (!selected.publicationId || item.publicationId === selected.publicationId)) : undefined;
  const filtered = useMemo(() => items.filter((item) => (!network || item.channel === network) && (!workflow || item.workflowId === workflow) && (!status || item.status === status) &&
    (!search.trim() || normalize(`${item.title} ${item.body}`).includes(normalize(search.trim())))), [items, network, workflow, status, search]);
  const workflows = [...new Map(items.filter((item) => item.workflowId).map((item) => [item.workflowId!, item.workflowName])).entries()];
  const today = dayInZone(new Date(now), timezone); const month = persianParts(focus).month;
  const days = view === "week" ? Array.from({ length: 7 }, (_, index) => addDays(weekStart(focus), index)) : monthGrid(focus);
  const grouped = new Map<string, CalendarItem[]>();
  for (const item of filtered) {
    if (!item.scheduledAt) continue; const key = dayKey(dayInZone(new Date(item.scheduledAt), timezone));
    grouped.set(key, [...(grouped.get(key) ?? []), item].sort((a,b) => Date.parse(a.scheduledAt!) - Date.parse(b.scheduledAt!)));
  }
  const unscheduled = filtered.filter((item) => !item.scheduledAt);
  const listItems = filtered.filter((item) => item.scheduledAt && (onlyDay ? dayKey(dayInZone(new Date(item.scheduledAt), timezone)) === onlyDay :
    dayInZone(new Date(item.scheduledAt), timezone).getTime() >= monthStart(focus).getTime() && dayInZone(new Date(item.scheduledAt), timezone).getTime() < nextMonth(focus, 1).getTime()))
    .sort((a,b) => Date.parse(a.scheduledAt!) - Date.parse(b.scheduledAt!));
  const open = (item: CalendarItem) => { setSelected({ kind: item.kind, sourceId: item.sourceId, publicationId: item.publicationId }); setMessage(""); setError(""); };
  const chooseTime = (item: CalendarItem, day?: Date) => {
    if (busy || !canMoveCalendarItem(item)) return;
    const parts = item.scheduledAt ? localParts(new Date(item.scheduledAt), timezone) : { hour: 9, minute: 0 };
    setSchedule({ item, day: day ?? (item.scheduledAt ? dayInZone(new Date(item.scheduledAt), timezone) : addDays(today, 1)), hour: parts.hour, minute: parts.minute, destinationChecked: false }); setError("");
  };
  const mutate = async (item: CalendarItem, action: string, data: Record<string, unknown> = {}) => {
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await apiFetch(`/calendar/items/${item.kind}/${item.sourceId}`, { method: "POST", body: JSON.stringify({ action, version: item.version, updatedAt: item.updatedAt, publicationId: item.publicationId, timezone, ...data }) });
      const result = await response.json(); if (!response.ok) { if (response.status === 409) await refresh(); throw new Error(result.error ?? "ثبت تغییر ناموفق بود."); }
      await refresh(); setMessage("تغییر در تقویم، کارت و صف انتشار ثبت شد."); return true;
    } catch (e) { setError(persianError(e, "خطای ثبت تغییر")); return false; } finally { setBusy(false); }
  };
  const confirmTime = async () => {
    if (!schedule) return;
    try { const instant = wallTimeToUTC(schedule.day, schedule.hour, schedule.minute, timezone);
      if (instant.getTime() <= Date.now()) throw new Error("تاریخ و ساعت آینده را انتخاب کنید.");
      if (await mutate(schedule.item, "schedule", { scheduledAt: instant.toISOString(), accountId: schedule.item.accountId, destinationChecked: schedule.destinationChecked })) setSchedule(null);
    } catch (e) { setError(persianError(e, "تاریخ معتبر نیست.")); }
  };
  const navigate = (direction: number) => { setOnlyDay(null); setFocus(view === "week" ? addDays(focus, direction * 7) : nextMonth(focus, direction)); };
  const renderTile = (item: CalendarItem) => <PublicationTile key={item.id} item={item} timezone={timezone} open={() => open(item)} busy={busy} />;
  return <main className="workflow-page publication-calendar" dir="rtl"><header className="app-header"><div className="brand-lockup"><BrandLogo /><span>تقویم انتشار</span></div>
    <div className="header-actions"><button type="button" disabled={loading} onClick={() => void refresh().catch((e) => setError(persianError(e)))}>به‌روزرسانی</button></div></header>
    <section className="publication-calendar-shell"><div className="publication-calendar-title"><div><h1>تقویم انتشار</h1><p>خروجی‌های تولیدشده، تأییدها و برنامهٔ واقعی انتشار در یک نگاه</p></div>
      <label>منطقه زمانی<select value={timezone} onChange={(e) => { setTimezone(e.target.value); setOnlyDay(null); }}>{zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</select></label></div>
      <div className="calendar-counters"><span>برنامه‌ریزی‌شده <strong>{faDigits(filtered.filter((item) => item.status === "scheduled").length)}</strong></span><span>منتظر تأیید <strong>{faDigits(filtered.filter((item) => item.status === "waiting_approval").length)}</strong></span><span>ناموفق <strong>{faDigits(filtered.filter((item) => item.status === "failed").length)}</strong></span></div>
      <div className="calendar-filters"><label>جست‌وجو<input type="search" placeholder="عنوان یا متن خروجی" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
        <label>شبکه<select value={network} onChange={(e) => setNetwork(e.target.value)}><option value="">همهٔ شبکه‌ها</option>{Object.entries(networkLabels).map(([id,label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <label>جریان<select value={workflow} onChange={(e) => setWorkflow(e.target.value)}><option value="">همهٔ جریان‌ها</option>{workflows.map(([id,label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <label>وضعیت<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">همهٔ وضعیت‌ها</option>{Object.entries(calendarLabels).map(([id,label]) => <option key={id} value={id}>{label}</option>)}</select></label></div>
      <div className="calendar-navigation"><div><button type="button" onClick={() => { setFocus(today); setOnlyDay(null); }}>امروز</button><button type="button" aria-label={view === "week" ? "هفته قبل" : "ماه قبل"} onClick={() => navigate(-1)}>{view === "week" ? "هفته قبل" : "ماه قبل"}</button>
        <strong>{onlyDay ? persianLabel(focus, { day: "numeric" }) : view === "week" ? `${persianLabel(days[0], { day: "numeric" })} تا ${persianLabel(days[6], { day: "numeric" })}` : persianLabel(focus)}</strong>
        <button type="button" aria-label={view === "week" ? "هفته بعد" : "ماه بعد"} onClick={() => navigate(1)}>{view === "week" ? "هفته بعد" : "ماه بعد"}</button><button type="button" onClick={() => setDatePicker(!datePicker)}>انتخاب تاریخ</button></div>
        <div className="calendar-view-switch" role="group" aria-label="نمای تقویم">{([{ id: "month", label: "ماهانه" }, { id: "week", label: "هفتگی" }, { id: "list", label: "فهرستی" }] as const).map((option) => <button type="button" key={option.id} aria-pressed={view === option.id} onClick={() => { setView(option.id); setOnlyDay(null); }}>{option.label}</button>)}</div></div>
      {datePicker ? <div className="calendar-date-popover"><PersianDatePicker value={focus} onChange={(day) => { setFocus(day); setOnlyDay(null); setDatePicker(false); }} /></div> : null}
      <div aria-live="polite">{loading ? <p>در حال دریافت خروجی‌های انتشار…</p> : null}{message ? <p className="calendar-success">{message}</p> : null}{error ? <p className="calendar-warning" role="alert">{error}</p> : null}</div>
      {view === "list" ? <section className="publication-list-view"><h2>{onlyDay ? "خروجی‌های روز انتخاب‌شده" : "خروجی‌های این ماه"}</h2>{onlyDay ? <button type="button" onClick={() => setOnlyDay(null)}>نمایش همهٔ ماه</button> : null}
        {listItems.map((item) => <div className="publication-list-row" key={item.id}><time>{persianLabel(dayInZone(new Date(item.scheduledAt!), timezone), { day: "numeric", weekday: "long" })}</time>{renderTile(item)}</div>)}
        {!listItems.length && !loading ? <p className="calendar-empty">در این بازه خروجی برنامه‌ریزی نشده است. از «بدون زمان‌بندی» یک خروجی انتخاب کنید.</p> : null}</section> :
        <div className={`publication-calendar-grid ${view === "week" ? "weekly" : "monthly"}`}>{weekNames.map((name) => <div key={name} className="calendar-weekday">{name}</div>)}
          {days.map((day) => {
            const key = dayKey(day); const dayItems = grouped.get(key) ?? []; const max = view === "week" ? 6 : 3;
            return <section key={key} className={`publication-day ${persianParts(day).month !== month ? "outside" : ""} ${key === dayKey(today) ? "today" : ""}`}
              aria-label={persianLabel(day, { day: "numeric" })} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }} onDrop={(e) => { e.preventDefault(); const item = items.find((i) => i.id === e.dataTransfer.getData("text/plain")); if (item) chooseTime(item, day); }}>
              <header><button type="button" onClick={() => { setFocus(day); setOnlyDay(key); setView("list"); }}>{faDigits(persianParts(day).day)}</button>{key === dayKey(today) ? <span>امروز</span> : null}</header>
              {dayItems.slice(0,max).map(renderTile)}{dayItems.length > max ? <button className="calendar-show-all" type="button" onClick={() => { setFocus(day); setOnlyDay(key); setView("list"); }}>نمایش همه ({faDigits(dayItems.length)})</button> : null}
              {!dayItems.length ? <p className="calendar-day-empty">خالی · خروجی را به این روز بیاورید</p> : null}
            </section>;
          })}</div>}
      <section className="calendar-unscheduled"><header><div><h2>بدون زمان‌بندی <span>{faDigits(unscheduled.length)}</span></h2><p>خروجی را انتخاب و «تغییر زمان» را بزنید، یا آن را روی روز دلخواه بکشید.</p></div></header>
        <div>{unscheduled.map(renderTile)}</div>{!unscheduled.length && !loading ? <p className="calendar-empty">خروجی بدون زمان‌بندی وجود ندارد.</p> : null}</section>
      <p className="calendar-note">رسیدن زمان انتشار جایگزین تأیید نیست. برنامه‌ها با بسته‌بودن مرورگر در صف سرور اجرا می‌شوند.</p>
    </section>
    {active ? <CalendarDetail key={active.id} item={active} accounts={accounts} busy={busy} close={() => setSelected(null)} mutate={mutate} schedule={chooseTime} timezone={timezone} error={error} message={message} /> : null}
    {schedule ? <div className="calendar-time-backdrop"><section className="calendar-time-dialog" role="dialog" aria-modal="true" aria-labelledby="schedule-dialog-title"><header><h2 id="schedule-dialog-title">تعیین تاریخ و ساعت انتشار</h2><button type="button" aria-label="بستن انتخاب ساعت" disabled={busy} onClick={() => setSchedule(null)}>×</button></header>
      <p>{schedule.item.title} · {networkLabels[schedule.item.channel]}</p><PersianDatePicker value={schedule.day} onChange={(day) => setSchedule((s) => s ? { ...s, day } : null)} />
      <div className="calendar-time-fields"><label>ساعت<select value={schedule.hour} onChange={(e) => setSchedule((s) => s ? { ...s, hour: Number(e.target.value) } : null)}>{Array.from({ length: 24 }, (_, i) => <option key={i} value={i}>{faDigits(String(i).padStart(2,"0"))}</option>)}</select></label>
        <label>دقیقه<select value={schedule.minute} onChange={(e) => setSchedule((s) => s ? { ...s, minute: Number(e.target.value) } : null)}>{Array.from({ length: 60 }, (_, i) => <option key={i} value={i}>{faDigits(String(i).padStart(2,"0"))}</option>)}</select></label>
        <span>به وقت {zones.find((zone) => zone.id === timezone)?.name}</span></div>
      {schedule.item.kind === "variant" ? <label>حساب مقصد<select value={schedule.item.accountId ?? ""} onChange={(e) => setSchedule((s) => s ? { ...s, item: { ...s.item, accountId: e.target.value || null } } : null)}><option value="">انتخاب حساب</option>{accounts.filter((a) => a.isActive && a.channel === schedule.item.channel).map((a) => <option key={a.id} value={a.id}>{a.displayName ?? a.externalAccountId}</option>)}</select></label> : null}
      {!schedule.item.approved ? <p className="calendar-warning">این خروجی تا تأیید انسانی ارسال نمی‌شود، حتی اگر زمان انتشار برسد.</p> : null}
      {schedule.item.deliveryUnknown ? <label><input type="checkbox" checked={schedule.destinationChecked} onChange={(e) => setSchedule((s) => s ? { ...s, destinationChecked: e.target.checked } : null)} /> نتیجه ارسال قبلی نامشخص بود؛ مقصد را بررسی و نبود انتشار قبلی را تأیید کردم.</label> : null}
      {error ? <p className="calendar-warning" role="alert">{error}</p> : null}<div><button type="button" className="primary-button" disabled={busy} onClick={() => void confirmTime()}>تأیید تغییر زمان</button><button type="button" disabled={busy} onClick={() => setSchedule(null)}>انصراف</button></div>
    </section></div> : null}
  </main>;
}
