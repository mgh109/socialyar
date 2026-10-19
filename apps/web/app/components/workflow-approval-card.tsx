"use client";
import type {WorkflowApproval} from "../lib/approval-types";
import Link from "next/link";
import {useState} from "react";
export type {WorkflowApproval} from "../lib/approval-types";
export function WorkflowApprovalCard({item,busy,resolve}:{item:WorkflowApproval;busy:boolean;resolve:(item:WorkflowApproval,action:"approve"|"reject",edit?:{title?:string;text?:string;reply?:string})=>Promise<void>}){
  const [title,setTitle]=useState(item.output?.title??""),[text,setText]=useState(item.output?.text??""),[reply,setReply]=useState(item.output?.reply??""),[editing,setEditing]=useState(false);
  const isReply=item.output?.decision==="reply",isComment=Boolean(item.output?.commentId);
  const images=[...new Set([item.output?.imageUrl,...(item.output?.images??[]).map(image=>image.url)].filter((url):url is string=>Boolean(url)))];
  return <article className="workflow-approval-card review-reading-card">
    <small className="review-card-context">{item.workflowName} · {item.stepName}</small>
    {images.length||item.output?.videoUrl?<section className="review-media">{images.map((url,index)=><img key={url} src={url} alt={`تصویر محتوا ${index+1}`} loading="lazy"/>)}{item.output?.videoUrl?<details><summary>پخش ویدئو</summary><video src={item.output.videoUrl} controls preload="none" aria-label="ویدئوی محتوا"/></details>:null}</section>:null}
    <div className="review-copy">{isComment?<><h2>{isReply?"پاسخ پیشنهادی":"بررسی کامنت"}</h2><blockquote className="workflow-approval-comment">{item.output?.text}</blockquote></>:null}
      {editing?<>{!isComment?<label className="review-field">عنوان<input autoFocus value={title} maxLength={300} disabled={busy} onChange={event=>setTitle(event.target.value)}/></label>:null}<label className="review-field">{isReply?"متن پاسخ":"متن محتوا"}<textarea autoFocus={isReply} value={isReply?reply:text} maxLength={isReply?3000:20000} disabled={busy} rows={8} onChange={event=>isReply?setReply(event.target.value):setText(event.target.value)}/></label><button type="button" className="ghost-button review-edit" disabled={busy} onClick={()=>setEditing(false)}>پایان ویرایش</button></>:<>{!isComment?<h2>{title||"بدون عنوان"}</h2>:null}{!isComment||isReply?<p className="review-body">{isReply?reply:text}</p>:null}{!isComment||isReply?<button type="button" className="ghost-button review-edit" disabled={busy} onClick={()=>setEditing(true)}>{isReply?"ویرایش پاسخ":"ویرایش متن"}</button>:null}</>}
    </div>
    {item.output?.imageGeneration?.error?<p className="review-notice error" role="status">{item.output.imageGeneration.error}</p>:null}
    <details className="review-extra"><summary>جزئیات بررسی</summary>{item.output?.reason?<p>{item.output.reason}</p>:null}{isComment?<p>شناسهٔ کامنت: <bdi>{item.output?.commentId}</bdi></p>:null}{item.output?.url?<a href={item.output.url} target="_blank" rel="noreferrer">مشاهدهٔ منبع ←</a>:null}<Link href={`/runs/${item.runId}`}>گزارش اجرا ←</Link></details>
    <footer className="review-decision-actions"><button type="button" className="primary-button" disabled={busy||!item.output||(!isComment&&!text.trim())||(isReply&&!reply.trim())} onClick={()=>void resolve(item,"approve",isReply?{reply:reply.trim()}:isComment?undefined:{title:title.trim(),text:text.trim()})}>{busy?"در حال ثبت…":item.output?.actionStatus==="referred"?"ثبت بررسی":item.output?.actionLabel?item.output.actionLabel:isReply?"تأیید و ارسال پاسخ":isComment?"تأیید کامنت":"تأیید و ادامه"}</button><button type="button" className="review-reject" disabled={busy} onClick={()=>void resolve(item,"reject")}>رد</button></footer>
  </article>;
}
