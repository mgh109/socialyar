"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type ApprovalRow = {
  approval: {
    id: string;
    status: "pending" | "approved" | "rejected" | "changes_requested";
    reason: string | null;
    agentRecommendation: string | null;
    createdAt: string;
  };
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

const channelLabels: Record<string, string> = {
  instagram: "Instagram",
  telegram: "Telegram",
  website: "Website",
  x: "X",
  linkedin: "LinkedIn",
};

export function ApprovalCenter() {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const workspaceId = process.env.NEXT_PUBLIC_WORKSPACE_ID ?? "";
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [message, setMessage] = useState("در حال دریافت صف تأیید...");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    if (!workspaceId) {
      setMessage("NEXT_PUBLIC_WORKSPACE_ID تنظیم نشده");
      return;
    }

    const response = await fetch(
      `${apiUrl}/approvals?workspaceId=${workspaceId}`,
    );

    if (!response.ok) {
      throw new Error(`Approvals failed (${response.status})`);
    }

    const data = (await response.json()) as ApprovalRow[];
    setRows(data);
    setActiveId((current) => current ?? data[0]?.approval.id ?? null);
    setMessage(data.length ? "صف تأیید آماده است" : "موردی برای تأیید وجود ندارد");
  };

  useEffect(() => {
    void load().catch((error) =>
      setMessage(error instanceof Error ? error.message : "خطا در دریافت Approval"),
    );
  }, [apiUrl, workspaceId]);

  const active = useMemo(
    () => rows.find((row) => row.approval.id === activeId) ?? null,
    [activeId, rows],
  );

  const resolve = async (
    action: "approve" | "reject" | "changes_requested",
  ) => {
    if (!active) return;
    setBusy(true);
    setMessage("در حال ثبت تصمیم...");

    try {
      const response = await fetch(
        `${apiUrl}/approvals/${active.approval.id}/resolve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            note:
              action === "approve"
                ? "تأیید شد"
                : action === "reject"
                  ? "رد شد"
                  : "نیاز به اصلاح دارد",
          }),
        },
      );

      if (!response.ok) {
        throw new Error(`Resolve failed (${response.status})`);
      }

      await load();
      setMessage(
        action === "approve"
          ? "✓ نسخه تأیید شد"
          : action === "reject"
            ? "نسخه رد شد"
            : "برای اصلاح برگشت خورد",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "ثبت تصمیم ناموفق بود");
    } finally {
      setBusy(false);
    }
  };

  const pendingCount = rows.filter(
    (row) => row.approval.status === "pending",
  ).length;

  return (
    <main className="workflow-page">
      <header className="app-header">
        <div className="brand-lockup">
          <strong>SocialYar</strong>
          <span>Approval Center</span>
        </div>
        <div className="header-actions">
          <span className="save-status">{message}</span>
          <Link className="ghost-link" href="/calendar">
            Calendar / Publish
          </Link>
        </div>
      </header>

      <section className="approval-shell">
        <aside className="approval-queue">
          <div className="approval-heading">
            <span className="micro-label">مرحله ۹ · Approval Center</span>
            <h1>تأیید خروجی‌هایی که واقعاً به تصمیم تو نیاز دارند</h1>
            <p>{pendingCount} مورد در انتظار تصمیم</p>
          </div>

          <div className="approval-list">
            {rows.length === 0 ? (
              <div className="empty-state">صف تأیید خالی است.</div>
            ) : (
              rows.map((row) => (
                <button
                  key={row.approval.id}
                  className={
                    row.approval.id === activeId
                      ? "approval-list-item active"
                      : "approval-list-item"
                  }
                  onClick={() => setActiveId(row.approval.id)}
                >
                  <div>
                    <strong>
                      {row.variant.title ?? row.content.title ?? "بدون عنوان"}
                    </strong>
                    <span>{channelLabels[row.variant.channel] ?? row.variant.channel}</span>
                  </div>
                  <small>{row.approval.status}</small>
                </button>
              ))
            )}
          </div>
        </aside>

        <section className="approval-detail">
          {active ? (
            <>
              <div className="approval-meta">
                <div>
                  <span className="micro-label">کانال</span>
                  <strong>
                    {channelLabels[active.variant.channel] ?? active.variant.channel}
                  </strong>
                </div>
                <div>
                  <span className="micro-label">ریسک</span>
                  <strong>نیازمند بررسی انسانی</strong>
                </div>
                <div>
                  <span className="micro-label">Provenance</span>
                  <strong>
                    {active.content.runId
                      ? `Run #${active.content.runId.slice(0, 8)}`
                      : "بدون Run"}
                  </strong>
                </div>
              </div>

              <article className="approval-preview">
                <h2>{active.variant.title ?? "بدون عنوان"}</h2>
                <p>{active.variant.body}</p>
              </article>

              <div className="approval-agent-card">
                <span className="micro-label">پیشنهاد Agent</span>
                <p>
                  {active.approval.agentRecommendation ??
                    "این نسخه را قبل از انتشار یک‌بار بررسی کن."}
                </p>
                <small>
                  {active.approval.reason ?? "نیاز به بررسی انسانی"}
                </small>
              </div>

              <div className="approval-actions">
                <button
                  className="danger-button"
                  onClick={() => resolve("reject")}
                  disabled={busy || active.approval.status !== "pending"}
                >
                  رد نسخه
                </button>
                <button
                  className="ghost-button"
                  onClick={() => resolve("changes_requested")}
                  disabled={busy || active.approval.status !== "pending"}
                >
                  ✦ نیاز به اصلاح
                </button>
                <button
                  className="success-button"
                  onClick={() => resolve("approve")}
                  disabled={busy || active.approval.status !== "pending"}
                >
                  ✓ تأیید این نسخه
                </button>
              </div>

              {active.approval.status === "approved" ? (
                <div className="approval-next-step">
                  <strong>این نسخه تأیید شده و آماده زمان‌بندی است.</strong>
                  <Link className="primary-link" href="/calendar">
                    رفتن به Calendar / Publish
                  </Link>
                </div>
              ) : null}
            </>
          ) : (
            <div className="empty-state">یک مورد را از صف انتخاب کن.</div>
          )}
        </section>
      </section>
    </main>
  );
}
