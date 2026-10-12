"use client";
import { useEffect, useRef } from "react";
import Link from "next/link";
import { workflowGoalOptions } from "./workflow-goals";

export function WorkflowStart({open,onClose}:{open:boolean;onClose:()=>void}) {
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const node=dialog.current;if(!node)return;if(open&&!node.open)node.showModal();else if(!open&&node.open)node.close();},[open]);
  return <dialog ref={dialog} className="workflow-start-dialog" aria-labelledby="workflow-start-title" onCancel={onClose} onClose={onClose} onClick={event=>{if(event.target===event.currentTarget){const box=event.currentTarget.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)onClose();}}}><button type="button" className="ghost-button workflow-start-close" aria-label="بستن انتخاب جریان" onClick={onClose}>×</button><section className="workflow-start" aria-labelledby="workflow-start-title">
    <h2 id="workflow-start-title">برای چه کاری جریان می‌سازی؟</h2>
    <p>یک مسیر آماده انتخاب کن و تنظیمات خودت را کامل کن. تا ذخیره و فعال‌کردن، کاری اجرا نمی‌شود.</p>
    <div className="workflow-start-grid">
      {workflowGoalOptions.map((goal) => <Link className="card workflow-start-card" key={goal.id} href={`/workflows/new?goal=${goal.id}`} onClick={onClose}>
        <h3>{goal.title}</h3><p>{goal.description}</p><span>شروع این مسیر ←</span>
      </Link>)}
    </div>
    <div className="workflow-start-actions">
      <Link className="ghost-button" href="/workflows/new" onClick={onClose}>بوم خالی · ساخت حرفه‌ای</Link>
      <Link className="ghost-button" href="/workflows/new?ai=1" onClick={onClose}>ساخت جریان با هوش مصنوعی</Link>
    </div>
  </section></dialog>;
}
