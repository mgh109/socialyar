"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/session";
import { BrandLogo } from "../../components/brand-logo";
import { TopMenu } from "../../components/top-menu";

type Connection = { id: string; name: string; baseUrl: string; authType: string; headerName: string | null };

export default function ApiSettingsPage() {
  const [items, setItems] = useState<Connection[]>([]);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [authType, setAuthType] = useState("bearer");
  const [headerName, setHeaderName] = useState("X-API-Key");
  const [token, setToken] = useState("");
  const [testPath, setTestPath] = useState("/comments");
  const [message, setMessage] = useState("");
  const load = async () => { const response = await apiFetch("/api-connections");
    if (response.ok) setItems(await response.json()); else setMessage("فهرست اتصال‌ها بارگذاری نشد."); };
  useEffect(() => { void load(); }, []);
  const reset = () => { setId(""); setName(""); setBaseUrl(""); setToken(""); setAuthType("bearer"); setHeaderName("X-API-Key"); };
  const edit = (item: Connection) => { setId(item.id); setName(item.name); setBaseUrl(item.baseUrl);
    setAuthType(item.authType); setHeaderName(item.headerName ?? "X-API-Key"); setToken(""); setMessage(""); };
  const save = async () => {
    const response = await apiFetch(id ? `/api-connections/${id}` : "/api-connections", { method: id ? "PUT" : "POST",
      body: JSON.stringify({ name, baseUrl, authType, headerName: authType === "api_key" ? headerName : null,
        ...(token ? { token } : {}) }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { setMessage(`ذخیره ناموفق بود: ${body.error ?? response.status}`); return; }
    setMessage("اتصال ذخیره شد. توکن دوباره نمایش داده نمی‌شود."); reset(); await load();
  };
  const test = async (connectionId: string) => {
    const response = await apiFetch(`/api-connections/${connectionId}/test`, { method: "POST", body: JSON.stringify({ path: testPath }) });
    const data = await response.json().catch(() => ({}));
    setMessage(response.ok ? `اتصال برقرار است. نمونه: ${String(data.sample ?? "").slice(0, 200)}` :
      `آزمایش ناموفق: ${data.message ?? data.error ?? response.status}`);
  };
  const remove = async (item: Connection) => {
    if (!window.confirm(`اتصال «${item.name}» حذف شود؟`)) return;
    const response = await apiFetch(`/api-connections/${item.id}`, { method: "DELETE" });
    setMessage(response.ok ? "اتصال حذف شد." : "اتصال در یک جریان استفاده شده یا حذف ناموفق بود.");
    if (response.ok) { if (id === item.id) reset(); await load(); }
  };
  return <main className="workflow-page" dir="rtl"><header className="app-header"><div className="brand-lockup"><BrandLogo /><TopMenu />
    <Link href="/">میز کار</Link><span> / اتصال‌های API</span></div></header>
    <section className="settings-page"><h1>اتصال‌های API</h1><p>توکن روی سرور رمزگذاری می‌شود و فقط هنگام درخواست به همان میزبان ارسال می‌شود.</p>
      <div className="settings-card"><h2>{id ? "ویرایش اتصال" : "اتصال جدید"}</h2>
        <label>نام اتصال<input value={name} onChange={(event) => setName(event.target.value)} placeholder="سامانهٔ کامنت‌ها" /></label>
        <label>نشانی پایهٔ HTTPS<input dir="ltr" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com" /></label>
        <label>نوع توکن<select value={authType} onChange={(event) => setAuthType(event.target.value)}><option value="bearer">Bearer</option><option value="api_key">هدر X-API-Key</option></select></label>
        {authType === "api_key" ? <label>نام هدر<input dir="ltr" value={headerName} onChange={(event) => setHeaderName(event.target.value)} /></label> : null}
        <label>{id ? "توکن تازه (برای حفظ توکن قبلی خالی بگذار)" : "توکن"}<input type="password" autoComplete="new-password" value={token} onChange={(event) => setToken(event.target.value)} /></label>
        <button className="primary-button" type="button" onClick={() => void save()}>ذخیره اتصال</button>
        {id ? <button className="ghost-button" type="button" onClick={reset}>انصراف</button> : null}</div>
      <div className="settings-card"><h2>اتصال‌های ذخیره‌شده</h2>
        <label>مسیر آزمایش خواندنی (GET)<input dir="ltr" value={testPath} onChange={(event) => setTestPath(event.target.value)} /></label>
        {items.map((item) => <div key={item.id}><strong>{item.name}</strong> <span dir="ltr">{item.baseUrl}</span>
          <button type="button" onClick={() => edit(item)}>ویرایش</button>
          <button type="button" onClick={() => void test(item.id)}>آزمایش GET</button>
          <button type="button" onClick={() => void remove(item)}>حذف</button></div>)}
        {!items.length ? <p>اتصالی ثبت نشده است.</p> : null}</div>
      <p role="status">{message}</p></section></main>;
}
