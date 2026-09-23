"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getAccessToken } from "../lib/session";

const publicPaths = ["/login"];

export function AuthGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (publicPaths.includes(pathname)) {
      setReady(true);
      return;
    }

    if (!getAccessToken()) {
      router.replace("/login");
      return;
    }

    setReady(true);
  }, [pathname, router]);

  if (!ready) {
    return <div className="auth-loading">در حال بررسی ورود...</div>;
  }

  return <>{children}</>;
}
