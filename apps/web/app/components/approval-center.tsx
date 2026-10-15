"use client";
import Link from "next/link";
import {useEffect,useMemo,useRef,useState} from "react";
import {WorkflowApprovalCard,type WorkflowApproval} from "./workflow-approval-card";
import {YoutubeReview} from "./youtube-panel";
import {ContentApprovalReview} from "./content-approval-review";
import {BrandLogo} from "./brand-logo";
import {useApprovalInbox} from "../hooks/use-approval-inbox";
import {approvalInbox,approvalChannels,filterApprovalInbox,type ApprovalRow,type InboxState} from "../lib/approval-inbox";
import {apiFetch,getWorkspaceId} from "../lib/session";
import {persianError} from "../lib/persian";
import {faDigits} from "../lib/persian-calendar";
const states=[{id:"pending",label:"منتظر تأیید"},{id:"attention",label:"نیازمند رسیدگی"},{id:"running",label:"در حال اجرا"},{id:"all",label:"همه"}] as const;
export function ApprovalCenter(){
  const inbox=useApprovalInbox(getWorkspaceId());
  const [selected,setSelected]=useState<string|null>(null),[state,setState]=useState<InboxState|"all">("pending"),[channel,setChannel]=useState(""),[search,setSearch]=useState("");
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState<{text:string;error?:boolean}|null>(null);
  const entries=useMemo(()=>approvalInbox(inbox.workflows,inbox.youtube,inbox.content),[inbox.workflows,inbox.youtube,inbox.content]);
  const filtered=useMemo(()=>filterApprovalInbox(entries,state,channel,search),[entries,state,channel,search]);
  const active=filtered.find(item=>item.key===selected)??filtered[0];
  const detail=useRef<HTMLElement>(null);
  useEffect(()=>{detail.current?.scrollTo({top:0});if(selected)detail.current?.focus({preventScroll:true});},[active?.key,selected]);
  const unavailable=active && Boolean(inbox.errors[active.kind]);
  const post=async(path:string,payload:unknown)=>{const response=await apiFetch(path,{method:"POST",body:JSON.stringify(payload)});const data=await response.json();if(!response.ok)throw new Error(data.error??"ثبت تصمیم ناموفق بود.");return data;};
  const perform=async(action:()=>Promise<unknown>,text:string)=>{
    setBusy(true);setNotice(null);
    try{await action();await inbox.refresh(true);setNotice({text});return true;}
    catch(error){setNotice({text:persianError(error,"ثبت تصمیم ناموفق بود؛ دوباره تلاش کنید."),error:true});await inbox.refresh(true);return false;}
    finally{setBusy(false);}
  };
  const resolveWorkflow=async(item:WorkflowApproval,action:"approve"|"reject",edit?:{title?:string;text?:string;reply?:string})=>{
    await perform(()=>post(`/runs/${item.runId}/approval`,{action,stepKey:item.stepKey,edit}),action==="approve"?"تأیید شد؛ ادامهٔ جریان در حال انجام است.":"محتوا رد شد.");
  };
  const resolveContent=async(row:ApprovalRow,action:"approve"|"reject"|"changes_requested")=>{
    await perform(()=>post(`/approvals/${row.approval.id}/resolve`,{action}),action==="approve"?"محتوا تأیید شد.":action==="reject"?"محتوا رد شد.":"محتوا برای اصلاح برگشت داده شد.");
  };
  const saveContent=async(row:ApprovalRow,title:string,body:string)=>perform(()=>post(`/calendar/items/variant/${row.variant.id}`,{action:"edit",version:row.variant.calendarVersion,updatedAt:row.variant.updatedAt,title,body,timezone:"Asia/Tehran"}),"تغییرات ذخیره شد؛ محتوا را بررسی و تأیید کنید.");
  const channels=[...new Set(entries.map(item=>item.channel))];
  return <main className="workflow-page review-page" dir="rtl">
    <header className="app-header review-page-header"><div className="brand-lockup"><BrandLogo/><h1>تأیید محتوا <span>{faDigits(entries.filter(item=>item.state==="pending").length)}</span></h1></div><Link className="ghost-link" href="/calendar">تقویم انتشار ←</Link></header>
    <section className="review-workspace">
      <div className="review-toolbar"><nav className="review-tabs" aria-label="وضعیت محتوا">{states.map(tab=><button type="button" key={tab.id} disabled={busy} aria-pressed={state===tab.id} onClick={()=>{setState(tab.id);setSelected(null);}}>{tab.label}<span>{faDigits(tab.id==="all"?entries.length:entries.filter(item=>item.state===tab.id).length)}</span></button>)}</nav>
        <button type="button" className="ghost-button review-refresh" disabled={busy||inbox.refreshing} onClick={()=>void inbox.refresh(true)} title={inbox.updatedAt?`آخرین دریافت ${new Date(inbox.updatedAt).toLocaleTimeString("fa-IR",{timeZone:"Asia/Tehran"})}`:undefined}>{inbox.refreshing?"در حال دریافت…":"↻ به‌روزرسانی"}</button>
      </div>
      {notice ? <div className={`review-notice ${notice.error?"error":"success"}`} role={notice.error?"alert":"status"}>{notice.text}<button type="button" aria-label="بستن پیام" onClick={()=>setNotice(null)}>×</button></div> : null}
      {Object.keys(inbox.errors).length ? <p className="review-notice error" role="alert">{Object.values(inbox.errors).join("، ")} به‌روز نیست؛ پیش از تصمیم، «به‌روزرسانی» را بزنید.</p> : null}
      <div className={`review-layout${selected?" has-selection":""}`}>
        <aside className="review-queue" aria-label="فهرست محتواها"><div className="review-search"><label><span className="sr-only">جست‌وجوی محتوا</span><input type="search" value={search} disabled={busy} placeholder="جست‌وجو در محتوا…" onChange={event=>{setSearch(event.target.value);setSelected(null);}}/></label><label><span className="sr-only">فیلتر شبکه</span><select value={channel} disabled={busy} onChange={event=>{setChannel(event.target.value);setSelected(null);}}><option value="">همهٔ شبکه‌ها</option>{channels.map(value=><option key={value} value={value}>{approvalChannels[value]??value}</option>)}</select></label></div>
          <div className="review-queue-caption"><span>{faDigits(filtered.length)} محتوا</span><span>قدیمی‌ترها در ابتدا</span></div>
          <div className="review-list">{inbox.loading?<div className="review-empty" role="status">در حال دریافت محتواها…</div>:filtered.length?filtered.map(item=><button type="button" key={item.key} className={`review-list-item${item.key===active?.key?" active":""}`} disabled={busy} aria-current={item.key===active?.key?"true":undefined} onClick={()=>setSelected(item.key)}>
            <span className={`review-channel-icon ${item.channel}`} aria-hidden="true">{item.channel==="youtube"?"▶":item.channel==="workflow"?"◇":"▤"}</span><span className="review-list-copy"><strong>{item.title}</strong><span>{item.excerpt||"بدون توضیحات"}</span><small>{approvalChannels[item.channel]??item.channel} · {item.context}</small></span>{item.state==="attention"?<span className="review-attention-dot" aria-label="نیازمند رسیدگی"/>:null}
          </button>):<div className="review-empty"><span aria-hidden="true">✓</span><strong>{search||channel?"محتوایی پیدا نشد":Object.keys(inbox.errors).length?"دریافت فهرست کامل نشد":state==="pending"?"محتوایی منتظر تأیید نیست":"این فهرست خالی است"}</strong>{search||channel?<button type="button" className="ghost-button" onClick={()=>{setSearch("");setChannel("");}}>پاک‌کردن فیلترها</button>:<p>محتواهای تازه اینجا نمایش داده می‌شوند.</p>}</div>}</div>
        </aside>
        <section ref={detail} tabIndex={-1} className="review-detail" aria-label="بررسی محتوای انتخاب‌شده"><button type="button" className="ghost-button review-back" disabled={busy} onClick={()=>setSelected(null)}>→ بازگشت به فهرست</button>
          {active?<><header className="review-detail-header"><div><span>{approvalChannels[active.channel]??active.channel}</span><strong>{active.context}</strong></div><span className={`review-state ${active.state}`}>{states.find(tab=>tab.id===active.state)?.label}</span></header>
            {active.kind==="workflow"?<WorkflowApprovalCard key={active.key} item={active.data} busy={busy||Boolean(unavailable)} resolve={resolveWorkflow}/>:active.kind==="youtube"?<YoutubeReview key={active.key} item={active.data} refresh={()=>void inbox.refresh(true)} reviewMode disabled={busy||Boolean(unavailable)} onBusyChange={setBusy} onActionResult={action=>setNotice({text:action==="reject"?"محتوا رد شد.":action==="retry"?"ادامهٔ کار درخواست شد.":active.data.scheduledAt?"انتشار در زمان تعیین‌شده تأیید شد.":"تأیید شد؛ ویدئو در صف انتشار است."})}/>:<ContentApprovalReview key={active.key} row={active.data} busy={busy||Boolean(unavailable)} resolve={resolveContent} save={saveContent}/>}</>:<div className="review-empty review-all-clear"><span aria-hidden="true">✓</span><h2>{inbox.loading?"در حال دریافت محتوا…":Object.keys(inbox.errors).length?"صف نیازمند به‌روزرسانی است":"موردی برای بررسی نیست"}</h2><p>انتشارهای زمان‌بندی‌شده را در تقویم ببینید.</p><Link className="ghost-link" href="/calendar">رفتن به تقویم</Link></div>}
        </section>
      </div>
    </section>
  </main>;
}
