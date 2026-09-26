"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/session";

const setupErrors: Record<string, string> = {
  secret_key_missing: "کلید رمزنگاری HOOR_SECRET_KEY روی سرویس API تنظیم نشده است. مدیر سامانه باید آن را روی API و worker با مقدار یکسان تنظیم کند.",
  secret_key_invalid: "مقدار HOOR_SECRET_KEY معتبر نیست؛ باید خروجی base64 مربوط به ۳۲ بایت تصادفی باشد.",
  ai_settings_migration_required: "جدول تنظیمات هوش مصنوعی در پایگاه داده وجود ندارد. مدیر سامانه باید migration شمارهٔ 0002 را اجرا کند.",
  ai_profiles_migration_required: "جدول مدل‌های هوش مصنوعی ساخته نشد. دسترسی ساخت جدول برای حساب دیتابیس API را بررسی کن یا migration شمارهٔ 0003_ai_profiles.sql را اجرا کن.",
  ai_profile_in_use: "این مدل در یک جریان استفاده می‌شود. ابتدا مدل آن کارت را تغییر بده.",
  token_required_for_provider: "برای تغییر سرویس، کلید API همان سرویس را وارد کن.",
};
type Profile = { id: string; name: string; provider: "openai" | "openrouter" | "gapgpt"; model: string };

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
  const [configurationProblem, setConfigurationProblem] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [profileName, setProfileName] = useState("");
  const [profileProvider, setProfileProvider] = useState<Profile["provider"]>("openrouter");
  const [profileModel, setProfileModel] = useState("openai/gpt-4.1-mini");
  const [profileToken, setProfileToken] = useState("");
  const [savedProfileProvider, setSavedProfileProvider] = useState<Profile["provider"]>("openrouter");
  const loadProfiles = async () => {
    const response = await apiFetch("/settings/ai/profiles");
    const data = await response.json();
    if (!response.ok) throw new Error(setupErrors[data.error] ?? "دریافت مدل‌ها ناموفق بود");
    setProfiles(data.profiles);
  };
  useEffect(() => { void apiFetch("/settings/ai").then(async (response) => {
    const data = await response.json();
    if (!response.ok) throw new Error(setupErrors[data.error] ?? "دریافت تنظیمات ناموفق بود");
    setProvider(data.provider); setSavedProvider(data.provider); setModel(data.model); setConfigured(data.configured);
    setConfigurationProblem(data.configurationProblem ?? null);
  }).catch((error) => setMessage(error.message)); void loadProfiles().catch((error) => setMessage(error.message)); }, []);
  const editProfile = (profile?: Profile) => {
    setEditingId(profile?.id ?? null); setProfileName(profile?.name ?? "");
    setProfileProvider(profile?.provider ?? "openrouter"); setSavedProfileProvider(profile?.provider ?? "openrouter");
    setProfileModel(profile?.model ?? "openai/gpt-4.1-mini"); setProfileToken(""); setPreview("");
  };
  const saveProfile = async () => {
    setBusy(true); setMessage("");
    try {
      if ((!editingId || profileProvider !== savedProfileProvider) && !profileToken.trim()) throw new Error("کلید API این سرویس را وارد کن.");
      const response = await apiFetch(editingId ? `/settings/ai/profiles/${editingId}` : "/settings/ai/profiles", {
        method: editingId ? "PUT" : "POST", body: JSON.stringify({ name: profileName, provider: profileProvider,
          model: profileModel, ...(profileToken ? { token: profileToken } : {}) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(setupErrors[data.error] ?? data.error ?? "ثبت مدل ناموفق بود");
      await loadProfiles(); editProfile(data); setMessage("✓ مدل ذخیره شد؛ کلید API دوباره نمایش داده نمی‌شود.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "ثبت مدل ناموفق بود"); }
    finally { setBusy(false); }
  };
  const deleteProfile = async (id: string) => {
    if (!window.confirm("این مدل حذف شود؟")) return;
    setBusy(true);
    try {
      const response = await apiFetch(`/settings/ai/profiles/${id}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(setupErrors[data.error] ?? data.error ?? "حذف ناموفق بود");
      await loadProfiles(); editProfile(); setMessage("مدل حذف شد.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "حذف ناموفق بود"); }
    finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setMessage("");
    try {
      if (provider !== savedProvider && !token.trim()) throw new Error("برای تغییر سرویس، کلید API همان سرویس را وارد کن");
      const response = await apiFetch("/settings/ai", { method: "PUT", body: JSON.stringify({ provider, model, ...(token ? { token } : {}) }) });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        if (setupErrors[data.error]) setConfigurationProblem(data.error);
        throw new Error(setupErrors[data.error] ?? `ثبت توکن یا مدل ناموفق بود (${response.status})`);
      }
      setToken(""); setConfigured(true); setSavedProvider(provider); setConfigurationProblem(null); setMessage("✓ تنظیمات ذخیره شد؛ توکن دوباره نمایش داده نمی‌شود.");
      await loadProfiles();
    } catch (error) { setMessage(error instanceof Error ? error.message : "خطا در ذخیره"); }
    finally { setBusy(false); }
  };
  const test = async () => {
    setBusy(true); setPreview(""); setMessage("در حال دریافت خروجی آزمایشی...");
    try { const response = await apiFetch("/settings/ai/test", { method: "POST", body: JSON.stringify({ text: sample,
      profileId: editingId ?? "default" }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.message ?? data.error);
      setPreview(data.text); setMessage("✓ اتصال برقرار است");
    } catch (error) { setMessage(error instanceof Error ? error.message : "آزمایش ناموفق بود"); }
    finally { setBusy(false); }
  };
  return <main className="settings-page"><Link href="/workflows/new">← بازگشت به میز کار</Link><h1>تنظیمات هوش مصنوعی</h1>
    <p>توکن در سرور رمزگذاری می‌شود و در مرورگر دوباره نمایش داده نمی‌شود.</p>
    {configurationProblem ? <p className="settings-setup-error" role="alert">{setupErrors[configurationProblem]}</p> : null}
    <section className="settings-card"><h2>مدل‌های قابل استفاده در جریان‌ها</h2>
      <p>برای هر کارت بازنویسی، یکی از مدل‌های زیر را انتخاب کن.</p>
      <div className="ai-profile-list">{profiles.map((profile) => <div key={profile.id}>
        <button type="button" onClick={() => { if (profile.id === "default") {
          document.getElementById("ai-default-settings")?.scrollIntoView({ behavior: "smooth" });
        } else editProfile(profile); }}><strong>{profile.name}</strong><small>{profile.provider} · {profile.model}</small></button>
        {profile.id !== "default" ? <button type="button" className="ai-profile-delete" onClick={() => void deleteProfile(profile.id)} disabled={busy}>حذف</button> : null}
      </div>)}</div>
      <h2>{editingId ? "ویرایش مدل" : "افزودن مدل"}</h2>
      <label>نام دلخواه<input value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder="مثلاً خبر فوری / GPT-4o" /></label>
      <label>سرویس<select value={profileProvider} onChange={(event) => {
        const next = event.target.value as Profile["provider"]; setProfileProvider(next);
        setProfileModel(next === "openrouter" ? "openai/gpt-4.1-mini" : next === "gapgpt" ? "gpt-4o" : "gpt-4.1-mini");
      }}><option value="openrouter">OpenRouter</option><option value="openai">OpenAI / ChatGPT API</option><option value="gapgpt">GapGPT</option></select></label>
      <label>نام مدل<input dir="ltr" value={profileModel} onChange={(event) => setProfileModel(event.target.value)} /></label>
      <label>کلید API<input type="password" dir="ltr" autoComplete="new-password" value={profileToken}
        onChange={(event) => setProfileToken(event.target.value)} placeholder={editingId ? "کلید قبلی محفوظ است؛ برای تغییر کلید جدید وارد کن" : "کلید API"} /></label>
      <div className="ai-profile-actions"><button className="primary-button" onClick={() => void saveProfile()} disabled={busy || !profileName.trim() || !profileModel.trim() || ((!editingId || profileProvider !== savedProfileProvider) && !profileToken.trim())}>{editingId ? "ذخیره مدل" : "افزودن مدل"}</button>
        {editingId ? <button className="ghost-button" onClick={() => editProfile()}>مدل جدید</button> : null}</div>
    </section>
    <section id="ai-default-settings" className="settings-card"><h2>تنظیم پیش‌فرض جریان‌های قدیمی</h2><label>سرویس<select value={provider} onChange={(event) => { const next = event.target.value as typeof provider; setProvider(next); setModel(next === "openrouter" ? "openai/gpt-4.1-mini" : next === "gapgpt" ? "gpt-4o" : "gpt-4.1-mini"); setToken(""); }}>
      <option value="openrouter">OpenRouter</option><option value="openai">OpenAI / ChatGPT API</option><option value="gapgpt">گپ‌جی‌پی‌تی (GapGPT)</option></select></label>
      {provider === "openai" ? <p>برای اتصال به مدل‌های ChatGPT، کلید API را از <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">پلتفرم OpenAI ↗</a> بگیر. اشتراک ChatGPT به‌تنهایی کلید API نیست.</p> : null}
      {provider === "gapgpt" ? <p>کلید API و نام مدل را از <a href="https://gapgpt.app/platform-v2/docs/quickstart" target="_blank" rel="noreferrer">مستندات گپ‌جی‌پی‌تی ↗</a> بردار. کلید OpenAI برای این سرویس قابل استفاده نیست.</p> : null}
      <label>نام مدل<input dir="ltr" value={model} onChange={(event) => setModel(event.target.value)} placeholder={provider === "openrouter" ? "مثلاً openai/gpt-4.1-mini" : provider === "gapgpt" ? "مثلاً gpt-4o" : "مثلاً gpt-4.1-mini"} /></label>
      <label>کلید API<input type="password" dir="ltr" autoComplete="new-password" value={token} onChange={(event) => setToken(event.target.value)}
        placeholder={configured && provider === savedProvider ? "کلید قبلی محفوظ است؛ برای تغییر، کلید جدید وارد کن" : "کلید API این سرویس را وارد کن"} /></label>
      <button className="primary-button" onClick={() => void save()} disabled={busy || !model.trim() || ((!configured || provider !== savedProvider) && !token.trim())}>ذخیره تنظیمات</button>
    </section>
    <section className="settings-card"><h2>آزمایش و پیش‌نمایش</h2><label>متن نمونه<textarea value={sample} onChange={(event) => setSample(event.target.value)} /></label>
      <button className="ghost-button" onClick={() => void test()} disabled={busy || sample.length < 10 || (editingId ? profileProvider !== savedProfileProvider : !configured || provider !== savedProvider)}>دریافت خروجی از {editingId ? profileName : "مدل پیش‌فرض"}</button>
      {preview ? <div className="ai-preview" dir="rtl">{preview}</div> : null}</section>
    {message ? <p role="status">{message}</p> : null}
  </main>;
}
