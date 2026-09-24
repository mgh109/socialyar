"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { clearSession, getStoredUser, getWorkspaceId } from "../lib/session";
import { ThemeToggle } from "./theme-toggle";

export function AccountMenu() {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setEmail(getStoredUser()?.email ?? ""); setOpen(false);
    document.documentElement.dataset.theme = localStorage.getItem("hoorplus-theme") === "dark" ? "dark" : "light";
  }, [pathname]);
  useEffect(() => {
    const close = (event: MouseEvent) => { if (!menu.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, []);
  if (pathname === "/login") return null;
  return <div className="account-dock" ref={menu}>
    {open ? <div className="account-popover" aria-label="حساب کاربری">
      <div className="account-identity"><div className="account-avatar">{email.charAt(0).toUpperCase() || "ه"}</div>
        <strong dir="ltr">{email || "حساب من"}</strong><small>فضای کاری {getWorkspaceId().slice(0, 8)}</small></div>
      <Link href="/account">حساب کاربری</Link>
      <Link href="/settings/ai">تنظیمات هوش مصنوعی</Link>
      <Link href="/connections">اتصال کانال‌ها</Link>
      <div className="account-menu-footer"><ThemeToggle />
        <button className="account-logout" onClick={() => { clearSession(); setOpen(false); router.replace("/login"); }}>خروج ↗</button></div>
    </div> : null}
    <button className="account-trigger" aria-label="باز کردن منوی حساب" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      {email.charAt(0).toUpperCase() || "ه"}
    </button>
  </div>;
}
