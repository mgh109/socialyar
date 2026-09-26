"use client";

import Link from "next/link";

export function TopMenu() {
  return <details className="top-menu"><summary aria-label="باز کردن منوی بخش‌ها">☰ <span>بخش‌ها</span></summary>
    <nav aria-label="بخش‌های هور+">
      <Link href="/">میز کار و جریان‌ها</Link>
      <Link href="/approvals">تأیید انسانی</Link>
      <Link href="/analytics">داشبورد انتشار و سلامت</Link>
      <Link href="/calendar">تقویم انتشار</Link>
      <Link href="/connections">اتصال کانال‌ها</Link>
      <Link href="/settings/ai">مدل‌های هوش مصنوعی</Link>
    </nav>
  </details>;
}
