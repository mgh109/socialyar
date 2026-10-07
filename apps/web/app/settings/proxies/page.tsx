"use client";
import { persianError } from "../../lib/persian";
import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/session";
import { BrandLogo } from "../../components/brand-logo";
import { TopMenu } from "../../components/top-menu";
import { ConnectionResult, useConnectionTest, type SavedProxy } from "../../components/connection-selector";
import { protocolLabel } from "../../lib/persian";
import { faDigits } from "../../lib/persian-calendar";

function ProxyRow({ proxy, edit, remove }: { proxy: SavedProxy; edit: () => void; remove: () => void }) {
  const [target, setTarget] = useState("youtube"); const test = useConnectionTest();
  return <article className="proxy-row"><strong>{proxy.name}</strong><span>{protocolLabel(proxy.protocol)} · <bdi>{proxy.host}</bdi> · پورت {faDigits(proxy.port)}</span>
    <span>{proxy.isActive ? "فعال" : "غیرفعال"} · {proxy.hasCredentials ? "دارای اطلاعات ورود" : "بدون اطلاعات ورود"}</span>
    <label>مقصد تست<select value={target} onChange={(e) => setTarget(e.target.value)}><option value="youtube">یوتیوب</option><option value="telegram">تلگرام</option><option value="instagram">اینستاگرام</option></select></label>
    <div><button type="button" disabled={!proxy.isActive || test.busy} onClick={() => void test.start(target, { mode: "proxy", proxyId: proxy.id })}>تست اتصال</button>
      <button type="button" onClick={edit}>ویرایش</button><button type="button" onClick={remove}>حذف</button></div>
    <ConnectionResult check={test.check?.target === target ? test.check : proxy.checks?.find((c) => c.target === target)} error={test.error} />
  </article>;
}
export default function ProxiesPage() {
  const [proxies, setProxies] = useState<SavedProxy[]>([]); const [id, setId] = useState(""); const [name, setName] = useState("");
  const [protocol, setProtocol] = useState("http"); const [host, setHost] = useState(""); const [port, setPort] = useState(8080);
  const [username, setUsername] = useState(""); const [password, setPassword] = useState(""); const [clearCredentials, setClearCredentials] = useState(false);
  const [active, setActive] = useState(true); const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  const load = async () => { const r = await apiFetch("/proxies"); if (!r.ok) throw new Error("دریافت پروکسی‌ها ناموفق بود"); setProxies(await r.json()); };
  useEffect(() => { void load().catch((e) => setMessage(persianError(e))); }, []);
  const reset = () => { setId(""); setName(""); setHost(""); setProtocol("http"); setPort(8080); setUsername(""); setPassword(""); setClearCredentials(false); setActive(true); };
  const edit = (p: SavedProxy) => { setId(p.id); setName(p.name); setHost(p.host); setProtocol(p.protocol); setPort(p.port); setActive(p.isActive); setUsername(""); setPassword(""); setClearCredentials(false); };
  const save = async () => {
    setBusy(true); setMessage("");
    try { const r = await apiFetch(id ? `/proxies/${id}` : "/proxies", { method: id ? "PATCH" : "POST", body: JSON.stringify({ name, protocol, host, port, isActive: active,
      ...(username ? { username } : {}), ...(password ? { password } : {}), clearCredentials }) }); const data = await r.json();
      if (!r.ok) throw new Error(data.message ?? data.error ?? "ذخیره ناموفق بود"); reset(); await load(); setMessage("پروکسی ذخیره شد.");
    } catch (e) { setMessage(persianError(e, "خطا")); } finally { setBusy(false); }
  };
  const remove = async (proxy: SavedProxy) => { setBusy(true); try { const r = await apiFetch(`/proxies/${proxy.id}`, { method: "DELETE" }); if (!r.ok) throw new Error("حذف ناموفق بود");
    if (id === proxy.id) reset(); await load(); setMessage("پروکسی حذف شد؛ کارت‌های وابسته باید پروکسی دیگری انتخاب کنند."); } catch (e) { setMessage(persianError(e, "خطا")); } finally { setBusy(false); } };
  return <main className="workflow-page"><header className="app-header"><div className="brand-lockup"><BrandLogo /><TopMenu /><span>تنظیمات پروکسی‌ها</span></div></header>
    <section className="settings-shell"><div className="settings-card"><h1>پروکسی‌ها</h1><p>مسیر اتصال هر کارت انتشار مستقل است. اطلاعات ورود در سرور رمزگذاری می‌شوند.</p>
      <label>نام دلخواه<input maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>نوع اتصال<select value={protocol} onChange={(e) => setProtocol(e.target.value)}><option value="http">اچ‌تی‌تی‌پی</option><option value="https">اچ‌تی‌تی‌پی امن</option><option value="socks5">ساکس ۵</option></select></label>
      <label>آدرس سرور<input dir="ltr" placeholder="proxy.example.com" value={host} onChange={(e) => setHost(e.target.value)} /></label>
      <label>پورت<input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value))} /></label>
      <label>نام کاربری اختیاری<input autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} placeholder={id ? "خالی: حفظ مقدار ذخیره‌شده" : ""} /></label>
      <label>رمز عبور اختیاری<input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={id ? "خالی: حفظ رمز ذخیره‌شده" : ""} /></label>
      {id ? <label><input type="checkbox" checked={clearCredentials} onChange={(e) => setClearCredentials(e.target.checked)} /> حذف اطلاعات ورود ذخیره‌شده</label> : null}
      <label><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> فعال</label>
      <button type="button" disabled={busy || !name.trim() || !host.trim() || !port} onClick={() => void save()}>ذخیره پروکسی</button>{id ? <button type="button" onClick={reset}>انصراف از ویرایش</button> : null}
    </div><div className="settings-card"><h2>پروکسی‌های ذخیره‌شده</h2>{proxies.map((p) => <ProxyRow key={`${p.id}-${p.protocol}-${p.host}-${p.port}-${p.isActive}`} proxy={p} edit={() => edit(p)} remove={() => void remove(p)} />)}
      {!proxies.length ? <p>پروکسی ذخیره نشده است.</p> : null}</div><p role="status">{message}</p></section></main>;
}
