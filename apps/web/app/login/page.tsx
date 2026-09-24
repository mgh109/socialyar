"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { saveSession, type AuthSession } from "../lib/session";

export default function LoginPage() {
  const router = useRouter();
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const [email, setEmail] = useState("");
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
        body: JSON.stringify({ email, password }),
      });

      const data = await response.json();

      if (!response.ok) {
        const error =
          data.error === "invalid_credentials"
            ? "ایمیل یا رمز عبور اشتباه است."
            : "ورود انجام نشد. اطلاعات را بررسی کن.";
        throw new Error(error);
      }

      saveSession(data as AuthSession);
      router.replace("/");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "خطای ورود");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-page">
      <section className="auth-brand">
        <span className="eyebrow">هور+</span>
        <h1>مدیریت محتوا، از ایده تا انتشار</h1>
        <p>
          وارد فضای کاری خودت شو و Workflowها، محتوا، تأیید، انتشار و تحلیل را یکجا مدیریت کن.
        </p>

        <div className="auth-features">
          <span>✦ Workflow هوشمند</span>
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
            <span>ایمیل</span>
            <input
              type="email"
              dir="ltr"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoComplete="email"
              placeholder="name@example.com"
            />
          </label>

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
