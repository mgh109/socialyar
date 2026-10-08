"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

const workLinks = [
  { href: "/", label: "جریان‌ها", prefix: "/workflows" },
  { href: "/approvals", label: "تأیید محتوا" },
  { href: "/calendar", label: "تقویم انتشار" },
  { href: "/analytics", label: "گزارش‌ها" },
  { href: "/connections", label: "کانال‌ها" },
];
const settingsLinks = [
  { href: "/settings/ai", label: "هوش مصنوعی" },
  { href: "/settings/api", label: "سرویس‌های API" },
  { href: "/settings/proxies", label: "ارتباط و پروکسی" },
];

export function TopMenu() {
  const pathname = usePathname();
  const settings = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (settings.current) settings.current.open = false;
  }, [pathname]);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (settings.current && !settings.current.contains(event.target as Node)) settings.current.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && settings.current) settings.current.open = false;
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, []);
  if (pathname === "/login") return null;
  return <nav className="app-navigation" aria-label="منوی اصلی هور+">
    <div className="app-navigation-links">
      {workLinks.map((item) => {
        const active = pathname === item.href || (item.prefix && pathname.startsWith(item.prefix));
        return <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined}>{item.label}</Link>;
      })}
    </div>
    <details className="app-navigation-settings" ref={settings}>
      <summary className={pathname.startsWith("/settings/") ? "active" : undefined}>تنظیمات <span aria-hidden="true">⌄</span></summary>
      <div className="app-navigation-popover">
        {settingsLinks.map((item) => <Link key={item.href} href={item.href} aria-current={pathname === item.href ? "page" : undefined}>{item.label}</Link>)}
      </div>
    </details>
  </nav>;
}
