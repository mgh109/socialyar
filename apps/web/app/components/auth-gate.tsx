"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getAccessToken, refreshSession } from "../lib/session";

const publicPaths = ["/login"];

export function AuthGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    setError("");
    if (publicPaths.includes(pathname)) {
      setReady(true);
      return;
    }

    let active = true;
    setReady(false);
    if (!getAccessToken()) { router.replace("/login"); return; }
    void refreshSession().then((session) => {
      if (!active) return;
      if (session.user.mustChangePassword && pathname !== "/account/password") { router.replace("/account/password"); return; }
      setReady(true);
    }).catch(() => { if (active) setError("بررسی حساب انجام نشد؛ اتصال را بررسی و دوباره تلاش کنید."); });
    return () => { active = false; };

  }, [pathname, router, retry]);

  if (!ready) {
    return <div className="auth-loading">{error ? <><p role="alert">{error}</p><button className="ghost-button" onClick={() => setRetry((value) => value + 1)}>تلاش دوباره</button></> : "در حال بررسی ورود..."}</div>;
  }

  return <>{children}</>;
}
