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
  const [connected, setConnected] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  const resolve = async (action: "approve" | "reject") => {
    setActionBusy(true);
    setActionError("");
    try {
      const response = await apiFetch(`/runs/${runId}/approval`, {
        method: "POST", body: JSON.stringify({ action }),
      });
      if (!response.ok) throw new Error(`تصمیم ثبت نشد (${response.status})`);
      setRun((current) => current ? { ...current, status: action === "approve" ? "queued" : "cancelled" } : current);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "خطا در ثبت تصمیم");
    } finally { setActionBusy(false); }
  };

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const [runResponse, eventResponse] = await Promise.all([
          apiFetch(`/runs/${runId}`),
          apiFetch(`/runs/${runId}/events`),
        ]);
        if (!runResponse.ok || !eventResponse.ok) throw new Error("دریافت وضعیت اجرا ناموفق بود");
        const [nextRun, nextEvents] = await Promise.all([
          runResponse.json() as Promise<RunData>,
          eventResponse.json() as Promise<RunEvent[]>,
        ]);
        if (active) {
          setRun(nextRun);
          setEvents(nextEvents);
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

  const progress = useMemo(
    () => events.filter((event) => event.type === "step_completed").length,
    [events],
  );

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
            <span className="status-pill">{progress} / 3 مرحله</span>
          </div>

          <div className="execution-strip">
            {[
              "متن ورودی",
              "تأیید انسانی",
              "پیش‌نویس",
            ].map((name, index) => {
              const completed = index < progress;
              const active = index === progress && run?.status === "running";
              return (
                <article
                  className={`execution-node ${completed ? "done" : ""} ${active ? "active" : ""}`}
                  key={name}
                >
                  <h3>{name}</h3>
                  <span>
                    {completed
                      ? "✓ انجام شد"
                      : active
                        ? "↻ در حال اجرا"
                        : "○ منتظر"}
                  </span>
                </article>
              );
            })}
          </div>

          {run?.status === "waiting_approval" ? (
            <div className="run-output-ready">
              <strong>این جریان منتظر تصمیم شماست.</strong>
              <button className="primary-button" disabled={actionBusy} onClick={() => void resolve("approve")}>تأیید و ادامه</button>
              <button className="ghost-button" disabled={actionBusy} onClick={() => void resolve("reject")}>رد کردن</button>
              {actionError ? <span role="alert">{actionError}</span> : null}
            </div>
          ) : null}

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
              <strong>{progress} / 3</strong>
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
