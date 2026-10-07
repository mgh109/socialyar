"use client";
import { persianError } from "../lib/persian";
import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch } from "../lib/session";
import { protocolLabel } from "../lib/persian";

export type ConnectionPolicy = { mode: "direct" | "proxy" | "auto"; proxyId?: string };
export type ConnectionCheck = { id: string; target?: string; status: string; checkedAt: string | null;
  result: { reachable: boolean; responseMs?: number; error?: string; route?: string; proxyName?: string; authorizationVerified?: boolean; executor?: string } | null };
export type SavedProxy = { id: string; name: string; protocol: string; host: string; port: number; isActive: boolean; hasCredentials: boolean; checks?: ConnectionCheck[] };
export function useConnectionTest() {
  const [check, setCheck] = useState<ConnectionCheck | null>(null); const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const start = async (target: string, connection: ConnectionPolicy) => {
    setSubmitting(true); setError(""); setCheck(null);
    try {
      const response = await apiFetch("/connection-checks", { method: "POST", body: JSON.stringify({ target, connection }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.message ?? data.error ?? "ثبت بررسی اتصال ناموفق بود"); setCheck(data);
    } catch (err) { setError(persianError(err, "خطای بررسی اتصال")); } finally { setSubmitting(false); }
  };
  const pending = check?.status === "queued" || check?.status === "running";
  useEffect(() => {
    if (!pending || !check) return; let disposed = false;
    const poll = async () => {
      try { const response = await apiFetch(`/connection-checks/${check.id}`); if (!response.ok) throw new Error("دریافت نتیجهٔ بررسی ناموفق بود");
        const data = await response.json(); if (!disposed) { setCheck(data); setError(""); }
      } catch (err) { if (!disposed) setError(persianError(err, "خطای دریافت نتیجه")); }
    };
    void poll(); const interval = setInterval(() => void poll(), 2000);
    return () => { disposed = true; clearInterval(interval); };
  }, [check?.id, pending]);
  return { start, check, error, busy: submitting || pending };
}
export function ConnectionResult({ check, error }: { check?: ConnectionCheck | null; error?: string }) {
  return <div className="connection-result" role="status">
    {error ? <p>{error}</p> : null}
    {check?.status === "queued" ? <p>در صف بررسی توسط سرور انتشار…</p> : check?.status === "running" ? <p>در حال بررسی دسترسی به سرویس مقصد…</p> : null}
    {check?.result ? <><strong>{check.result.reachable ? "دسترسی به سرویس مقصد برقرار است" : "اتصال ناموفق"}</strong>
      <p>{check.result.route === "proxy" ? `پروکسی: ${check.result.proxyName ?? "انتخاب‌شده"}` : check.result.route === "direct" ? "اتصال مستقیم" : ""}
        {check.result.responseMs !== undefined ? ` · زمان پاسخ: ${check.result.responseMs.toLocaleString("fa-IR")} میلی‌ثانیه` : ""}</p>
      {check.result.error ? <p>{check.result.error}</p> : null}
      <p>آخرین بررسی: {check.checkedAt ? new Date(check.checkedAt).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" }) : "—"} · از سرور انتشار</p>
      {check.result.reachable ? <small>این نتیجه دسترسی شبکه را تأیید می‌کند. اتصال حساب و مجوزهای رسمی سرویس جداگانه بررسی می‌شوند.</small> : null}
    </> : null}
  </div>;
}
export function ConnectionSelector({ target, value, onChange }: { target: "youtube" | "telegram" | "instagram"; value: unknown; onChange: (value: ConnectionPolicy) => void }) {
  const [proxies, setProxies] = useState<SavedProxy[]>([]); const [loadError, setLoadError] = useState("");
  const test = useConnectionTest(); const policy = (value ?? { mode: "direct" }) as ConnectionPolicy;
  const load = async () => { try { const r = await apiFetch("/proxies"); if (!r.ok) throw new Error("دریافت پروکسی‌ها ناموفق بود"); setProxies(await r.json()); setLoadError(""); }
    catch (e) { setLoadError(persianError(e, "خطا")); } };
  useEffect(() => { void load(); }, []);
  return <section className="connection-selector"><strong>مسیر اتصال {({ youtube: "یوتیوب", telegram: "تلگرام", instagram: "اینستاگرام" })[target]}</strong>
    <label>نوع اتصال<select value={policy.mode} onChange={(e) => onChange({ mode: e.target.value as ConnectionPolicy["mode"], ...(e.target.value !== "direct" ? { proxyId: policy.proxyId ?? "" } : {}) })}>
      <option value="direct">اتصال مستقیم</option><option value="proxy">استفاده از پروکسی</option><option value="auto">خودکار؛ مستقیم، سپس پروکسی در صورت خطای اتصال</option></select></label>
    {policy.mode !== "direct" ? <label>پروکسی<select value={policy.proxyId ?? ""} onChange={(e) => onChange({ ...policy, proxyId: e.target.value })}>
      <option value="">انتخاب پروکسی</option>{proxies.filter((p) => p.isActive).map((p) => <option key={p.id} value={p.id}>{p.name} · {protocolLabel(p.protocol)}</option>)}</select></label> : null}
    <div><button type="button" disabled={test.busy || policy.mode !== "direct" && !policy.proxyId} onClick={() => void test.start(target, policy)}>بررسی اتصال</button>
      <button type="button" onClick={() => void load()}>به‌روزرسانی فهرست</button> <Link href="/settings/proxies" target="_blank">مدیریت پروکسی‌ها</Link></div>
    {loadError ? <p role="alert">{loadError}</p> : null}<ConnectionResult check={test.check} error={test.error} />
    {test.check?.result?.reachable === false && policy.mode === "direct" ? <button type="button" onClick={() => onChange({ mode: "proxy", proxyId: "" })}>انتخاب و تست پروکسی برای همین مقصد</button> : null}
  </section>;
}
