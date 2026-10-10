"use client";

import { WorkflowApprovalCard, type WorkflowApproval } from "./workflow-approval-card";
import { BrandLogo } from "./brand-logo";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/session";
import { ConnectionHistory } from "./connection-history";
import { statusLabel, persianError } from "../lib/persian";
import { faDigits } from "../lib/persian-calendar";

type RunData = {
  id: string;
  status: string;
  workflowId?: string;
  processingSummary?: { status: string; completedSteps: number; failedSteps: number; hasDraft: boolean };
  publicationSummary?: { published: number; queued: number; publishing: number; waitingApproval: number; failed: number; unknown: number;
    items: Array<{ id: string; channel: string; status: string; externalUrl: string | null; error: string | null; deliveryUnknown: boolean }> };
  createdAt?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
};

type RunEvent = {
  id: string;
  type: string;
  message: string | null;
  createdAt: string;
  payload: Record<string, unknown>;
};

const labels: Record<string, string> = {
  run_started: "شروع اجرا",
  step_started: "شروع مرحله",
  step_completed: "مرحله انجام شد",
  step_failed: "خطای مرحله",
  retry: "تلاش مجدد",
  fallback: "تغییر مسیر جایگزین",
  approval_requested: "نیاز به تأیید انسانی",
  approval_resolved: "تأیید انجام شد",
  run_completed: "اجرای کامل شد",
  run_failed: "اجرای ناموفق",
};

