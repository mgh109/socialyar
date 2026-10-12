"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch, getStoredUser, getWorkspaceId } from "../lib/session";
import { WorkflowStart } from "./workflow-start";

type Workflow = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  currentVersion: number;
  updatedAt: string;
};
type Publication = { publication: { status: string; createdAt: string; publishedAt: string | null; externalUrl: string | null }; content: { title: string | null }; variant: { channel: string } };
const statusLabels: Record<string, string> = { active: "فعال", draft: "پیش‌نویس", paused: "متوقف‌شده", inactive: "غیرفعال", archived: "بایگانی‌شده" };

export function WorkflowList() {
  const [startOpen,setStartOpen]=useState(false);
  const [search,setSearch]=useState("");
  const [sort,setSort]=useState("recent");
  const [view,setView]=useState("grid");
  const welcomeKey=()=>`hoor:workflow-welcome:${getStoredUser()?.id ?? "guest"}:${getWorkspaceId() ?? "default"}`;
  const closeStart=()=>{setStartOpen(false);try{localStorage.setItem(welcomeKey(),"seen");}catch{}};
  const [items, setItems] = useState<Workflow[]>([]);
  const [message, setMessage] = useState("در حال دریافت جریان‌ها...");
  const [failed, setFailed] = useState(0);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function deleteWorkflow(workflow: Workflow) {
    if (!window.confirm(`جریان «${workflow.name}» حذف شود؟ اجراهای تمام‌شده و پیش‌نویس‌های آن هم پاک می‌شوند. این کار قابل بازگشت نیست.`)) return;
    setDeletingId(workflow.id);
    setMessage("");
    try {
      const response = await apiFetch(`/workflows/${workflow.id}`, { method: "DELETE" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        if (body.error === "workflow_active") throw new Error("برای حذف این جریان، ابتدا آن را غیرفعال کن.");
        if (body.error === "workflow_has_pending_work") throw new Error("این جریان هنوز کار در حال اجرا یا تأیید در انتظار دارد؛ پس از پایان یا لغو آن حذف کن.");
        if (body.error === "workflow_has_publications") throw new Error("این جریان سابقهٔ انتشار یا برنامهٔ انتشار دارد و برای حفظ اطلاعات آن قابل حذف نیست.");
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
        try{if(!localStorage.getItem(welcomeKey())){localStorage.setItem(welcomeKey(),"seen");setStartOpen(true);}}catch{}
        setMessage(workflows.length ? "" : "هنوز جریانی ذخیره نکرده‌ای.");
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : "خطا در دریافت جریان‌ها"));
    void apiFetch("/publications").then(async (response) => {
      if (!response.ok) return;
      const publications = await response.json() as Publication[];
      setFailed(publications.filter((item) => item.publication.status === "failed").length);
    }).catch(() => {});
  }, []);

  const visible=items.filter(item=>`${item.name} ${item.description ?? ""}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).sort((a,b)=>sort==="name"?a.name.localeCompare(b.name,"fa"):Date.parse(b.updatedAt)-Date.parse(a.updatedAt));
  return (
    <section className="workflow-library" aria-labelledby="workflow-library-title">
      <WorkflowStart open={startOpen} onClose={closeStart} />
      <div className="workflow-library-heading">
        <div>
          <h1 id="workflow-library-title">جریان‌های من</h1>

        </div>
        <div className="workflow-create-actions"><input className="workflow-search" aria-label="جست‌وجوی جریان‌ها" placeholder="جست‌وجوی جریان…" value={search} onChange={event=>setSearch(event.target.value)}/><button type="button" className="primary-button" onClick={()=>setStartOpen(true)}>+ جریان جدید</button></div>
      </div>

      <div className="home-flow-toolbar"><span>{items.length.toLocaleString("fa-IR")} جریان · {items.filter(item=>item.status==="active").length.toLocaleString("fa-IR")} فعال</span><select aria-label="مرتب‌سازی جریان‌ها" value={sort} onChange={event=>setSort(event.target.value)}><option value="recent">آخرین تغییرات</option><option value="name">نام جریان</option></select><div className="home-view-toggle"><button className="ghost-button" type="button" aria-pressed={view==="grid"} onClick={()=>setView("grid")}>شبکه‌ای</button><button className="ghost-button" type="button" aria-pressed={view==="list"} onClick={()=>setView("list")}>فهرست</button></div></div>
      {failed ? <p className="home-attention"><Link href="/analytics">{failed.toLocaleString("fa-IR")} انتشار نیاز به بررسی دارد ←</Link></p> : null}
      {message ? <p role="status" className="workflow-library-message">{message}</p> : null}
      {search && !visible.length ? <p className="workflow-library-message">جریانی با این نام پیدا نشد.</p> : null}
      <div className={`workflow-library-grid ${view==="list"?"home-list-view":""}`}>
        {visible.map((workflow) => (
          <article className="card workflow-library-card" key={workflow.id}>
            <Link className="workflow-card-link" href={`/workflows/new?id=${workflow.id}`} aria-label={`باز کردن جریان ${workflow.name}`} />
            <div className="workflow-card-top">
              <span className={`workflow-card-status ${workflow.status === "active" ? "is-active" : ""}`}><i aria-hidden="true" />{statusLabels[workflow.status] ?? "وضعیت نامشخص"}</span>
              <details className="workflow-card-menu" onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => { if (event.key === "Escape") event.currentTarget.open = false; }}
                onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }}>
                <summary aria-label={`گزینه‌های جریان ${workflow.name}`} title="گزینه‌های جریان">⋯</summary>
                <div className="workflow-card-popover">
                  <button type="button" disabled={deletingId !== null} onClick={() => void deleteWorkflow(workflow)} aria-label={`حذف جریان ${workflow.name}`}>
                    {deletingId === workflow.id ? "در حال حذف..." : "حذف جریان"}
                  </button>
                </div>
              </details>
            </div>
            <h2>{workflow.name}</h2>
            <div className="home-flow-preview" aria-hidden="true"><span aria-hidden="true">◇</span><small>{statusLabels[workflow.status] ?? "وضعیت نامشخص"}</small></div>
            <p>{workflow.description || "برای تنظیم، جریان را باز کن."}</p>
            <div className="workflow-library-actions">
              <span className="workflow-card-version">نسخهٔ {workflow.currentVersion.toLocaleString("fa-IR")}</span>
              <time dateTime={workflow.updatedAt}>{new Date(workflow.updatedAt).toLocaleDateString("fa-IR",{timeZone:"Asia/Tehran"})}</time>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

