"use client";

import Link from "next/link";
import { useState } from "react";

export type WorkflowApproval = { runId: string; workflowName: string; stepKey: string; stepName: string;
  output: { title?: string | null; text?: string; imageUrl?: string | null; videoUrl?: string | null;
    commentId?: string; reply?: string; decision?: string; reason?: string } | null; createdAt: string | null };

export function WorkflowApprovalCard({ item, busy, resolve }: { item: WorkflowApproval; busy: boolean;
  resolve: (item: WorkflowApproval, action: "approve" | "reject", edit?: { title?: string; text?: string; reply?: string }) => Promise<void> }) {
  const [title, setTitle] = useState(item.output?.title ?? "");
  const [text, setText] = useState(item.output?.text ?? "");
  const [reply, setReply] = useState(item.output?.reply ?? "");
  const isReply = item.output?.decision === "reply";
  const isComment = Boolean(item.output?.commentId);
  return <article className="workflow-approval-card">
    <small>{item.workflowName} · {item.stepName}</small>
    {isComment ? <strong>{isReply ? "پاسخ پیشنهادی به" : "بررسی"} کامنت #{item.output?.commentId}</strong> : null}
    {!isComment ? <label className="workflow-approval-field"><span>عنوان محتوا</span>
      <input value={title} maxLength={300} onChange={(event) => setTitle(event.target.value)} /></label>
      : null}
    {item.output?.imageUrl ? <img src={item.output.imageUrl} alt="تصویر محتوا برای بررسی" loading="lazy" style={{ objectFit: "contain" }} /> : null}
    {item.output?.videoUrl ? <video src={item.output.videoUrl} controls preload="metadata" aria-label="ویدئوی خبر برای بررسی" /> : null}
    {isComment ? <><p className="workflow-approval-comment" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>کامنت: {item.output?.text}</p>
      {item.output?.reason ? <small>دلیل پیشنهاد: {item.output.reason}</small> : null}
      {isReply ? <label className="workflow-approval-field"><span>متن پاسخی که بعد از تأیید ارسال می‌شود</span>
        <textarea value={reply} maxLength={3000} onChange={(event) => setReply(event.target.value)} rows={5} /></label> : null}</> :
      <label className="workflow-approval-field"><span>متن کامل محتوا</span>
        <textarea value={text} maxLength={20000} onChange={(event) => setText(event.target.value)} rows={8} /></label>}
    <div><button className="ghost-button" disabled={busy} onClick={() => void resolve(item, "reject")}>رد این شاخه</button>
      <button className="primary-button" disabled={busy || !item.output || (!isComment && !text.trim()) || (isReply && !reply.trim())}
        onClick={() => void resolve(item, "approve", isReply ? { reply: reply.trim() } : isComment ? undefined : { title: title.trim(), text: text.trim() })}>
        {isReply ? "تأیید و ارسال پاسخ" : isComment ? "تأیید کامنت" : "تأیید و ادامه"}</button>
      {item.output?.imageUrl ? <a href={item.output.imageUrl} target="_blank" rel="noreferrer">دیدن تصویر کامل</a> : null}
      <Link href={`/runs/${item.runId}`}>جزئیات اجرا</Link></div>
  </article>;
}

