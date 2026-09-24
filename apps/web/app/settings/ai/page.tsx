"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/session";

export default function AISettingsPage() {
  const [provider, setProvider] = useState<"openai" | "openrouter" | "gapgpt">("openrouter");
  const [model, setModel] = useState("");
  const [token, setToken] = useState("");
  const [configured, setConfigured] = useState(false);
  const [savedProvider, setSavedProvider] = useState<"openai" | "openrouter" | "gapgpt">("openrouter");
  const [sample, setSample] = useState("یک خبر نمونه برای بررسی اتصال هوش مصنوعی و نمایش خروجی فارسی.");
  const [preview, setPreview] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { void apiFetch("/settings/ai").then(async (response) => {
    if (!response.ok) throw new Error("دریافت تنظیمات ناموفق بود");
    const data = await response.json(); setProvider(data.provider); setSavedProvider(data.provider); setModel(data.model); setConfigured(data.configured);
  }).catch((error) => setMessage(error.message)); }, []);
  const save = async () => {
    setBusy(true); setMessage("");
    try {
      if (provider !== savedProvider && !token.trim()) throw new Error("برای تغییر سرویس، کلید API همان سرویس را وارد کن");
      const response = await apiFetch("/settings/ai", { method: "PUT", body: JSON.stringify({ provider, model, ...(token ? { token } : {}) }) });
      if (!response.ok) throw new Error("ثبت توکن یا مدل ناموفق بود");
      setToken(""); setConfigured(true); setSavedProvider(provider); setMessage("✓ تنظیمات ذخیره شد؛ توکن دوباره نمایش داده نمی‌شود.");
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
    <section className="settings-card"><label>سرویس<select value={provider} onChange={(event) => { const next = event.target.value as typeof provider; setProvider(next); setModel(next === "openrouter" ? "openai/gpt-4.1-mini" : next === "gapgpt" ? "gpt-4o" : "gpt-4.1-mini"); setToken(""); }}>
      <option value="openrouter">OpenRouter</option><option value="openai">OpenAI / ChatGPT API</option><option value="gapgpt">گپ‌جی‌پی‌تی (GapGPT)</option></select></label>
      {provider === "openai" ? <p>برای اتصال به مدل‌های ChatGPT، کلید API را از <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">پلتفرم OpenAI ↗</a> بگیر. اشتراک ChatGPT به‌تنهایی کلید API نیست.</p> : null}
      {provider === "gapgpt" ? <p>کلید API و نام مدل را از <a href="https://gapgpt.app/platform-v2/docs/quickstart" target="_blank" rel="noreferrer">مستندات گپ‌جی‌پی‌تی ↗</a> بردار. کلید OpenAI برای این سرویس قابل استفاده نیست.</p> : null}
      <label>نام مدل<input dir="ltr" value={model} onChange={(event) => setModel(event.target.value)} placeholder={provider === "openrouter" ? "مثلاً openai/gpt-4.1-mini" : provider === "gapgpt" ? "مثلاً gpt-4o" : "مثلاً gpt-4.1-mini"} /></label>
      <label>کلید API<input type="password" dir="ltr" autoComplete="new-password" value={token} onChange={(event) => setToken(event.target.value)}
        placeholder={configured && provider === savedProvider ? "کلید قبلی محفوظ است؛ برای تغییر، کلید جدید وارد کن" : "کلید API این سرویس را وارد کن"} /></label>
      <button className="primary-button" onClick={() => void save()} disabled={busy || !model.trim() || ((!configured || provider !== savedProvider) && !token.trim())}>ذخیره تنظیمات</button>
    </section>
    <section className="settings-card"><h2>آزمایش و پیش‌نمایش</h2><label>متن نمونه<textarea value={sample} onChange={(event) => setSample(event.target.value)} /></label>
      <button className="ghost-button" onClick={() => void test()} disabled={busy || !configured || provider !== savedProvider || sample.length < 10}>دریافت خروجی از مدل</button>
      {preview ? <div className="ai-preview" dir="rtl">{preview}</div> : null}</section>
    {message ? <p role="status">{message}</p> : null}
  </main>;
}
