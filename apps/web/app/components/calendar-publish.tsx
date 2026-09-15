"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type ApprovalRow = {
  approval: { id: string; status: string };
  variant: {
    id: string;
    channel: string;
    title: string | null;
    body: string;
    status: string;
  };
  content: {
    id: string;
    runId: string | null;
    title: string | null;
  };
};

type CalendarRow = {
  schedule: {
    id: string;
    status: string;
    scheduledAt: string;
    timezone: string;
    smartSchedule: boolean;
  };
  variant: {
    id: string;
    channel: string;
    title: string | null;
    status: string;
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

function defaultScheduleTime() {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  return date.toISOString().slice(0, 16);
}

export function CalendarPublish() {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const workspaceId = process.env.NEXT_PUBLIC_WORKSPACE_ID ?? "";
  const [approved, setApproved] = useState<ApprovalRow[]>([]);
  const [calendar, setCalendar] = useState<CalendarRow[]>([]);
  const [selectedVariantId, setSelectedVariantId] = useState("");
  const [scheduledAt, setScheduledAt] = useState(defaultScheduleTime());
  const [timezone, setTimezone] = useState("UTC");
  const [smartSchedule, setSmartSchedule] = useState(true);
  const [message, setMessage] = useState("در حال بارگذاری...");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    if (!workspaceId) {
      setMessage("NEXT_PUBLIC_WORKSPACE_ID تنظیم نشده");
      return;
    }

    const [approvedResponse, calendarResponse] = await Promise.all([
      fetch(
        `${apiUrl}/approvals?workspaceId=${workspaceId}&status=approved`,
      ),
      fetch(`${apiUrl}/calendar?workspaceId=${workspaceId}`),
    ]);

    if (!approvedResponse.ok || !calendarResponse.ok) {
      throw new Error("Calendar data could not be loaded");
    }

    const approvedRows = (await approvedResponse.json()) as ApprovalRow[];
    const calendarRows = (await calendarResponse.json()) as CalendarRow[];

    const unscheduled = approvedRows.filter(
      (row) => row.variant.status === "approved",
    );

    setApproved(unscheduled);
    setCalendar(calendarRows);
    setSelectedVariantId((current) => current || unscheduled[0]?.variant.id || "");
    setMessage("Calendar / Publish آماده است");
  };

  useEffect(() => {
    void load().catch((error) =>
      setMessage(error instanceof Error ? error.message : "خطا در Calendar"),
    );
  }, [apiUrl, workspaceId]);

  const selected = useMemo(
    () => approved.find((row) => row.variant.id === selectedVariantId) ?? null,
    [approved, selectedVariantId],
  );

  const scheduleVariant = async () => {
    if (!selected) return;
    setBusy(true);
    setMessage("در حال زمان‌بندی...");

    try {
      const response = await fetch(
        `${apiUrl}/content-variants/${selected.variant.id}/schedules`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scheduledAt: new Date(scheduledAt).toISOString(),
            timezone,
            smartSchedule,
          }),
        },
      );

      if (!response.ok) {
        throw new Error(`Schedule failed (${response.status})`);
      }

      await load();
      setMessage("✓ نسخه زمان‌بندی شد");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "زمان‌بندی ناموفق بود");
    } finally {
      setBusy(false);
    }
  };

  const publishNow = async (scheduleId: string) => {
    setBusy(true);
    setMessage("در حال ارسال برای انتشار...");

    try {
      const response = await fetch(
        `${apiUrl}/schedules/${scheduleId}/publish-now`,
        { method: "POST" },
      );

      if (!response.ok) {
        throw new Error(`Publish failed (${response.status})`);
      }

      await load();
      setMessage("✓ در صف انتشار قرار گرفت");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "انتشار ناموفق بود");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="workflow-page">
      <header className="app-header">
        <div className="brand-lockup">
          <strong>SocialYar</strong>
          <span>Calendar & Publish</span>
        </div>
        <div className="header-actions">
          <span className="save-status">{message}</span>
          <Link className="ghost-link" href="/approvals">
            ← Approval Center
          </Link>
        </div>
      </header>

      <section className="calendar-shell">
        <div className="calendar-main">
          <div className="approval-heading">
            <span className="micro-label">مرحله ۱۰ · Calendar & Publish</span>
            <h1>زمان‌بندی و انتشار نسخه‌های تأییدشده</h1>
            <p>فقط محتوای تأییدشده وارد این مرحله می‌شود.</p>
          </div>

          <div className="calendar-list">
            {calendar.length === 0 ? (
              <div className="empty-state">هنوز چیزی زمان‌بندی نشده.</div>
            ) : (
              calendar.map((row) => (
                <article className="calendar-item" key={row.schedule.id}>
                  <div className="calendar-date">
                    <strong>
                      {new Date(row.schedule.scheduledAt).toLocaleDateString("fa-IR")}
                    </strong>
                    <span>
                      {new Date(row.schedule.scheduledAt).toLocaleTimeString("fa-IR", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>

                  <div className="calendar-content">
                    <strong>
                      {row.variant.title ?? row.content.title ?? "بدون عنوان"}
                    </strong>
                    <span>
                      {channelLabels[row.variant.channel] ?? row.variant.channel}
                    </span>
                  </div>

                  <div className="calendar-status">
                    <span>{row.schedule.status}</span>
                    <button
                      className="ghost-button"
                      onClick={() => publishNow(row.schedule.id)}
                      disabled={busy || row.schedule.status !== "scheduled"}
                    >
                      انتشار همین حالا
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
        </div>

        <aside className="publish-sidebar">
          <div className="studio-side-block">
            <h3>نسخه آماده زمان‌بندی</h3>

            {approved.length === 0 ? (
              <div className="empty-state">نسخه تأییدشده جدیدی وجود ندارد.</div>
            ) : (
              <>
                <select
                  className="publish-select"
                  value={selectedVariantId}
                  onChange={(event) => setSelectedVariantId(event.target.value)}
                >
                  {approved.map((row) => (
                    <option key={row.variant.id} value={row.variant.id}>
                      {channelLabels[row.variant.channel] ?? row.variant.channel} ·{" "}
                      {row.variant.title ?? row.content.title ?? "بدون عنوان"}
                    </option>
                  ))}
                </select>

                {selected ? (
                  <div className="publish-preview">
                    <strong>
                      {selected.variant.title ?? selected.content.title ?? "بدون عنوان"}
                    </strong>
                    <p>{selected.variant.body}</p>
                  </div>
                ) : null}

                <label className="publish-field">
                  <span>زمان انتشار</span>
                  <input
                    type="datetime-local"
                    value={scheduledAt}
                    onChange={(event) => setScheduledAt(event.target.value)}
                  />
                </label>

                <label className="publish-field">
                  <span>Timezone</span>
                  <input
                    value={timezone}
                    onChange={(event) => setTimezone(event.target.value)}
                  />
                </label>

                <label className="publish-check">
                  <input
                    type="checkbox"
                    checked={smartSchedule}
                    onChange={(event) => setSmartSchedule(event.target.checked)}
                  />
                  <span>Smart Schedule فعال باشد</span>
                </label>

                <button
                  className="success-button wide"
                  onClick={scheduleVariant}
                  disabled={busy || !selected}
                >
                  ✓ زمان‌بندی
                </button>
              </>
            )}
          </div>

          <div className="publish-guard">
            <span className="micro-label">Agent Publish Guard</span>
            <strong>محتوای تأییدنشده منتشر نمی‌شود.</strong>
            <p>
              در خطای API: Retry → Queue → Republish انجام می‌شود و وضعیت انتشار ثبت خواهد شد.
            </p>
          </div>
        </aside>
      </section>
    </main>
  );
}
