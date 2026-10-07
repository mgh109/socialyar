"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "../lib/session";

type Event = { id: string; route: string; proxyName: string | null; result: string; error: string | null; createdAt: string };
const labels: Record<string,string> = { connected: "پاسخ سرویس دریافت شد", published: "منتشر شد", failed: "خطا", delivery_unknown: "نتیجه ارسال نامشخص؛ نیازمند بررسی مقصد", network_error: "خطای شبکه", fallback_selected: "انتخاب پروکسی پس از خطای مستقیم" };
export function ConnectionHistory({ publicationId, youtubeItemId, runId, timezone = "Asia/Tehran" }: { publicationId?: string; youtubeItemId?: string; runId?: string; timezone?: string }) {
  const [events, setEvents] = useState<Event[]>([]); const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false; const params = new URLSearchParams({ ...(publicationId ? { publicationId } : {}), ...(youtubeItemId ? { youtubeItemId } : {}), ...(runId ? { runId } : {}) });
    const refresh = async () => { try { const r = await apiFetch(`/publication-connection-events?${params}`); if (!r.ok) throw new Error("گزارش مسیر اتصال دریافت نشد"); const data = await r.json(); if (!disposed) { setEvents(data); setError(""); } }
      catch (e) { if (!disposed) setError(e instanceof Error ? e.message : "خطا"); } };
    void refresh(); const timer = setInterval(() => void refresh(), 10000); return () => { disposed = true; clearInterval(timer); };
  }, [publicationId, youtubeItemId, runId]);
  return <details className="connection-history"><summary>گزارش مسیر اتصال</summary>{error ? <p role="alert">{error}</p> : null}
    {events.map((e) => <p key={e.id}>{new Date(e.createdAt).toLocaleString("fa-IR", { timeZone: timezone })} · {e.route === "proxy" ? `پروکسی: ${e.proxyName}` : "مستقیم"} · {labels[e.result] ?? (e.result.startsWith("destination_http_") ? `کد پاسخ مقصد: ${e.result.slice(17).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)])}` : "تغییر وضعیت اتصال")}{e.error ? ` · ${e.error}` : ""}</p>)}
    {!events.length && !error ? <p>هنوز گزارشی ثبت نشده است.</p> : null}</details>;
}