export function RunLive({ runId }: { runId: string }) {
  const [run, setRun] = useState<RunData | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [steps, setSteps] = useState<Array<{ key: string; name: string; type: string; status: string | null;
    output: NonNullable<WorkflowApproval["output"]> & {
      feedback?: { positive: number; negative: number; neutral: number; total: number; themes: string[] } } | null;
    error: { message?: string } | null; attempt: number | null }>>([]);
  const [connected, setConnected] = useState(false);
  const [pollError, setPollError] = useState("");
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  const resolve = async (item: WorkflowApproval, action: "approve" | "reject", edit?: { title?: string; text?: string; reply?: string }) => {
    if (action === "reject" && !window.confirm("این شاخه رد شود؟ محتوا از این مسیر منتشر نمی‌شود.")) return;
    setActionBusy(true);
    setActionError("");
    try {
      const response = await apiFetch(`/runs/${runId}/approval`, {
        method: "POST", body: JSON.stringify({ action, stepKey: item.stepKey, edit }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(persianError(body.error, `تصمیم ثبت نشد (${response.status})`));
      }
      const result = await response.json() as { status: string };
      setRun((current) => current ? { ...current, status: result.status } : current);
    } catch (error) {
      setActionError(persianError(error, "خطا در ثبت تصمیم"));
    } finally { setActionBusy(false); setRefreshKey((value) => value + 1); }
  };

  useEffect(() => {
    let active = true;
    let fetching = false;
    const controller = new AbortController();
    const refresh = async () => {
      if (fetching || document.visibilityState === "hidden") return;
      fetching = true;
      try {
        const [runResponse, eventResponse, stepsResponse] = await Promise.all([
          apiFetch(`/runs/${runId}`, { signal: controller.signal }),
          apiFetch(`/runs/${runId}/events`, { signal: controller.signal }),
          apiFetch(`/runs/${runId}/steps`, { signal: controller.signal }),
        ]);
        if (!runResponse.ok || !eventResponse.ok || !stepsResponse.ok) throw new Error("دریافت وضعیت اجرا ناموفق بود؛ اطلاعات نمایش‌داده‌شده ممکن است قدیمی باشد.");
        const [nextRun, nextEvents] = await Promise.all([
          runResponse.json() as Promise<RunData>,
          eventResponse.json() as Promise<RunEvent[]>,
        ]);
        const nextSteps = await stepsResponse.json();
        if (active) {
          setRun(nextRun);
          setEvents(nextEvents);
          setSteps(nextSteps);
          setLastUpdated(Date.now());
          setPollError("");
          setConnected(true);
        }
      } catch (error) {
        if (active) { setConnected(false); setPollError(persianError(error, "دریافت وضعیت اجرا ناموفق بود؛ اطلاعات نمایش‌داده‌شده ممکن است قدیمی باشد.")); }
      } finally { fetching = false; }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 2000);
    const onVisibility = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      controller.abort();
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(interval);
    };
  }, [runId, refreshKey]);

  const progress = useMemo(() => steps.filter((step) => step.status === "completed").length, [steps]);

  const canOpenStudio = run?.processingSummary?.hasDraft === true;

  return (
    <main className="workflow-page">
      <header className="app-header">
        <div className="brand-lockup">
          <BrandLogo />
          <span>اجرای جریان</span>
        </div>
        <div className="header-actions">
          <span className={connected ? "live-dot online" : "live-dot"} />
          <span className="save-status">
            {connected ? "اطلاعات به‌روز" : pollError ? "ارتباط قطع شده" : "در حال اتصال..."}
          </span>
          <Link className="ghost-link" href={run?.workflowId ? `/workflows/new?id=${run.workflowId}` : "/"}>
            ← بازگشت به جریان
          </Link>
        </div>
      </header>

      <section className="run-layout">
        <div className="run-main">
          {pollError ? <p role="alert" className="run-step-error">{pollError} <button className="ghost-button" onClick={() => setRefreshKey((value) => value + 1)}>تلاش دوباره</button></p> : null}
          {lastUpdated ? <p className="save-status">آخرین دریافت: {new Date(lastUpdated).toLocaleTimeString("fa-IR", { timeZone: "Asia/Tehran" })} · به وقت تهران</p> : null}
          <ConnectionHistory runId={runId} />
          <div className="canvas-title">
            <div>
              <h1>اجرای جاری</h1>
              <p>
                شناسه اجرا: {runId.slice(0, 8)} · وضعیت: {statusLabel(run?.processingSummary?.status ?? run?.status)}
              </p>
            </div>
            <span className="status-pill">{faDigits(progress)} از {faDigits(steps.length)} مرحله</span>
          </div>

          <div className="execution-strip">
            {steps.map(({ name, key, status, error, attempt }) => {
              const completed = status === "completed";
              const active = status === "running";
              return (
                <article
                  className={`execution-node ${completed ? "done" : ""} ${active ? "active" : ""}`}
                  key={key}
                >
                  <h3>{name}</h3>
                  <span>
                    {completed ? "✓ انجام شد" : status === "skipped" ? "○ عبور نکرد" :
                      status === "failed" ? "! خطا" : status === "retrying" ? `↻ تلاش دوباره ${attempt ?? ""}/۳` :
                      status === "waiting_approval" ? "در انتظار تأیید شما" : active ? "↻ در حال اجرا" : "○ منتظر"}
                  </span>
                  {status === "failed" && error?.message ? <p className="run-step-error" role="alert">{error.message}</p> : null}
                </article>
              );
            })}
          </div>

          <section className="workflow-approval-section" aria-label="بررسی کامل و تأیید خروجی">
            <div className="workflow-approval-grid">{steps.filter((step) => step.status === "waiting_approval").map((step) => (
              <WorkflowApprovalCard key={`${runId}-${step.key}`} item={{ runId, stepKey: step.key, stepName: step.name,
                workflowName: "اجرای جاری", output: step.output, createdAt: null }} busy={actionBusy || !connected || run?.status !== "waiting_approval"} resolve={resolve} />
            ))}</div>
            {actionError ? <p role="alert">{actionError}</p> : null}
          </section>

          {steps.filter((step) => step.status === "completed" && step.output?.feedback).map((step) => (
            <div className="run-output-ready" key={`feedback-${step.key}`}>
              <div><strong>تحلیل بازخورد · {step.output!.feedback!.total.toLocaleString("fa-IR")} کامنت</strong>
                <span>مثبت: {step.output!.feedback!.positive.toLocaleString("fa-IR")} · منفی: {step.output!.feedback!.negative.toLocaleString("fa-IR")} · خنثی: {step.output!.feedback!.neutral.toLocaleString("fa-IR")}</span>
                <p style={{ whiteSpace: "pre-wrap" }}>{step.output?.text}</p></div>
            </div>
          ))}

          {run?.publicationSummary ? <section className="run-output-ready" aria-label="وضعیت انتشار در مقصدها">
            <div><strong>نتیجه انتشار در مقصدها</strong><p>پایان پردازش جریان به معنی انتشار موفق نیست. وضعیت هر مقصد را در این فهرست ببینید.</p>
              {run.publicationSummary.items.length ? run.publicationSummary.items.map((item) => <article key={item.id}>
                <strong>{({ eitaa: "ایتا", telegram: "تلگرام", instagram: "اینستاگرام", youtube: "یوتیوب", website: "وب‌سایت", bale: "بله", x: "ایکس" } as Record<string, string>)[item.channel] ?? "مقصد انتشار"}</strong>
                <p>{item.deliveryUnknown ? "نتیجه ارسال نامعلوم؛ پیش از ارسال دوباره، مقصد را بررسی کنید." : statusLabel(item.status)}</p>
                {item.error ? <p role="alert">{persianError(item.error, "انتشار ناموفق بود؛ وضعیت مقصد را بررسی کنید.")}</p> : null}
                {item.status === "published" && item.externalUrl ? <a className="ghost-link" href={item.externalUrl} target="_blank" rel="noreferrer">مشاهده در مقصد</a> : null}
              </article>) : <p>هنوز آیتمی در صف انتشار این اجرا ثبت نشده است.</p>}
              <Link className="ghost-link" href="/calendar">بررسی صف و تقویم انتشار</Link>
            </div>
          </section> : null}

          {canOpenStudio ? (
            <div className="run-output-ready">
              <div>
                <strong>✓ پیش‌نویس محتوا ساخته شده و قابل ویرایش است</strong>
                <span>شناسه اجرا: {runId.slice(0, 8)} · استودیوی محتوا</span>
              </div>
              <Link
                className="primary-link"
                href={`/content-studio/${runId}`}
              >
                باز کردن در استودیوی محتوا
              </Link>
            </div>
          ) : null}

          <div className="current-detail">
            <div>
              <span className="micro-label">وضعیت اجرا</span>
              <strong>{statusLabel(run?.processingSummary?.status ?? run?.status ?? "queued")}</strong>
            </div>
            <div>
              <span className="micro-label">رویداد ثبت‌شده</span>
              <strong>{events.length}</strong>
            </div>
            <div>
              <span className="micro-label">مرحله کامل</span>
              <strong>{progress} / {steps.length}</strong>
            </div>
          </div>
        </div>

        <aside className="event-panel">
          <div className="event-header">
            <h2>گزارش زنده اجرا</h2>
            <p>هر مرحله، تصمیم و خروجی همین‌جا ثبت می‌شود.</p>
          </div>

          <div className="event-list">
            {events.length === 0 ? (
              <div className="empty-state">منتظر اولین رویداد…</div>
            ) : (
              [...events].reverse().map((event) => (
                <article className="event-row" key={event.id}>
                  <div className="event-marker" />
                  <div>
                    <div className="event-title">
                      <strong>{labels[event.type] ?? event.type}</strong>
                      <time>
                        {new Date(event.createdAt).toLocaleTimeString("fa-IR", { timeZone: "Asia/Tehran" })}
                      </time>
                    </div>
                    <p>{event.message ?? "بدون توضیح"}</p>
                  </div>
                </article>
              ))
            )}
          </div>
        </aside>
      </section>
    </main>
  );
}
