"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

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
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const [run, setRun] = useState<RunData | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    void fetch(`${apiUrl}/runs/${runId}`)
      .then((response) => response.json())
      .then(setRun);

    const source = new EventSource(`${apiUrl}/runs/${runId}/events/stream`);

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);

    const eventNames = Object.keys(labels);
    const handlers = eventNames.map((eventName) => {
      const handler = (event: MessageEvent) => {
        const data = JSON.parse(event.data) as RunEvent;
        setEvents((current) =>
          current.some((item) => item.id === data.id) ? current : [...current, data],
        );

        if (eventName === "run_completed" || eventName === "run_failed") {
          void fetch(`${apiUrl}/runs/${runId}`)
            .then((response) => response.json())
            .then(setRun);
        }
      };

      source.addEventListener(eventName, handler);
      return [eventName, handler] as const;
    });

    return () => {
      handlers.forEach(([eventName, handler]) => source.removeEventListener(eventName, handler));
      source.close();
    };
  }, [apiUrl, runId]);

  const progress = useMemo(
    () => events.filter((event) => event.type === "step_completed").length,
    [events],
  );

  return (
    <main className="workflow-page">
      <header className="app-header">
        <div className="brand-lockup">
          <strong>SocialYar</strong>
          <span>اجرای جریان · خبرهای AI</span>
        </div>
        <div className="header-actions">
          <span className={connected ? "live-dot online" : "live-dot"} />
          <span className="save-status">{connected ? "Live" : "در حال اتصال..."}</span>
          <Link className="ghost-link" href="/workflows/new">← بازگشت به جریان</Link>
        </div>
      </header>

      <section className="run-layout">
        <div className="run-main">
          <div className="canvas-title">
            <div>
              <h1>اجرای جاری</h1>
              <p>Run #{runId.slice(0, 8)} · وضعیت: {run?.status ?? "..."}</p>
            </div>
            <span className="status-pill">{progress} / 6 مرحله</span>
          </div>

          <div className="execution-strip">
            {["پایش منابع", "اعتبارسنجی", "بازنویسی محتوا", "بررسی حساسیت", "تأیید انسانی", "انتشار"].map(
              (name, index) => {
                const completed = index < progress;
                const active = index === progress && run?.status === "running";
                return (
                  <article className={`execution-node ${completed ? "done" : ""} ${active ? "active" : ""}`} key={name}>
                    <h3>{name}</h3>
                    <span>{completed ? "✓ انجام شد" : active ? "↻ در حال اجرا" : "○ منتظر"}</span>
                  </article>
                );
              },
            )}
          </div>

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
              <strong>{progress} / 6</strong>
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
                      <time>{new Date(event.createdAt).toLocaleTimeString("fa-IR")}</time>
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
