"use client";
import { useState } from "react";
import { PersianDatePicker } from "./persian-date-picker";
import { dayInZone, faDigits, localParts, wallTimeToUTC } from "../lib/persian-calendar";
export function PersianDateTimeField({ value, onChange }: { value: unknown; onChange: (value: string) => void }) {
  const initial = typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value) : new Date(Date.now() + 3600000);
  const parts = localParts(initial, "Asia/Tehran"); const [open, setOpen] = useState(false);
  const [day, setDay] = useState(dayInZone(initial)); const [hour, setHour] = useState(parts.hour); const [minute, setMinute] = useState(parts.minute); const [error, setError] = useState("");
  return <div className="persian-date-time-field"><span>{typeof value === "string" && value ? new Date(value).toLocaleString("fa-IR-u-ca-persian", { timeZone: "Asia/Tehran" }) : "فوری پس از تأیید"}</span>
    <button type="button" onClick={() => setOpen(!open)}>انتخاب تاریخ و ساعت شمسی</button>{value ? <button type="button" onClick={() => onChange("")}>انتشار فوری پس از تأیید</button> : null}
    {open ? <div><PersianDatePicker value={day} onChange={setDay} /><div className="calendar-time-fields"><label>ساعت<select value={hour} onChange={(e) => setHour(Number(e.target.value))}>{Array.from({ length: 24 }, (_, i) => <option key={i} value={i}>{faDigits(String(i).padStart(2,"0"))}</option>)}</select></label>
      <label>دقیقه<select value={minute} onChange={(e) => setMinute(Number(e.target.value))}>{Array.from({ length: 60 }, (_, i) => <option key={i} value={i}>{faDigits(String(i).padStart(2,"0"))}</option>)}</select></label></div>
      <p>به وقت تهران</p>{error ? <p role="alert">{error}</p> : null}<button type="button" onClick={() => { try { onChange(wallTimeToUTC(day, hour, minute, "Asia/Tehran").toISOString()); setOpen(false); setError(""); } catch (e) { setError(e instanceof Error ? e.message : "تاریخ معتبر نیست."); } }}>ثبت زمان</button></div> : null}
  </div>;
}
