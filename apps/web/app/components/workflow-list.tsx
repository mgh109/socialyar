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

export function WorkflowList() {
  const [items, setItems] = useState<Workflow[]>([]);
  const [message, setMessage] = useState("در حال دریافت جریان‌ها...");

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
  }, []);

  return (
    <section className="workflow-library" aria-labelledby="workflow-library-title">
      <div className="workflow-library-heading">
        <div>
          <h1 id="workflow-library-title">جریان‌های من</h1>
          <p>جریان‌های ذخیره‌شده را باز کن، ویرایش کن یا اجرا کن.</p>
        </div>
        <Link className="primary-link" href="/workflows/new">+ جریان جدید</Link>
      </div>
      {message ? <p role="status" className="workflow-library-message">{message}</p> : null}
      <div className="workflow-library-grid">
        {items.map((workflow) => (
          <Link className="card workflow-library-card" key={workflow.id} href={`/workflows/new?id=${workflow.id}`}>
            <span className="index">نسخه {workflow.currentVersion} · {workflow.status}</span>
            <h2>{workflow.name}</h2>
            <p>{workflow.description || "توضیحی ثبت نشده"}</p>
            <span className="workflow-library-action">باز کردن جریان ←</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
