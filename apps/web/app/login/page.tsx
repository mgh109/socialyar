"use client";

import { BrandLogo } from "../components/brand-logo";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { saveSession, type AuthSession } from "../lib/session";

export default function LoginPage() {
  const router = useRouter();
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");

    try {
      const response = await fetch(`${apiUrl}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(phone.includes("@") ? { email: phone.trim(), password } : { phone: phone.trim(), password }),
      });

      const data = await response.json();

      if (!response.ok) {
        const error =
          data.error === "invalid_credentials"
            ? "شماره همراه یا رمز عبور اشتباه است."
            : "ورود انجام نشد. اطلاعات را بررسی کن.";
        throw new Error(error);
      }

      saveSession(data as AuthSession);
      router.replace(data.user?.mustChangePassword ? "/account/password" : "/");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "خطای ورود");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-page">
      <section className="auth-brand">
        <BrandLogo large />
        <h1>مدیریت محتوا، از ایده تا انتشار</h1>
        <p>
          وارد فضای کاری خودت شو و جریان‌ها، محتوا، تأیید، انتشار و تحلیل را یکجا مدیریت کن.
        </p>

        <div className="auth-features">
          <span>✦ جریان هوشمند</span>
          <span>✓ تأیید انسانی</span>
          <span>↗ انتشار چندکاناله</span>
        </div>
      </section>

      <section className="auth-card">
        <div className="auth-heading">
          <h2>ورود به هور+</h2>
          <p>برای ادامه وارد حساب خودت شو.</p>
        </div>

        <form className="auth-form" onSubmit={submit}>
          <label>
            <span>شماره همراه</span>
            <input
              type="text"
              inputMode="tel"
              dir="ltr"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              required
              autoComplete="username"
              placeholder="09123456789"
            />
          </label>

          <small>اگر حساب قدیمی شما هنوز شماره همراه ندارد، برای انتقال حساب می‌توانید یک‌بار با ایمیل وارد شوید.</small>
          <label>
            <span>رمز عبور</span>
            <input
              type="password"
              dir="ltr"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              autoComplete="current-password"
              placeholder="••••••••"
            />
          </label>

          {message ? <div className="auth-error">{message}</div> : null}

          <button className="primary-button wide auth-submit" disabled={busy}>
            {busy ? "در حال ورود..." : "ورود به هور+"}
          </button>
        </form>
      </section>
    </main>
  );
}
