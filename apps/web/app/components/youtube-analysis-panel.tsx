"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { youtubeAnalysisConfig } from "@socialyar/shared";
import type { AnalysisActionState, AnalysisFollowUp, YoutubeGrowthPlan } from "@socialyar/shared";
import { apiFetch } from "../lib/session";

type Video = {id:string;title:string;views:number|null;likes:number|null;comments:number|null;format?:string;ageGroup?:string;ageDays?:number|null;viewsPerDay?:number|null};
type Analysis = {channel:{id:string;title:string;views:number|null;subscribers:number|null};windows?:{current:{start:string;end:string}};analytics:{current:Record<string,number|null>|null;changesPercent:Record<string,number|null>};sample:{readVideos:number;readComments:number};warnings:string[];videos:Video[];comments?:Array<{id:string;text:string}>};
type Report = {runId:string;stepKey:string;status:string;output:{text?:string;youtubeAnalysis?:Analysis;growthPlan?:YoutubeGrowthPlan;analysisActions?:Record<string,AnalysisActionState>;followUps?:AnalysisFollowUp[]}|null;error:{message?:string}|null;at:string|null;inputTokens?:number;outputTokens?:number;costMicros?:number;model?:string};
type Props={workflowId?:string|null;stepKey:string;config:Record<string,unknown>;update:(key:string,value:unknown)=>void;accounts:Array<{id:string;channel:string;isActive:boolean;displayName?:string|null;externalAccountId:string}>;profiles:Array<{id:string;name:string}>;run:()=>Promise<void>;busy:boolean};
const number=(n:number|null|undefined)=>n==null?"—":n.toLocaleString("fa-IR",{maximumFractionDigits:1});
const date=(value:string)=>new Date(value).toLocaleString("fa-IR",{timeZone:"Asia/Tehran",dateStyle:"short",timeStyle:"short"});
const ages:Record<string,string>={week:"تا ۷ روز",month:"۸ تا ۳۰ روز",quarter:"۳۱ تا ۹۰ روز",older:"بیش از ۹۰ روز",unknown:"سن نامشخص"};
const formats:Record<string,string>={short_candidate:"کوتاه؛ شورت تأیید نشده",long:"بیش از ۳ دقیقه",unknown:"مدت نامشخص"};
const status:Record<string,string>={failed:"تحلیل ناموفق",completed:"گزارش آماده",running:"در حال تحلیل",retrying:"تلاش دوباره",queued:"در صف"};
const tabs=[{id:"actions",label:"اقدام‌ها"},{id:"videos",label:"ویدئوها"},{id:"ideas",label:"ایده‌های محتوا"},{id:"followup",label:"پیگیری نتیجه"}] as const;
export function YoutubeAnalysisPanel({workflowId,stepKey,config,update,accounts,profiles,run,busy}:Props) {
  const [reports,setReports]=useState<Report[]>([]),[error,setError]=useState(""),[selectedRun,setSelectedRun]=useState("");
  const [tab,setTab]=useState<string>("actions"),[saving,setSaving]=useState(false),[group,setGroup]=useState("all"),[createdIdeas,setCreatedIdeas]=useState<Record<string,string>>({});
  useEffect(()=>{
    if(!workflowId)return;
    const controller=new AbortController();let fetching=false;
    const refresh=async()=>{
      if(fetching||document.hidden)return;fetching=true;
      try {const r=await apiFetch(`/workflows/${workflowId}/youtube-analysis?stepKey=${encodeURIComponent(stepKey)}`,{signal:controller.signal});if(!r.ok)throw new Error();const data=await r.json();if(!controller.signal.aborted){setReports(data);setError("");}}
      catch {if(!controller.signal.aborted)setError("گزارش دریافت نشد؛ دوباره اتصال را بررسی کنید.");}finally{fetching=false;}
    };
    void refresh();const timer=setInterval(()=>void refresh(),5000);
    return()=>{controller.abort();clearInterval(timer);};
  },[workflowId,stepKey]);
  const latest=reports[0],report=selectedRun?reports.find(r=>r.runId===selectedRun):reports.find(r=>r.output?.youtubeAnalysis),data=report?.output?.youtubeAnalysis,plan=report?.output?.growthPlan;
  const valid=youtubeAnalysisConfig.safeParse(config).success;
  const active=latest&&["running","queued","retrying"].includes(latest.status);
  const toggle=async(index:number,completed:boolean)=>{
    if(!report||!workflowId)return;setSaving(true);setError("");
    try {const r=await apiFetch(`/workflows/${workflowId}/youtube-analysis/${report.runId}/actions`,{method:"PATCH",body:JSON.stringify({stepKey,index,completed})});if(!r.ok)throw new Error();const states=await r.json();setReports(items=>items.map(item=>item.runId===report.runId?{...item,output:{...item.output,analysisActions:states}}:item));}
    catch {setError("ثبت وضعیت انجام نشد؛ دوباره تلاش کنید.");}finally{setSaving(false);}
  };
  const createIdea=async(index:number)=>{
    const idea=plan?.ideas[index];if(!idea||!report)return;setSaving(true);setError("");
    try {
      const prompt=`عنوان: ${idea.title}\nطرح محتوا: ${idea.outline}\nایده کاور: ${idea.cover}`;
      const r=await apiFetch("/workflows",{method:"POST",body:JSON.stringify({name:idea.title.slice(0,80),status:"draft",autonomyMode:"assisted",prompt,steps:[{key:"idea",type:"manual_input",name:"ایده منتخب",config:{},position:{x:600,y:100},order:0},{key:"write",type:"ai",name:"تولید پیش‌نویس",config:{profileId:config.profileId??"default",instructions:"بر اساس ایده ورودی یک طرح و متن ویدئوی فارسی بنویس. واقعیت تازه نساز."},position:{x:350,y:100},order:1},{key:"draft",type:"draft",name:"پیش‌نویس محتوا",config:{},position:{x:100,y:100},order:2}],connections:[{sourceKey:"idea",targetKey:"write"},{sourceKey:"write",targetKey:"draft"}]})});
      if(!r.ok)throw new Error();const value=await r.json();setCreatedIdeas(old=>({...old,[`${report.runId}:${index}`]:value.workflow.id}));
    }catch{setError("ساخت جریان محتوا انجام نشد؛ دسترسی ساخت جریان را بررسی کنید.");}finally{setSaving(false);}
  };
  const groups=Array.from(new Set(data?.videos.map(v=>`${v.format??"unknown"}:${v.ageGroup??"unknown"}`)));
  const filtered=data?.videos.filter(v=>group==="all"||`${v.format??"unknown"}:${v.ageGroup??"unknown"}`===group)??[];
  return <section className="youtube-analysis-panel">
    <header className="ya-heading"><div><strong>تحلیل و رشد کانال</strong><small>از آمار تا اقدام بعدی</small></div><span className="ya-badge">{latest?status[latest.status]??"در انتظار":"آماده شروع"}</span></header>
    <details className="ya-settings" open={!data}>
      <summary>تنظیمات تحلیل <span>{number(Number(config.days??28))} روز · {number(Number(config.videoLimit??20))} ویدئو</span></summary>
      <div className="ya-fields">
        <label>کانال یوتیوب<select value={String(config.accountId??"")} onChange={e=>update("accountId",e.target.value)}><option value="">انتخاب کانال</option>{accounts.filter(a=>a.channel==="youtube"&&a.isActive).map(a=><option key={a.id} value={a.id}>{a.displayName||a.externalAccountId}</option>)}</select></label>
        <label>اتصال هوش مصنوعی<select value={String(config.profileId??"default")} onChange={e=>update("profileId",e.target.value)}><option value="default">پیش‌فرض</option>{profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label>بازه بررسی<select value={String(config.days??28)} onChange={e=>update("days",Number(e.target.value))}>{Array.from(new Set([7,14,28,30,90,Number(config.days??28)])).sort((a,b)=>a-b).map(d=><option key={d} value={d}>{number(d)} روز</option>)}</select></label>
        <label>ویدئوهای اخیر<input type="number" min={1} max={50} value={Number(config.videoLimit??20)} onChange={e=>update("videoLimit",Number(e.target.value))}/></label>
        <label>نمونه کامنت‌ها<input type="number" min={0} max={200} value={Number(config.commentLimit??50)} onChange={e=>update("commentLimit",Number(e.target.value))}/></label>
        <label className="ya-full">هدف تحلیل<textarea rows={2} maxLength={4000} value={String(config.instructions??"")} placeholder="مثلاً افزایش بازدید دوره‌های آموزشی" onChange={e=>update("instructions",e.target.value)}/></label>
      </div>
      <small>برای نگهداری گزارش به پیش‌نویس وصل کن. با فعال‌کردن پایش، روزی یک گزارش ساخته می‌شود.</small>
    </details>
    <div className="ya-toolbar"><button type="button" className="primary-button" disabled={busy||saving||!valid||Boolean(active)} onClick={()=>void run()}>{busy?"در حال ثبت…":active?"تحلیل در حال انجام…":"اجرای تحلیل جدید"}</button><Link href="/connections">اتصال‌ها</Link></div>
    <small className="ya-muted">هر اجرا: حداکثر {number(Number(config.videoLimit??20))} ویدئو و {number(Number(config.commentLimit??50))} کامنت، تا ۴۰۹۶ توکن خروجی. هزینه به مدل و مصرف واقعی بستگی دارد؛ برآورد دلاری قطعی در دسترس نیست.</small>
    {error?<p className="ya-alert" role="alert">{error}</p>:null}
    {latest?.status==="failed"?<p className="ya-alert" role="alert">{latest.error?.message||"تحلیل ناموفق بود."} <Link href={`/runs/${latest.runId}`}>جزئیات خطا</Link></p>:null}
    {reports.length?<label className="ya-history">سابقه گزارش‌ها<select value={selectedRun} onChange={e=>{setSelectedRun(e.target.value);setGroup("all");setTab("actions");}}><option value="">آخرین گزارش آماده</option>{reports.map(r=><option key={r.runId} value={r.runId}>{r.at?date(r.at):"بدون تاریخ"} · {status[r.status]??r.status}</option>)}</select></label>:null}
    {!data?<div className="ya-empty"><strong>{active?"گزارش در حال آماده‌شدن است":"اولین تحلیل را شروع کن"}</strong><p>کانال و مدل را انتخاب کن؛ سه اقدام مهم و راهکارهای مبتنی بر آمار اینجا نمایش داده می‌شود.</p></div>:<>
      <div className="ya-report-title"><strong>{data.channel.title}</strong><small>{report?.at?date(report.at):""} · {number(data.sample.readVideos)} ویدئو · {number(data.sample.readComments)} کامنت</small></div>
      <div className="ya-metrics">{[{label:"بازدید بازه",value:data.analytics.current?.views},{label:"تغییر بازدید",value:data.analytics.changesPercent.views,suffix:"٪"},{label:"دقیقه تماشا",value:data.analytics.current?.estimatedMinutesWatched},{label:"مشترک‌های کانال",value:data.channel.subscribers}].map(item=><div key={item.label}><small>{item.label}</small><strong>{number(item.value)}{item.value!=null?item.suffix:""}</strong></div>)}</div>
      {data.windows?<small className="ya-muted">بازه Analytics: <bdi>{data.windows.current.start} — {data.windows.current.end}</bdi> · — یعنی داده در دسترس نیست.</small>:null}
      {plan?<p className="ya-summary">{plan.summary}</p>:null}
      <nav className="ya-tabs" aria-label="بخش‌های گزارش">{tabs.map(t=><button type="button" key={t.id} aria-pressed={tab===t.id} onClick={()=>setTab(t.id)}>{t.label}</button>)}</nav>
      {tab==="actions"?<div className="ya-stack">{plan?<><h4>اقدام‌های اولویت‌دار · سه مورد اول مهم‌ترند</h4>{plan.actions.map((action,index)=>{
        const done=report?.output?.analysisActions?.[index];
        return <article className={`ya-action ${done?"is-done":""}`} key={index}><header><span className="ya-rank">{number(index+1)}</span><strong>{action.title}</strong></header><p>{action.evidence}</p><small>معیار سنجش: {action.metric}</small><div className="ya-links">{action.videoIds.map(id=><a key={id} href={`https://www.youtube.com/watch?v=${encodeURIComponent(id)}`} target="_blank" rel="noreferrer">{data.videos.find(v=>v.id===id)?.title||"ویدئوی مرتبط"}</a>)}</div><button type="button" className="ghost-button" disabled={saving} onClick={()=>void toggle(index,!done)}>{done?"✓ انجام شد · لغو علامت":"انجام دادم"}</button>{done?<small>ثبت: {date(done.completedAt)} · مبنا: {date(done.baselineAt)}</small>:null}</article>;
      })}</>:<div className="youtube-analysis-text">{report?.output?.text}</div>}</div>:null}
      {tab==="videos"?<div className="ya-stack"><label>گروه مقایسه<select value={group} onChange={e=>setGroup(e.target.value)}><option value="all">همه ویدئوها؛ بدون رتبه‌بندی مقایسه‌ای</option>{groups.map(g=>{const [f,a]=g.split(":");return <option key={g} value={g}>{formats[f]} · {ages[a]}</option>;})}</select></label><small className="ya-muted">مقایسه را داخل گروه مشابه انجام بده. بازدید روزانه، میانگین از انتشار است و سرعت فعلی رشد نیست. مدت کوتاه به‌تنهایی شورت را ثابت نمی‌کند.</small>{filtered.map(v=><article className="ya-video" key={v.id}><a href={`https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}`} target="_blank" rel="noreferrer">{v.title}</a><small>{formats[v.format??"unknown"]} · سن: {number(v.ageDays)} روز</small><div><span>بازدید {number(v.views)}</span><span>میانگین روزانه {number(v.viewsPerDay)}</span><span>لایک {number(v.likes)}</span><span>کامنت {number(v.comments)}</span></div></article>)}</div>:null}
      {tab==="ideas"?<div className="ya-stack">{plan?.ideas.length?plan.ideas.map((idea,index)=>{const key=`${report?.runId}:${index}`,created=createdIdeas[key];return <article className="ya-action" key={index}><strong>{idea.title}</strong><p>{idea.outline}</p><small>کاور پیشنهادی: {idea.cover}</small>{idea.commentIds.map(id=><blockquote key={id}>{data.comments?.find(c=>c.id===id)?.text}</blockquote>)}{created?<Link href={`/workflows/new?id=${created}`}>بازکردن جریان محتوای ساخته‌شده ←</Link>:<button className="ghost-button" type="button" disabled={saving} onClick={()=>void createIdea(index)}>ساخت جریان محتوا از این ایده</button>}</article>;}):<p>برای این گزارش ایدهٔ ساختاریافته ثبت نشده است.</p>}</div>:null}
      {tab==="followup"?<div className="ya-stack"><p className="ya-muted">پس از انجام اقدام، «انجام دادم» را بزن. در تحلیل بعدی، تغییر شمارنده از گزارش مبنا بررسی می‌شود؛ این تغییر اثبات اثر اقدام نیست.</p>{report?.output?.followUps?.length?report.output.followUps.map((f,i)=><article key={i} className="ya-action"><strong>{f.title}</strong><p>بازدید مبنا: {number(f.baselineViews)} ← فعلی: {number(f.currentViews)} · تغییر: {number(f.delta)}</p><small>مبنای گزارش: {date(f.baselineAt)} · انجام اقدام: {date(f.completedAt)}</small><a href={`https://www.youtube.com/watch?v=${encodeURIComponent(f.videoId)}`} target="_blank" rel="noreferrer">ویدئوی مرتبط</a></article>):<div className="ya-empty">هنوز نتیجه‌ای برای پیگیری نیست. اقدام‌های بدون ویدئوی مرتبط به ارزیابی دستی نیاز دارند.</div>}</div>:null}
      <details className="ya-details"><summary>مصرف و محدودیت داده‌ها</summary><p>ورودی: {number(report?.inputTokens)} · خروجی: {number(report?.outputTokens)} توکن · هزینه: {report?.costMicros?`$${(report.costMicros/1000000).toFixed(5)}`:"گزارش نشده"}</p><p>بازدید تجمعی کانال: {number(data.channel.views)}</p>{data.warnings.map((w,i)=><p key={i}>{w}</p>)}{report?<Link href={`/runs/${report.runId}`}>جزئیات اجرای گزارش ←</Link>:null}</details>
    </>}
  </section>;
}
