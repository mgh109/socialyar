"use client";
import { useEffect, useState } from "react";
import { dayKey, faDigits, monthGrid, nextMonth, persianLabel, persianParts, persianToDay, weekNames } from "../lib/persian-calendar";
const months = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"];
export function PersianDatePicker({ value, onChange, label = "انتخاب تاریخ" }: { value: Date; onChange: (date: Date) => void; label?: string }) {
  const [visible, setVisible] = useState(value);
  useEffect(() => { setVisible(value); }, [value.getTime()]);
  const p = persianParts(visible);
  return <div className="persian-picker" aria-label={label}>
    <div className="persian-picker-head"><button type="button" aria-label="ماه قبل" onClick={() => setVisible(nextMonth(visible, -1))}>‹</button>
      <label><span className="sr-only">ماه</span><select value={p.month} onChange={(e) => setVisible(persianToDay(p.year, Number(e.target.value), 1))}>{months.map((name, i) => <option key={name} value={i+1}>{name}</option>)}</select></label>
      <label><span className="sr-only">سال</span><select value={p.year} onChange={(e) => setVisible(persianToDay(Number(e.target.value), p.month, 1))}>{Array.from({ length: 21 }, (_, i) => p.year - 10 + i).map((year) => <option key={year} value={year}>{faDigits(year)}</option>)}</select></label>
      <button type="button" aria-label="ماه بعد" onClick={() => setVisible(nextMonth(visible, 1))}>›</button></div>
    <div className="persian-picker-grid">{weekNames.map((name) => <span key={name} title={name}>{name.slice(0,1)}</span>)}
      {monthGrid(visible).map((date) => <button type="button" key={dayKey(date)} aria-label={persianLabel(date, { day: "numeric" })} aria-pressed={dayKey(date) === dayKey(value)}
        className={`${persianParts(date).month === p.month ? "" : "outside"} ${dayKey(date) === dayKey(value) ? "selected" : ""}`} onClick={() => onChange(date)}>{faDigits(persianParts(date).day)}</button>)}</div>
    <p>تاریخ انتخاب‌شده: {persianLabel(value, { day: "numeric" })}</p>
  </div>;
}
