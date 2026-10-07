const DAY = 86400000;
export const faDigits = (value: number | string) => String(value).replace(/\d/g, (digit) => "۰۱۲۳۴۵۶۷۸۹"[Number(digit)]);
export const latinDigits = (value: string) => value.replace(/[۰-۹٠-٩]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit) >= 0 ? "۰۱۲۳۴۵۶۷۸۹".indexOf(digit) : "٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
export const weekNames = ["شنبه", "یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه"];
export function persianParts(day: Date) {
  const parts = new Intl.DateTimeFormat("en-US-u-ca-persian", { timeZone: "UTC", year: "numeric", month: "numeric", day: "numeric" }).formatToParts(day);
  const part = (name: string) => Number(parts.find((p) => p.type === name)?.value);
  return { year: part("year"), month: part("month"), day: part("day") };
}
export function localParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-GB-u-ca-gregory", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const part = (name: string) => Number(parts.find((p) => p.type === name)?.value);
  return { year: part("year"), month: part("month"), day: part("day"), hour: part("hour"), minute: part("minute") };
}
// Calendar days are represented by Gregorian UTC noon; they are independent of browser timezone.
export function dayInZone(date: Date, timezone = "Asia/Tehran") {
  const p = localParts(date, timezone); return new Date(Date.UTC(p.year, p.month - 1, p.day, 12));
}
export function dayKey(day: Date) { return day.toISOString().slice(0, 10); }
export function addDays(day: Date, amount: number) { return new Date(day.getTime() + amount * DAY); }
export function monthStart(day: Date) { return addDays(day, 1 - persianParts(day).day); }
export function nextMonth(day: Date, direction: number) {
  const first = monthStart(day); return monthStart(addDays(first, direction > 0 ? 32 : -1));
}
export function weekStart(day: Date) { return addDays(day, -(day.getUTCDay() + 1) % 7); }
export function monthGrid(day: Date) {
  const first = monthStart(day); const start = weekStart(first);
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}
export function persianLabel(day: Date, options: Intl.DateTimeFormatOptions = {}) {
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian", { timeZone: "UTC", year: "numeric", month: "long", ...options }).format(day);
}
export function persianToDay(year: number, month: number, day: number) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) || year < 1200 || year > 1700 || month < 1 || month > 12 || day < 1 || day > 31) throw new Error("تاریخ شمسی معتبر نیست.");
  const target = year * 10000 + month * 100 + day;
  let low = Math.floor(Date.UTC(1820, 0, 1, 12) / DAY); let high = Math.ceil(Date.UTC(2325, 0, 1, 12) / DAY);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2); const date = new Date(middle * DAY + DAY / 2); const p = persianParts(date);
    const value = p.year * 10000 + p.month * 100 + p.day;
    if (value === target) return date;
    if (value < target) low = middle + 1; else high = middle - 1;
  }
  throw new Error("این روز در ماه انتخاب‌شده وجود ندارد.");
}
export function wallTimeToUTC(day: Date, hour: number, minute: number, timezone: string) {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new Error("ساعت معتبر نیست.");
  const target = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute);
  let instant = target;
  for (let index = 0; index < 5; index++) {
    const p = localParts(new Date(instant), timezone);
    const difference = target - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    if (!difference) return new Date(instant);
    instant += difference;
  }
  throw new Error("این ساعت در منطقه زمانی انتخاب‌شده وجود ندارد؛ ساعت دیگری انتخاب کنید.");
}
