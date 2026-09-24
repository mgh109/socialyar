"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/session";

export default function AISettingsPage() {
  const [provider, setProvider] = useState<"openai" | "openrouter">("openrouter");
  const [model, setModel] = useState("");
  const [token, setToken] = useState("");
  const [configured, setConfigured] = useState(false);
  const [sample, setSample] = useState("یک خبر نمونه برای بررسی اتصال هوش مصنوعی و نمایش خروجی فارسی.");
  const [preview, setPreview] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { void apiFetch("/settings/ai").then(async (response) => {
    if (!response.ok) throw new Error("دریافت تنظیمات ناموفق بود");
    const data = await response.json(); setProvider(data.provider); setModel(data.model); setConfigured(data.configured);
  }).catch((error) => setMessage(error.message)); }, []);
  const save = async () => {
    setBusy(true); setMessage("");
    try {
      const response = await apiFetch("/settings/ai", { method: "PUT", body: JSON.stringify({ provider, model, ...(token ? { token } : {}) }) });
      if (!response.ok) throw new Error("ثبت توکن یا مدل ناموفق بود");
      setToken(""); setConfigured(true); setMessage("✓ تنظیمات ذخیره شد؛ توکن دوباره نمایش داده نمی‌شود.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "خطا در ذخیره"); }
    finally { setBusy(false); }
  };
  const test = async () => {
    setBusy(true); setPreview(""); setMessage("در حال دریافت خروجی آزمایشی...");
    try { const response = await apiFetch("/settings/ai/test", { method: "POST", body: JSON.stringify({ text: sample }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.message ?? data.error);
      setPreview(data.text); setMessage("✓ اتصال برقرار است");
    } catch (error) { setMessage(error instanceof Error ? error.message : "آزمایش ناموفق بود"); }
    finally { setBusy(false); }
  };
  return <main className="settings-page"><Link href="/workflows/new">← بازگشت به میز کار</Link><h1>تنظیمات هوش مصنوعی</h1>
    <p>توکن در سرور رمزگذاری می‌شود و در مرورگر دوباره نمایش داده نمی‌شود.</p>
    <section className="settings-card"><label>سرویس<select value={provider} onChange={(event) => setProvider(event.target.value as typeof provider)}>
      <option value="openrouter">OpenRouter</option><option value="openai">OpenAI</option></select></label>
      <label>نام مدل<input dir="ltr" value={model} onChange={(event) => setModel(event.target.value)} placeholder={provider === "openrouter" ? "مثلاً openai/gpt-4o-mini" : "مثلاً gpt-4o-mini"} /></label>
      <label>API Token<input type="password" dir="ltr" autoComplete="new-password" value={token} onChange={(event) => setToken(event.target.value)}
        placeholder={configured ? "توکن قبلی محفوظ است؛ برای تغییر، توکن جدید وارد کن" : "توکن را وارد کن"} /></label>
      <button className="primary-button" onClick={() => void save()} disabled={busy || !model.trim() || (!configured && !token)}>ذخیره تنظیمات</button>
    </section>
    <section className="settings-card"><h2>آزمایش و پیش‌نمایش</h2><label>متن نمونه<textarea value={sample} onChange={(event) => setSample(event.target.value)} /></label>
      <button className="ghost-button" onClick={() => void test()} disabled={busy || !configured || sample.length < 10}>دریافت خروجی از مدل</button>
      {preview ? <div className="ai-preview" dir="rtl">{preview}</div> : null}</section>
    {message ? <p role="status">{message}</p> : null}
  </main>;
}
