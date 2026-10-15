"use client";
import Link from "next/link";
import {useEffect,useState} from "react";
import type {ApprovalRow} from "../lib/approval-inbox";
import {MediaPreview} from "./youtube-panel";
export function ContentApprovalReview({row,busy,resolve,save}:{row:ApprovalRow;busy:boolean;resolve:(row:ApprovalRow,action:"approve"|"reject"|"changes_requested")=>Promise<void>;save:(row:ApprovalRow,title:string,body:string)=>Promise<boolean>}){
  const [editing,setEditing]=useState(false),[title,setTitle]=useState(row.variant.title??row.content.title??""),[body,setBody]=useState(row.variant.body);
  useEffect(()=>{if(!editing){setTitle(row.variant.title??row.content.title??"");setBody(row.variant.body);}},[row.variant.updatedAt,editing]);
  const settings=row.variant.settings??{},metadata=row.content.metadata??{};
  const image=settings.imageUrl??metadata.imageUrl,video=settings.videoUrl??metadata.videoUrl;
  const prepared=settings.imagePrepared!==false;
  return <article className="review-reading-card">
    {image||video?<section className="review-media"><MediaPreview url={image}/>{video?<details><summary>پخش ویدئو</summary><MediaPreview video url={video}/></details>:null}</section>:null}
    <div className="review-copy">{editing?<><label className="review-field">عنوان<input autoFocus value={title} maxLength={300} disabled={busy} onChange={event=>setTitle(event.target.value)}/></label><label className="review-field">متن محتوا<textarea value={body} rows={10} maxLength={20000} disabled={busy} onChange={event=>setBody(event.target.value)}/></label></>:<><h2>{title||"بدون عنوان"}</h2><p className="review-body">{body}</p><button type="button" className="ghost-button review-edit" disabled={busy||row.variant.calendarVersion===undefined} onClick={()=>setEditing(true)}>ویرایش متن</button></>}</div>
    {row.approval.agentRecommendation||row.approval.reason||row.content.runId?<details className="review-extra"><summary>جزئیات بررسی</summary>{row.approval.agentRecommendation?<p>{row.approval.agentRecommendation}</p>:null}{row.approval.reason?<p>{row.approval.reason}</p>:null}{row.content.runId?<Link href={`/runs/${row.content.runId}`}>گزارش اجرا ←</Link>:null}</details>:null}
    {!prepared?<p className="review-notice" role="status">رسانه در حال آماده‌سازی است؛ پس از آماده‌شدن می‌توانید تأیید کنید.</p>:null}
    <footer className="review-decision-actions">{editing?<><button type="button" className="primary-button" disabled={busy||!title.trim()||!body.trim()} onClick={async()=>{if(await save(row,title,body))setEditing(false);}}>ذخیره تغییرات</button><button type="button" className="ghost-button" disabled={busy} onClick={()=>setEditing(false)}>انصراف از ویرایش</button></>:<><button type="button" className="primary-button" disabled={busy||!prepared} onClick={()=>void resolve(row,"approve")}>{busy?"در حال ثبت…":"تأیید محتوا"}</button><button type="button" className="ghost-button" disabled={busy} onClick={()=>void resolve(row,"changes_requested")}>نیاز به اصلاح</button><button type="button" className="review-reject" disabled={busy} onClick={()=>void resolve(row,"reject")}>رد</button></>}</footer>
  </article>;
}
