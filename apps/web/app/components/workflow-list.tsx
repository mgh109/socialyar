"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch } from "../lib/session";

type Workflow = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  currentVersion: number;
  updatedAt: string;
};
type Publication = { publication: { status: string; createdAt: string; publishedAt: string | null; externalUrl: string | null }; content: { title: string | null }; variant: { channel: string } };

export function WorkflowList() {
  const [items, setItems] = useState<Workflow[]>([]);
  const [message, setMessage] = useState("در حال دریافت جریان‌ها...");
  const [latest, setLatest] = useState<Publication | null>(null);
  const [failed, setFailed] = useState(0);
  const [queued, setQueued] = useState(0);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function deleteWorkflow(workflow: Workflow) {
    if (!window.confirm(`جریان «${workflow.name}» حذف شود؟ این کار قابل بازگشت نیست.`)) return;
    setDeletingId(workflow.id);
    setMessage("");
    try {
      const response = await apiFetch(`/workflows/${workflow.id}`, { method: "DELETE" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        if (body.error === "workflow_active") throw new Error("برای حذف این جریان، ابتدا آن را غیرفعال کن.");
        if (body.error === "workflow_has_runs") throw new Error("این جریان سابقهٔ اجرا دارد و برای حفظ گزارش‌ها قابل حذف نیست.");
        throw new Error(`حذف جریان ناموفق بود (${response.status})`);
      }
      setItems((current) => {
        const remaining = current.filter((item) => item.id !== workflow.id);
        if (!remaining.length) setMessage("هنوز جریانی ذخیره نکرده‌ای.");
        return remaining;
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "حذف جریان ناموفق بود.");
    } finally {
      setDeletingId(null);
    }
  }

  useEffect(() => {
    void apiFetch("/workflows")
      .then(async (response) => {
        if (!response.ok) throw new Error(`دریافت جریان‌ها ناموفق بود (${response.status})`);
        return response.json() as Promise<Workflow[]>;
      })
      .then((workflows) => {
        setItems(workflows);
        setMessage(workflows.length ? "" : "هنوز جریانی ذخیره نکرده‌ای.");
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : "خطا در دریافت جریان‌ها"));
    void apiFetch("/publications").then(async (response) => {
      if (!response.ok) return;
      const publications = await response.json() as Publication[];
      setLatest(publications.find((item) => item.publication.status === "published") ?? null);
      setFailed(publications.filter((item) => item.publication.status === "failed").length);
      setQueued(publications.filter((item) => ["queued", "publishing"].includes(item.publication.status)).length);
    }).catch(() => {});
  }, []);

  return (
    <section className="workflow-library" aria-labelledby="workflow-library-title">
      <div className="home-status-grid" aria-label="وضعیت فضای کاری">
        <div><span>پایش‌های فعال</span><strong>{items.filter((item) => item.status === "active").length}</strong><small>از {items.length} جریان</small></div>
        <div><span>آخرین خبر ارسالی</span><strong className="home-status-title">{latest ? latest.content.title || "بدون عنوان" : "هنوز ارسال موفقی ثبت نشده"}</strong><small>{latest ? new Date(latest.publication.publishedAt ?? latest.publication.createdAt).toLocaleString("fa-IR") : "پس از اولین انتشار نمایش داده می‌شود"}</small>{latest?.publication.externalUrl ? <a href={latest.publication.externalUrl} target="_blank" rel="noreferrer">دیدن خبر ↗</a> : null}</div>
        <div><span>در صف انتشار</span><strong>{queued}</strong><small>در انتظار پردازش</small></div>
        <div className={failed ? "needs-attention" : ""}><span>نیاز به بررسی</span><strong>{failed}</strong>{failed ? <Link href="/analytics">دیدن خطاها ←</Link> : <small>خطایی ثبت نشده</small>}</div>
      </div>
      <div className="workflow-library-heading">
        <div>
          <h1 id="workflow-library-title">جریان‌های من</h1>
          <p>جریان‌های ذخیره‌شده را باز کن، ویرایش کن یا اجرا کن.</p>
        </div>
        <Link className="primary-link" href="/workflows/new">+ جریان جدید</Link>
      </div>
      <nav className="workflow-shortcuts" aria-label="بخش‌های هور+">
        <Link href="/approvals">تأیید محتوا</Link>
        <Link href="/calendar">تقویم انتشار</Link>
        <Link href="/connections">اتصال کانال‌ها</Link>
        <Link href="/analytics">داشبورد انتشار و سلامت</Link>
      </nav>
      {message ? <p role="status" className="workflow-library-message">{message}</p> : null}
      <div className="workflow-library-grid">
        {items.map((workflow) => (
          <article className="card workflow-library-card" key={workflow.id}>
            <span className="index">نسخه {workflow.currentVersion} · {workflow.status}</span>
            <h2>{workflow.name}</h2>
            <p>{workflow.description || "توضیحی ثبت نشده"}</p>
            <div className="workflow-library-actions">
              <Link className="workflow-library-action" href={`/workflows/new?id=${workflow.id}`}>باز کردن جریان ←</Link>
              <button type="button" className="workflow-delete" disabled={deletingId !== null} onClick={() => void deleteWorkflow(workflow)} aria-label={`حذف جریان ${workflow.name}`}>
                {deletingId === workflow.id ? "در حال حذف..." : "حذف"}
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
