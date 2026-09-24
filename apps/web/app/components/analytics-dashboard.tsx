"use client";
import { apiFetch, getWorkspaceId } from "../lib/session";

import { BrandLogo } from "./brand-logo";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

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

type PublicationRow = {
  publication: {
    id: string;
    status: string;
    attempt: number;
    externalUrl: string | null;
    error: Record<string, unknown> | null;
    createdAt: string;
    publishedAt: string | null;
  };
  variant: {
    id: string;
    channel: string;
    title: string | null;
  };
  content: {
    id: string;
    title: string | null;
  };
};

const channelLabels: Record<string, string> = {
  instagram: "Instagram",
  telegram: "Telegram",
  website: "Website",
  x: "X",
  linkedin: "LinkedIn",
};

export function AnalyticsDashboard() {
  const workspaceId = getWorkspaceId();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [publications, setPublications] = useState<PublicationRow[]>([]);
  const [statusFilter, setStatusFilter] = useState("all");
  const [message, setMessage] = useState("در حال دریافت آمار...");

  const load = async () => {
    if (!workspaceId) {
      setMessage("ابتدا وارد حساب کاربری شوید");
      return;
    }

    const [summaryResponse, historyResponse] = await Promise.all([
      apiFetch(`/analytics/summary?workspaceId=${workspaceId}`),
      apiFetch(`/publications?workspaceId=${workspaceId}`),
    ]);

    if (!summaryResponse.ok || !historyResponse.ok) {
      throw new Error("Analytics data could not be loaded");
    }

    setSummary(await summaryResponse.json());
    setPublications(await historyResponse.json());
    setMessage("آخرین وضعیت انتشارها");
  };

  useEffect(() => {
    void load().catch((error) =>
      setMessage(error instanceof Error ? error.message : "خطا در Analytics"),
    );
  }, [workspaceId]);

  const filtered = useMemo(
    () =>
      statusFilter === "all"
        ? publications
        : publications.filter(
            (row) => row.publication.status === statusFilter,
          ),
    [publications, statusFilter],
  );

  if (!summary) {
    return (
      <main className="workflow-page">
        <header className="app-header">
          <div className="brand-lockup">
            <BrandLogo />
            <span>Analytics</span>
          </div>
        </header>
        <div className="studio-loading">{message}</div>
      </main>
    );
  }

  return (
    <main className="workflow-page">
      <header className="app-header">
        <div className="brand-lockup">
          <BrandLogo />
          <span>Analytics & Publication History</span>
        </div>
        <div className="header-actions">
          <span className="save-status">{message}</span>
          <Link className="ghost-link" href="/connections">
            Connections
          </Link>
          <Link className="ghost-link" href="/calendar">
            Calendar
          </Link>
        </div>
      </header>

      <section className="analytics-shell">
        <div className="analytics-heading">
          <span className="micro-label">عملکرد انتشار</span>
          <h1>داشبورد انتشار و سلامت کانال‌ها</h1>
          <p>
            آمار این صفحه مستقیماً از publicationها و analytics eventهای ثبت‌شده محاسبه می‌شود.
          </p>
        </div>

        <div className="metric-grid">
          <article className="metric-card">
            <span>کل انتشارها</span>
            <strong>{summary.totals.total}</strong>
          </article>
          <article className="metric-card success">
            <span>موفق</span>
            <strong>{summary.totals.published}</strong>
          </article>
          <article className="metric-card danger">
            <span>ناموفق</span>
            <strong>{summary.totals.failed}</strong>
          </article>
          <article className="metric-card">
            <span>در صف / در حال انتشار</span>
            <strong>{summary.totals.queued}</strong>
          </article>
          <article className="metric-card">
            <span>Success Rate</span>
            <strong>{summary.totals.successRate}%</strong>
          </article>
          <article className="metric-card">
            <span>کل تلاش‌ها</span>
            <strong>{summary.totals.totalAttempts}</strong>
          </article>
        </div>

        <section className="channel-performance">
          <div className="section-title-row">
            <div>
              <h2>عملکرد کانال‌ها</h2>
              <p>نرخ موفقیت، خطا و تعداد تلاش انتشار برای هر کانال</p>
            </div>
          </div>

          <div className="channel-performance-grid">
            {summary.byChannel.length === 0 ? (
              <div className="empty-state">هنوز داده‌ای برای کانال‌ها نداریم.</div>
            ) : (
              summary.byChannel.map((channel) => (
                <article className="channel-performance-card" key={channel.channel}>
                  <div className="channel-performance-head">
                    <strong>
                      {channelLabels[channel.channel] ?? channel.channel}
                    </strong>
                    <span>{channel.successRate}% موفق</span>
                  </div>
                  <div className="performance-bar">
                    <span style={{ width: `${channel.successRate}%` }} />
                  </div>
                  <dl>
                    <div><dt>کل</dt><dd>{channel.total}</dd></div>
                    <div><dt>موفق</dt><dd>{channel.published}</dd></div>
                    <div><dt>خطا</dt><dd>{channel.failed}</dd></div>
                    <div><dt>تلاش‌ها</dt><dd>{channel.attempts}</dd></div>
                  </dl>
                </article>
              ))
            )}
          </div>
        </section>

        <section className="history-section">
          <div className="section-title-row">
            <div>
              <h2>Publication History</h2>
              <p>تاریخچه واقعی صف، موفقیت، خطا و Retryها</p>
            </div>

            <select
              className="history-filter"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="all">همه وضعیت‌ها</option>
              <option value="queued">Queued</option>
              <option value="publishing">Publishing</option>
              <option value="published">Published</option>
              <option value="failed">Failed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>

          <div className="history-list">
            {filtered.length === 0 ? (
              <div className="empty-state">Publicationی با این وضعیت وجود ندارد.</div>
            ) : (
              filtered.map((row) => (
                <article className="history-row" key={row.publication.id}>
                  <div className="history-status">
                    <span className={`publication-state ${row.publication.status}`}>
                      {row.publication.status}
                    </span>
                  </div>

                  <div className="history-main">
                    <strong>
                      {row.variant.title ??
                        row.content.title ??
                        "بدون عنوان"}
                    </strong>
                    <span>
                      {channelLabels[row.variant.channel] ?? row.variant.channel}
                      {" · "}
                      Attempt {row.publication.attempt || 0}
                    </span>
                  </div>

                  <div className="history-time">
                    <strong>
                      {new Date(row.publication.createdAt).toLocaleDateString("fa-IR")}
                    </strong>
                    <span>
                      {new Date(row.publication.createdAt).toLocaleTimeString("fa-IR", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>

                  <div className="history-action">
                    {row.publication.externalUrl ? (
                      <a
                        className="ghost-link"
                        href={row.publication.externalUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        مشاهده خروجی
                      </a>
                    ) : row.publication.error ? (
                      <span className="history-error">
                        {String(
                          (row.publication.error as { message?: unknown }).message ??
                            "Publication failed",
                        )}
                      </span>
                    ) : (
                      <span className="history-muted">بدون خروجی خارجی</span>
                    )}
                  </div>
                </article>
              ))
            )}
          </div>
        </section>

        <section className="event-summary">
          <div className="section-title-row">
            <div>
              <h2>Engagement Events</h2>
              <p>رویدادهایی که از کانال‌ها یا webhookهای تحلیل ثبت شده‌اند</p>
            </div>
          </div>
          <div className="event-metric-grid">
            {summary.events.length === 0 ? (
              <div className="empty-state">
                هنوز analytics event خارجی ثبت نشده.
              </div>
            ) : (
              summary.events.map((event) => (
                <article className="event-metric-card" key={event.type}>
                  <span>{event.type}</span>
                  <strong>{event.value}</strong>
                </article>
              ))
            )}
          </div>
        </section>
      </section>
    </main>
  );
}
