"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "../lib/session";
import { commentStates, type CommentReport } from "../lib/reports";
import { ReportsShell } from "./reports-shell";
import { CommentReportItem } from "./comment-report-row";
type Choice = { id: string; name: string };
export function CommentReports({
  initialWorkflowId = "",
}: {
  initialWorkflowId?: string;
}) {
  const [report, setReport] = useState<CommentReport | null>(null),
    [error, setError] = useState("");
  const [accountId, setAccountId] = useState(""),
    [workflowId, setWorkflowId] = useState(initialWorkflowId),
    [status, setStatus] = useState(""),
    [period, setPeriod] = useState("all");
  const [search, setSearch] = useState(""),
    [query, setQuery] = useState(""),
    [offset, setOffset] = useState(0),
    [refresh, setRefresh] = useState(0);
  const [accounts, setAccounts] = useState<Choice[]>([]),
    [workflows, setWorkflows] = useState<Choice[]>([]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(search.trim());
      setOffset(0);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      apiFetch("/social-accounts", { signal: controller.signal }),
      apiFetch("/workflows", { signal: controller.signal }),
    ])
      .then(async ([a, b]) => {
        if (a.ok) {
          const data = await a.json();
          if (!controller.signal.aborted)
            setAccounts(
              data
                .filter((row: { channel: string }) => row.channel === "youtube")
                .map(
                  (row: {
                    id: string;
                    displayName: string | null;
                    externalAccountId: string;
                  }) => ({
                    id: row.id,
                    name: row.displayName || row.externalAccountId,
                  }),
                ),
            );
        }
        if (b.ok) {
          const data = await b.json();
          if (!controller.signal.aborted)
            setWorkflows(
              data.map((row: Choice) => ({ id: row.id, name: row.name })),
            );
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    setReport(null);
    setError("");
    const load = async () => {
      if (loading) return;
      loading = true;
      const params = new URLSearchParams({
        limit: "25",
        offset: String(offset),
        period,
      });
      if (accountId) params.set("accountId", accountId);
      if (workflowId) params.set("workflowId", workflowId);
      if (status) params.set("status", status);
      if (query) params.set("q", query);
      try {
        const response = await apiFetch(
          `/analytics/youtube-comments?${params}`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error();
        const data: CommentReport = await response.json();
        if (!controller.signal.aborted) {
          setReport(data);
          setError("");
        }
      } catch {
        if (!controller.signal.aborted)
          setError("گزارش کامنت‌ها دریافت نشد؛ دوباره تلاش کنید.");
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
  }, [accountId, workflowId, status, period, query, offset, refresh]);
  const change = (setter: (value: string) => void, value: string) => {
    setter(value);
    setOffset(0);
  };
  return (
    <ReportsShell
      active="comments"
      title="کامنت‌ها و پاسخ‌های یوتیوب"
      description="کامنت‌های دریافت‌شده در جریان‌ها، پاسخ پیشنهادی یا ارسال‌شده و نتیجهٔ هر بررسی"
      actions={
        <button
          className="ghost-button"
          onClick={() => setRefresh((value) => value + 1)}
        >
          تازه‌سازی
        </button>
      }
    >
      <div className="report-filters comment-report-filters">
        <label>
          جست‌وجو
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="متن کامنت، پاسخ یا شناسهٔ ویدئو"
          />
        </label>
        <label>
          کانال
          <select
            value={accountId}
            onChange={(e) => change(setAccountId, e.target.value)}
          >
            <option value="">همه کانال‌های یوتیوب</option>
            {accounts.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          جریان
          <select
            value={workflowId}
            onChange={(e) => change(setWorkflowId, e.target.value)}
          >
            <option value="">همه جریان‌ها</option>
            {workflowId && !workflows.some((item) => item.id === workflowId) ? (
              <option value={workflowId}>جریان انتخاب‌شده</option>
            ) : null}
            {workflows.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          وضعیت
          <select
            value={status}
            onChange={(e) => change(setStatus, e.target.value)}
          >
            <option value="">همه وضعیت‌ها</option>
            {Object.entries(commentStates).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          بازهٔ دریافت
          <select
            value={period}
            onChange={(e) => change(setPeriod, e.target.value)}
          >
            <option value="all">همه زمان‌ها</option>
            <option value="7d">۷ روز اخیر</option>
            <option value="30d">۳۰ روز اخیر</option>
            <option value="90d">۹۰ روز اخیر</option>
          </select>
        </label>
      </div>
      {error ? (
        <p className="report-error" role="alert">
          {error}
        </p>
      ) : null}
      {report ? (
        <>
          <div className="metric-grid comment-report-metrics">
            {[
              ["کامنت‌های این گزارش", report.totals.total],
              ["پاسخ ارسال‌شده", report.totals.sent],
              ["قبلاً پاسخ داده شده", report.totals.alreadyReplied],
              ["منتظر تأیید", report.totals.waitingApproval],
              ["ناموفق", report.totals.failed],
            ].map(([label, value]) => (
              <article className="metric-card" key={label}>
                <span>{label}</span>
                <strong>{Number(value).toLocaleString("fa-IR")}</strong>
              </article>
            ))}
          </div>
          <div className="comment-report-list">
            {report.rows.length ? (
              report.rows.map((row) => (
                <CommentReportItem key={row.id} row={row} />
              ))
            ) : (
              <p className="empty-state">کامنتی با این فیلترها ثبت نشده است.</p>
            )}
          </div>
          <div className="report-pagination">
            <button
              className="ghost-button"
              disabled={offset === 0}
              onClick={() => setOffset((value) => Math.max(0, value - 25))}
            >
              صفحهٔ قبل
            </button>
            <span>
              {report.totals.total
                ? `${(offset + 1).toLocaleString("fa-IR")} تا ${(offset + report.rows.length).toLocaleString("fa-IR")} از ${report.totals.total.toLocaleString("fa-IR")}`
                : "۰ مورد"}
            </span>
            <button
              className="ghost-button"
              disabled={!report.hasMore}
              onClick={() => setOffset((value) => value + 25)}
            >
              صفحهٔ بعد
            </button>
          </div>
        </>
      ) : !error ? (
        <p className="empty-state" role="status">
          در حال دریافت کامنت‌ها…
        </p>
      ) : null}
    </ReportsShell>
  );
}
