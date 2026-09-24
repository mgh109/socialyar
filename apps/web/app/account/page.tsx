"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getStoredUser, getWorkspaceId } from "../lib/session";

export default function AccountPage() {
  const [user, setUser] = useState<{ email: string; name: string | null } | null>(null);
  const [workspace, setWorkspace] = useState("");
  useEffect(() => { setUser(getStoredUser()); setWorkspace(getWorkspaceId()); }, []);
  return <main className="settings-page"><Link href="/">← میز کار</Link><h1>حساب کاربری</h1>
    <section className="settings-card"><p>ایمیل</p><strong dir="ltr">{user?.email ?? "..."}</strong>
      <p>نام</p><strong>{user?.name || "ثبت نشده"}</strong>
      <p>فضای کاری</p><strong dir="ltr">{workspace || "..."}</strong>
      <p>خروج و تغییر تم از منوی حساب در گوشهٔ پایین صفحه در دسترس است.</p></section>
  </main>;
}
