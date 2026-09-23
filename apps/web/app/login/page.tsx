"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { saveSession, type AuthSession } from "../lib/session";

export default function LoginPage() {
  const router = useRouter();
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");

    try {
      const response = await fetch(
        `${apiUrl}/auth/${mode === "login" ? "login" : "register"}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            mode === "login"
              ? { email, password }
              : {
                  name,
                  email,
                  password,
                  workspaceName: workspaceName || undefined,
                },
          ),
        },
      );

      const data = await response.json();

      if (!response.ok) {
        const error =
          data.error === "invalid_credentials"
            ? "ایمیل یا رمز عبور اشتباه است."
            : data.error === "email_already_exists"
              ? "این ایمیل قبلاً ثبت شده است."
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
        <span className="eyebrow">SocialYar</span>
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
        <div className="auth-tabs">
          <button
            type="button"
            className={mode === "login" ? "active" : ""}
            onClick={() => setMode("login")}
          >
            ورود
          </button>
          <button
            type="button"
            className={mode === "register" ? "active" : ""}
            onClick={() => setMode("register")}
          >
            ساخت حساب
          </button>
        </div>

        <div className="auth-heading">
          <h2>{mode === "login" ? "خوش برگشتی" : "شروع با SocialYar"}</h2>
          <p>
            {mode === "login"
              ? "برای ادامه وارد حساب خودت شو."
              : "حساب و اولین Workspace به‌صورت خودکار ساخته می‌شود."}
          </p>
        </div>

        <form className="auth-form" onSubmit={submit}>
          {mode === "register" ? (
            <>
              <label>
                <span>نام</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  minLength={2}
                  placeholder="نام شما"
                />
              </label>

              <label>
                <span>نام فضای کاری</span>
                <input
                  value={workspaceName}
                  onChange={(event) => setWorkspaceName(event.target.value)}
                  placeholder="مثلاً تیم محتوای عقیق"
                />
              </label>
            </>
          ) : null}

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
              minLength={mode === "register" ? 8 : 1}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              placeholder="••••••••"
            />
          </label>

          {message ? <div className="auth-error">{message}</div> : null}

          <button className="primary-button wide auth-submit" disabled={busy}>
            {busy
              ? "در حال انجام..."
              : mode === "login"
                ? "ورود به SocialYar"
                : "ساخت حساب و ورود"}
          </button>
        </form>
      </section>
    </main>
  );
}
