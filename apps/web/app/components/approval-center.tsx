"use client";
import { WorkflowApprovalCard, type WorkflowApproval } from "./workflow-approval-card";
import { YoutubeApprovalQueue } from "./youtube-panel";
import { apiFetch, getWorkspaceId } from "../lib/session";
import { statusLabel, persianError } from "../lib/persian";
import { faDigits } from "../lib/persian-calendar";

import { BrandLogo } from "./brand-logo";
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
  instagram: "اینستاگرام",
  telegram: "تلگرام",
  eitaa: "ایتا",
  website: "وب‌سایت",
  x: "ایکس",
  linkedin: "لینکدین",
};


export function ApprovalCenter() {
  const workspaceId = getWorkspaceId();
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [workflowApprovals, setWorkflowApprovals] = useState<WorkflowApproval[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [message, setMessage] = useState("در حال دریافت صف تأیید...");
  const [busy, setBusy] = useState(false);
  const [workflowLoaded, setWorkflowLoaded] = useState(false);
  const [workflowError, setWorkflowError] = useState("");
  const [workflowUpdatedAt, setWorkflowUpdatedAt] = useState<number | null>(null);
  const [workflowRefresh, setWorkflowRefresh] = useState(0);

  const load = async () => {
    if (!workspaceId) {
      setMessage("ابتدا وارد حساب کاربری شوید");
      return;
    }

    const response = await apiFetch(
      `/approvals?workspaceId=${workspaceId}`,
    );

    if (!response.ok) {
      throw new Error(`Approvals failed (${response.status})`);
    }

    const data = (await response.json()) as ApprovalRow[];
    setRows(data);
    setActiveId((current) => current ?? data[0]?.approval.id ?? null);
    setMessage(data.length ? "صف تأیید آماده است" : "موردی برای تأیید وجود ندارد");
  };
  const loadWorkflowApprovals = async () => {
    const response = await apiFetch("/workflow-approvals");
    if (!response.ok) throw new Error("دریافت تأییدهای جریان ناموفق بود");
    setWorkflowApprovals(await response.json());
    setWorkflowLoaded(true); setWorkflowError(""); setWorkflowUpdatedAt(Date.now());
  };
  const resolveWorkflow = async (item: WorkflowApproval, action: "approve" | "reject", edit?: { title?: string; text?: string; reply?: string }) => {
    if (action === "reject" && !window.confirm("این شاخه رد شود؟ خبر از این مسیر منتشر نمی‌شود.")) return;
    setBusy(true); setMessage("در حال ثبت تصمیم...");
    try {
      const response = await apiFetch(`/runs/${item.runId}/approval`, { method: "POST",
        body: JSON.stringify({ action, stepKey: item.stepKey, edit }) });
      if (!response.ok) throw new Error(`ثبت تصمیم ناموفق بود (${response.status})`);
      await loadWorkflowApprovals(); setMessage(action === "approve" ? "شاخه تأیید شد و ادامه می‌یابد." : "شاخه رد شد.");
    } catch (error) { setMessage(persianError(error, "ثبت تصمیم ناموفق بود")); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    void load().catch((error) =>
      setMessage(persianError(error, "خطا در دریافت صف تأیید")),
    );
  }, [workspaceId]);
  useEffect(() => {
    let active = true;
    let fetching = false;
    const controller = new AbortController();
    const refresh = async () => {
      if (fetching || document.visibilityState === "hidden") return;
      fetching = true;
      try {
        const response = await apiFetch("/workflow-approvals", { signal: controller.signal });
        if (!response.ok) throw new Error("دریافت صف تأیید ناموفق بود؛ پیش از تصمیم، اطلاعات را به‌روز کنید.");
        const items = await response.json() as WorkflowApproval[];
        if (active) { setWorkflowApprovals(items); setWorkflowLoaded(true); setWorkflowError(""); setWorkflowUpdatedAt(Date.now()); }
      } catch (error) { if (active) setWorkflowError(persianError(error, "صف تأیید به‌روز نیست؛ دوباره تلاش کنید.")); }
      finally { fetching = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    const onVisibility = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { active = false; controller.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisibility); };
  }, [workflowRefresh]);

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
      const response = await apiFetch(
        `/approvals/${active.approval.id}/resolve`,
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
      setMessage(persianError(error, "ثبت تصمیم ناموفق بود"));
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
          <BrandLogo />

          <span>مرکز تأیید</span>
        </div>
        <div className="header-actions">
          <span className="save-status">{message}</span>
          <Link className="ghost-link" href="/calendar">
            تقویم انتشار
          </Link>
        </div>
      </header>

      <section className="workflow-approval-section"><div><h1>تأیید انسانی جریان‌ها</h1><p>خروجی‌های این کارت‌ها تا تصمیم شما در همین شاخه متوقف می‌مانند.</p></div>
        {workflowError ? <p role="alert">{workflowError} <button className="ghost-button" onClick={() => setWorkflowRefresh((value) => value + 1)}>تلاش دوباره</button></p> : null}
        {workflowUpdatedAt ? <p className="save-status">آخرین دریافت: {new Date(workflowUpdatedAt).toLocaleTimeString("fa-IR", { timeZone: "Asia/Tehran" })} · به وقت تهران</p> : null}
        {workflowApprovals.length ? <div className="workflow-approval-grid">{workflowApprovals.map((item) =>
          <WorkflowApprovalCard key={`${item.runId}-${item.stepKey}`} item={item} busy={busy || Boolean(workflowError)} resolve={resolveWorkflow} />)}</div> :
          <p className="workflow-approval-empty">{workflowLoaded ? "در حال حاضر خروجی‌ای منتظر تأیید انسانی نیست." : "در حال دریافت صف تأیید…"}</p>}
      </section>

      <YoutubeApprovalQueue />
      <section className="approval-shell">
        <aside className="approval-queue">
          <div className="approval-heading">
            <span className="micro-label">مرحله ۹ · مرکز تأیید</span>
            <h1>تأیید خروجی‌هایی که واقعاً به تصمیم تو نیاز دارند</h1>
            <p>{faDigits(pendingCount)} مورد در انتظار تصمیم</p>
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
                  <small>{statusLabel(row.approval.status)}</small>
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
                  <span className="micro-label">منشأ محتوا</span>
                  <strong>
                    {active.content.runId
                      ? `شناسه اجرا: ${active.content.runId.slice(0, 8)}`
                      : "بدون اجرای مرتبط"}
                  </strong>
                </div>
              </div>

              <article className="approval-preview">
                <h2>{active.variant.title ?? "بدون عنوان"}</h2>
                <p>{active.variant.body}</p>
              </article>

              <div className="approval-agent-card">
                <span className="micro-label">پیشنهاد دستیار</span>
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
                    رفتن به تقویم انتشار
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
