"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "../lib/session";
import { persianError } from "../lib/persian";
import {
  publicationActionPath,
  publicationStates,
  reportChannels,
  type PublicationRow,
} from "../lib/reports";
import { ReportsShell } from "./reports-shell";
import { PublicationReportRow } from "./publication-report-row";
type Summary = {
  totals: {
    total: number;
    published: number;
    failed: number;
    queued: number;
    successRate: number;
    totalAttempts: number;
  };
  byChannel: Array<{
    channel: string;
    total: number;
    published: number;
    failed: number;
    attempts: number;
    successRate: number;
  }>;
  events: Array<{ type: string; value: number }>;
};
export function AnalyticsDashboard() {
  const [summary, setSummary] = useState<Summary | null>(null),
    [rows, setRows] = useState<PublicationRow[]>([]);
  const [status, setStatus] = useState(""),
    [channel, setChannel] = useState(""),
    [search, setSearch] = useState("");
  const [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [refresh, setRefresh] = useState(0),
    [busy, setBusy] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const [a, b] = await Promise.all([
          apiFetch("/analytics/summary", { signal: controller.signal }),
          apiFetch("/publications", { signal: controller.signal }),
        ]);
        if (!a.ok || !b.ok) throw new Error();
        const [nextSummary, nextRows] = await Promise.all([a.json(), b.json()]);
        if (!controller.signal.aborted) {
          setSummary(nextSummary);
          setRows(nextRows);
          setError("");
        }
      } catch {
        if (!controller.signal.aborted)
          setError("گزارش انتشار دریافت نشد؛ دوباره تلاش کنید.");
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [refresh]);
  const act = async (row: PublicationRow, action: "retry" | "cancel") => {
    if (
      action === "cancel" &&
      !window.confirm("این محتوا از صف انتشار خارج شود؟")
    )
      return;
    setBusy(row.publication.id);
    setMessage("");
    try {
      const response = await apiFetch(publicationActionPath(row, action), {
        method: "POST",
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          persianError(data.error, "تغییر وضعیت انتشار انجام نشد."),
        );
      setRefresh((value) => value + 1);
      setMessage(
        action === "retry"
          ? "بررسی و ادامهٔ همین محتوا در صف قرار گرفت."
          : "انتشار لغو شد.",
      );
    } catch (e) {
      setMessage(persianError(e));
    } finally {
      setBusy("");
    }
  };
  const query = search.trim().toLocaleLowerCase();
  const filtered = rows.filter(
    (row) =>
      (!status || row.publication.status === status) &&
      (!channel || row.variant.channel === channel) &&
      (!query ||
        `${row.variant.title} ${row.content.title} ${row.youtube?.accountName ?? ""} ${row.youtube?.workflowName ?? ""}`
          .toLocaleLowerCase()
          .includes(query)),
  );
  return (
    <ReportsShell
      active="publications"
      title="گزارش انتشار ویدئو و محتوا"
      description="انتشارهای همهٔ کانال‌ها، شامل ویدئوهای یوتیوب؛ وضعیت‌ها هر ۱۵ ثانیه تازه می‌شوند."
      actions={
        <button
          className="ghost-button"
          onClick={() => setRefresh((value) => value + 1)}
        >
          تازه‌سازی
        </button>
      }
    >
      {error ? (
        <p role="alert" className="report-error">
          {error}
        </p>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      {summary ? (
        <>
          <div className="metric-grid">
            {[
              ["کل انتشارها", summary.totals.total],
              ["موفق", summary.totals.published],
              ["ناموفق", summary.totals.failed],
              ["در صف / در حال انتشار", summary.totals.queued],
              [
                "نرخ موفقیت",
                `${summary.totals.successRate.toLocaleString("fa-IR")}٪`,
              ],
              ["کل تلاش‌ها", summary.totals.totalAttempts],
            ].map(([label, value], index) => (
              <article
                className={`metric-card ${index === 1 ? "success" : index === 2 ? "danger" : ""}`}
                key={label}
              >
                <span>{label}</span>
                <strong>
                  {typeof value === "number"
                    ? value.toLocaleString("fa-IR")
                    : value}
                </strong>
              </article>
            ))}
          </div>
          <section className="history-section">
            <div className="section-title-row">
              <h2>تاریخچه انتشار</h2>
              <small>{filtered.length.toLocaleString("fa-IR")} مورد</small>
            </div>
            <div className="report-filters">
              <label>
                جست‌وجو
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="عنوان ویدئو، کانال یا جریان"
                />
              </label>
              <label>
                کانال
                <select
                  value={channel}
                  onChange={(e) => setChannel(e.target.value)}
                >
                  <option value="">همه کانال‌ها</option>
                  {Object.entries(reportChannels).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                وضعیت
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                >
                  <option value="">همه وضعیت‌ها</option>
                  {Object.entries(publicationStates).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="history-list">
              {filtered.length ? (
                filtered.map((row) => (
                  <PublicationReportRow
                    key={`${row.kind}:${row.publication.id}`}
                    row={row}
                    busy={busy === row.publication.id}
                    act={(item, action) => void act(item, action)}
                  />
                ))
              ) : (
                <p className="empty-state">
                  انتشاری با این فیلترها وجود ندارد.
                </p>
              )}
            </div>
          </section>
          <section className="channel-performance">
            <div className="section-title-row">
              <h2>عملکرد کانال‌ها</h2>
            </div>
            <div className="channel-performance-grid">
              {summary.byChannel.map((item) => (
                <article
                  key={item.channel}
                  className="channel-performance-card"
                >
                  <div className="channel-performance-head">
                    <strong>
                      {reportChannels[item.channel] ?? item.channel}
                    </strong>
                    <span>
                      {item.successRate.toLocaleString("fa-IR")}٪ موفق
                    </span>
                  </div>
                  <div className="performance-bar">
                    <span style={{ width: `${item.successRate}%` }} />
                  </div>
                  <dl>
                    {[
                      ["کل", item.total],
                      ["موفق", item.published],
                      ["ناموفق", item.failed],
                      ["تلاش‌ها", item.attempts],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{Number(value).toLocaleString("fa-IR")}</dd>
                      </div>
                    ))}
                  </dl>
                </article>
              ))}
            </div>
          </section>
          {summary.events.length ? (
            <section className="event-summary">
              <div className="section-title-row">
                <h2>رویدادهای تعامل</h2>
              </div>
              <div className="event-metric-grid">
                {summary.events.map((event) => (
                  <article key={event.type} className="event-metric-card">
                    <span>{event.type}</span>
                    <strong>{event.value.toLocaleString("fa-IR")}</strong>
                  </article>
                ))}
              </div>
            </section>
          ) : null}
        </>
      ) : !error ? (
        <p className="empty-state" role="status">
          در حال دریافت گزارش انتشار…
        </p>
      ) : null}
    </ReportsShell>
  );
}
