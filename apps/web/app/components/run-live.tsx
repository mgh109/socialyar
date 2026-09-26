"use client";

import { BrandLogo } from "./brand-logo";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/session";

type RunData = {
  id: string;
  status: string;
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
  fallback: "Fallback",
  approval_requested: "نیاز به تأیید انسانی",
  approval_resolved: "تأیید انجام شد",
  run_completed: "اجرای کامل شد",
  run_failed: "اجرای ناموفق",
};

export function RunLive({ runId }: { runId: string }) {
  const [run, setRun] = useState<RunData | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [steps, setSteps] = useState<Array<{ key: string; name: string; type: string; status: string | null;
    output: { text?: string } | null; error: { message?: string } | null; attempt: number | null }>>([]);
  const [connected, setConnected] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  const resolve = async (action: "approve" | "reject", stepKey: string) => {
    setActionBusy(true);
    setActionError("");
    try {
      const response = await apiFetch(`/runs/${runId}/approval`, {
        method: "POST", body: JSON.stringify({ action, stepKey }),
      });
      if (!response.ok) throw new Error(`تصمیم ثبت نشد (${response.status})`);
      setRun((current) => current ? { ...current, status: "queued" } : current);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "خطا در ثبت تصمیم");
    } finally { setActionBusy(false); }
  };

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const [runResponse, eventResponse, stepsResponse] = await Promise.all([
          apiFetch(`/runs/${runId}`),
          apiFetch(`/runs/${runId}/events`),
          apiFetch(`/runs/${runId}/steps`),
        ]);
        if (!runResponse.ok || !eventResponse.ok) throw new Error("دریافت وضعیت اجرا ناموفق بود");
        const [nextRun, nextEvents] = await Promise.all([
          runResponse.json() as Promise<RunData>,
          eventResponse.json() as Promise<RunEvent[]>,
        ]);
        if (active) {
          setRun(nextRun);
          setEvents(nextEvents);
          if (stepsResponse.ok) setSteps(await stepsResponse.json());
          setConnected(true);
        }
      } catch {
        if (active) setConnected(false);
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 2000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [runId]);

  const progress = useMemo(() => steps.filter((step) => step.status === "completed").length, [steps]);

  const canOpenStudio = run?.status === "completed";

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
            {connected ? "Live" : "در حال اتصال..."}
          </span>
          <Link className="ghost-link" href="/workflows/new">
            ← بازگشت به جریان
          </Link>
        </div>
      </header>

      <section className="run-layout">
        <div className="run-main">
          <div className="canvas-title">
            <div>
              <h1>اجرای جاری</h1>
              <p>
                Run #{runId.slice(0, 8)} · وضعیت: {run?.status ?? "..."}
              </p>
            </div>
            <span className="status-pill">{progress} / {steps.length} مرحله</span>
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

          {run?.status === "waiting_approval" ? steps.filter((step) => step.status === "waiting_approval").map((step) => (
            <div className="run-output-ready" key={step.key}>
              <strong>{step.name} · منتظر تصمیم شما</strong>
              {step.output?.text ? <p>{step.output.text.slice(0, 700)}</p> : null}
              <button className="primary-button" disabled={actionBusy} onClick={() => void resolve("approve", step.key)}>تأیید این شاخه</button>
              <button className="ghost-button" disabled={actionBusy} onClick={() => void resolve("reject", step.key)}>رد این شاخه</button>
              {actionError ? <span role="alert">{actionError}</span> : null}
            </div>
          )) : null}

          {canOpenStudio ? (
            <div className="run-output-ready">
              <div>
                <strong>✓ خروجی «تولید محتوا» آماده و قابل ویرایش است</strong>
                <span>Run #{runId.slice(0, 8)} · Content Studio</span>
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
              <span className="micro-label">وضعیت Run</span>
              <strong>{run?.status ?? "queued"}</strong>
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
              <div className="empty-state">منتظر اولین Event...</div>
            ) : (
              [...events].reverse().map((event) => (
                <article className="event-row" key={event.id}>
                  <div className="event-marker" />
                  <div>
                    <div className="event-title">
                      <strong>{labels[event.type] ?? event.type}</strong>
                      <time>
                        {new Date(event.createdAt).toLocaleTimeString("fa-IR")}
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
