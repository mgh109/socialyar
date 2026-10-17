"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "../lib/session";
import { ImageUsageSummary } from "./image-usage-summary";
import { ReportsShell } from "./reports-shell";
type UsageMetrics = {
  requests: number;
  inputTokens: number | string;
  outputTokens: number | string;
  costMicros: number | string;
  unreportedTokens: number;
  unreportedCost: number;
};
type AIUsageReport = {
  period: string;
  totals: UsageMetrics;
  byWorkflow: Array<
    UsageMetrics & { workflowId: string | null; workflowName: string | null }
  >;
  byModel: Array<UsageMetrics & { provider: string; model: string }>;
};
const usageNumber = (value: number | string) =>
  Number(value).toLocaleString("fa-IR");
const usageCost = (value: number | string) =>
  (Number(value) / 1_000_000).toLocaleString("fa-IR", {
    maximumFractionDigits: 4,
  });

export function AIUsageReport() {
  const [usage, setUsage] = useState<AIUsageReport | null>(null);
  const [usagePeriod, setUsagePeriod] = useState("30d");
  const [usageError, setUsageError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const response = await apiFetch(
          `/analytics/ai-usage?period=${usagePeriod}`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (!controller.signal.aborted) {
          setUsage(data);
          setUsageError("");
        }
      } catch {
        if (!controller.signal.aborted)
          setUsageError("گزارش مصرف دریافت نشد؛ دوباره تلاش کنید.");
      } finally {
        loading = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [usagePeriod]);
  return (
    <ReportsShell
      active="usage"
      title="مصرف هوش مصنوعی"
      description="مصرف ثبت‌شدهٔ متن و تصویر به تفکیک جریان و مدل"
    >
      <section className="channel-performance ai-usage-section">
        <div className="section-title-row">
          <div>
            <h2>مصرف هوش مصنوعی</h2>
            <p>
              بر پایهٔ پاسخ واقعی سرویس؛ هر درخواست پس از پاسخ ثبت می‌شود و این
              بخش هر ۳۰ ثانیه تازه می‌شود.
            </p>
          </div>
          <select
            className="history-filter"
            aria-label="بازهٔ مصرف هوش مصنوعی"
            value={usagePeriod}
            onChange={(event) => setUsagePeriod(event.target.value)}
          >
            <option value="7d">۷ روز اخیر</option>
            <option value="30d">۳۰ روز اخیر</option>
            <option value="90d">۹۰ روز اخیر</option>
            <option value="all">همهٔ زمان‌ها</option>
          </select>
        </div>
        <ImageUsageSummary period={usagePeriod} />
        {usageError && <p role="alert">{usageError}</p>}
        {usage && (
          <>
            <div className="metric-grid ai-usage-grid">
              <article className="metric-card">
                <span>درخواست‌های AI</span>
                <strong>{usageNumber(usage.totals.requests)}</strong>
              </article>
              <article className="metric-card">
                <span>توکن ورودی</span>
                <strong>{usageNumber(usage.totals.inputTokens)}</strong>
              </article>
              <article className="metric-card">
                <span>توکن خروجی</span>
                <strong>{usageNumber(usage.totals.outputTokens)}</strong>
              </article>
              <article className="metric-card">
                <span>هزینهٔ گزارش‌شده (دلار)</span>
                <strong>${usageCost(usage.totals.costMicros)}</strong>
              </article>
            </div>
            {(usage.totals.unreportedTokens > 0 ||
              usage.totals.unreportedCost > 0) && (
              <p className="usage-caveat">
                {usageNumber(usage.totals.unreportedTokens)} درخواست بدون آمار
                کامل توکن و {usageNumber(usage.totals.unreportedCost)} درخواست
                بدون هزینهٔ گزارش‌شده است؛ مبلغ بالا کل هزینهٔ قطعی نیست.
              </p>
            )}
            <div className="usage-breakdown">
              <div>
                <h3>مصرف هر جریان</h3>
                {usage.byWorkflow.length ? (
                  usage.byWorkflow.map((row) => (
                    <div
                      className="usage-row"
                      key={row.workflowId ?? "preview"}
                    >
                      <span>
                        {row.workflowName ??
                          (row.workflowId ? "جریان حذف‌شده" : "آزمون اتصال AI")}
                      </span>
                      <span>
                        {usageNumber(row.requests)} درخواست ·{" "}
                        {usageNumber(
                          Number(row.inputTokens) + Number(row.outputTokens),
                        )}{" "}
                        توکن
                      </span>
                      <span>
                        {row.unreportedCost ? "هزینهٔ ناقص · " : ""}$
                        {usageCost(row.costMicros)}
                      </span>
                    </div>
                  ))
                ) : (
                  <p>هنوز مصرفی ثبت نشده است.</p>
                )}
              </div>
              <div>
                <h3>مصرف هر مدل</h3>
                {usage.byModel.length ? (
                  usage.byModel.map((row) => (
                    <div
                      className="usage-row"
                      key={`${row.provider}:${row.model}`}
                    >
                      <span dir="ltr">
                        {row.provider} / {row.model}
                      </span>
                      <span>
                        {usageNumber(row.requests)} درخواست ·{" "}
                        {usageNumber(
                          Number(row.inputTokens) + Number(row.outputTokens),
                        )}{" "}
                        توکن
                      </span>
                      <span>
                        {row.unreportedCost ? "هزینهٔ ناقص · " : ""}$
                        {usageCost(row.costMicros)}
                      </span>
                    </div>
                  ))
                ) : (
                  <p>هنوز مصرفی ثبت نشده است.</p>
                )}
              </div>
            </div>
          </>
        )}
      </section>
    </ReportsShell>
  );
}
