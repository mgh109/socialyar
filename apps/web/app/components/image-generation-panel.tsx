"use client";
import { FieldHelp } from "./field-help";
import Link from "next/link";
import { useEffect, useState } from "react";
import { imagePresets, imageConfigSchema } from "@socialyar/shared";
import { apiFetch } from "../lib/session";
type Profile={id:string;name:string;provider:string;model:string};
type Job={id:string;status:string;model:string;imageCount:number;costMicros:number|null;reservedMicros:number;costEstimated:boolean;images:Array<{url:string}>;error:string|null;createdAt:string};
type Usage={totals:{images:number;requests:number;failed:number;costMicros:number;estimated:boolean;inputTokens:number;outputTokens:number};jobs:Job[];capped:boolean};
const defaults=imageConfigSchema.partial({model:true}).parse({});
const labels={youtube:"کاور یوتیوب",reel:"کاور ریلز",story:"استوری",news:"تصویر خبر",square:"مربع",custom:"اندازه دلخواه"};
export function ImageGenerationPanel({config,update,profiles,workflowId,stepKey}:{config:Record<string,unknown>;update:(key:string,value:unknown)=>void;profiles:Profile[];workflowId?:string|null;stepKey:string}){
 const value={...defaults,...config};
 const [usage,setUsage]=useState<Usage|null>(null);const [error,setError]=useState("");
 useEffect(()=>{if(!workflowId)return;let live=true;let loading=false;const load=async()=>{if(loading)return;loading=true;try{const r=await apiFetch(`/analytics/image-usage?workflowId=${workflowId}&stepKey=${encodeURIComponent(stepKey)}`);if(!r.ok)throw new Error("گزارش مصرف تصویر در دسترس نیست.");const data=await r.json();if(live){setUsage(data);setError("");}}catch(e){if(live)setError(e instanceof Error?e.message:"گزارش دریافت نشد.");}finally{loading=false;}};void load();const timer=setInterval(()=>void load(),15000);return()=>{live=false;clearInterval(timer);};},[workflowId,stepKey]);
 const text=(key:string,label:string,max=1000)=> <label key={key}><span>{label}</span><input maxLength={max} dir={key.endsWith("Url")||key==="model"?"ltr":undefined} value={String(value[key as keyof typeof value]??"")} onChange={e=>update(key,e.target.value)}/></label>;
 const numeric=(key:string,label:string,min:number,max:number,nullable=false,scale=1)=> <label key={key}><span>{label}</span><input type="number" min={min} max={max} step={scale===1?1:0.001} value={value[key as keyof typeof value]==null?"":Number(value[key as keyof typeof value])/scale} placeholder={nullable?"بدون محدودیت":undefined} onChange={e=>update(key,e.target.value===""&&nullable?null:Math.round(Number(e.target.value)*scale))}/></label>;
 return <section className="image-generation-panel">
  <label><span>اتصال و کلید هوش مصنوعی<FieldHelp>مدل از اتصال انتخاب‌شده استفاده می‌شود؛ اتصال باید مدل دارای قابلیت تولید تصویر داشته باشد. <Link href="/settings/ai">مدیریت اتصال‌ها و کلیدها</Link></FieldHelp></span><select value={String(value.profileId)} onChange={e=>update("profileId",e.target.value)}><option value="">انتخاب اتصال</option>{profiles.map(p=><option key={p.id} value={p.id}>{p.name} · {p.provider} · {p.model}</option>)}</select></label>

  <label><span>نوع و اندازه تصویر</span><select value={String(value.preset)} onChange={e=>update("preset",e.target.value)}>{Object.entries(labels).map(([key,label])=><option value={key} key={key}>{label}{key!=="custom"?` · ${imagePresets[key as keyof typeof imagePresets].join(" × ")}`:""}</option>)}</select></label>
  {value.preset==="custom"?<>{numeric("width","عرض، پیکسل",256,4096)}{numeric("height","ارتفاع، پیکسل",256,4096)}</>:null}
  <label><span>کیفیت تولید</span><select value={String(value.quality)} onChange={e=>update("quality",e.target.value)}><option value="low">اقتصادی</option><option value="medium">متوسط</option><option value="high">بالا</option></select></label>
  <label><span>رفتار با تصویر موجود</span><select value={String(value.behavior)} onChange={e=>update("behavior",e.target.value)}><option value="missing">فقط اگر تصویر ندارد</option><option value="always">همیشه تصویر تازه بساز</option><option value="edit">تصویر ورودی را ویرایش کن</option></select></label>
  <label><input type="checkbox" checked={value.invalidAsMissing===true} onChange={e=>update("invalidAsMissing",e.target.checked)}/> لینک تصویر نامعتبر را بدون تصویر حساب کن</label>
  <label><span>دستور تولید تصویر<FieldHelp>متغیرها: {"{{عنوان}}"} و {"{{متن}}"}. عنوان، متن، ویدئو و زمان انتشار محتوا حفظ می‌شوند.</FieldHelp></span><textarea rows={5} maxLength={4000} value={String(value.instructions)} onChange={e=>update("instructions",e.target.value)}/></label>
  {text("style","سبک تصویر؛ واقعی، مینیمال، تصویرسازی…",200)}{text("brandColors","رنگ‌ها و هویت برند",200)}{text("referenceUrl","لینک عمومی تصویر مرجع")}{text("logoUrl","لینک عمومی لوگو")}{text("overlayText","نوشته روی تصویر؛ می‌تواند {{عنوان}} باشد",300)}
  <label><span>رنگ نوشته<FieldHelp>متن فارسی و لوگو پس از تولید روی تصویر قرار می‌گیرند. چند خروجی ساخته می‌شود؛ خروجی اول به انتشار می‌رود و همه در پیش‌نمایش دیده می‌شوند.</FieldHelp></span><input type="color" value={String(value.textColor)} onChange={e=>update("textColor",e.target.value)}/></label>

  <details open><summary>مصرف و محدودیت‌ها</summary>
   {numeric("count","تعداد تصویر برای هر محتوا",1,4)}{numeric("maxPerRun","حداکثر تصویر در هر اجرا",1,4)}{numeric("estimatedCostMicros","هزینه برآوردی هر تصویر، دلار",0.001,100,false,1000000)}
   {numeric("dailyLimit","حداکثر تعداد روزانه",0,100000,true)}{numeric("monthlyLimit","حداکثر تعداد ماهانه",0,1000000,true)}{numeric("dailyBudgetMicros","بودجه روزانه، دلار",0,2147,true,1000000)}{numeric("monthlyBudgetMicros","بودجه ماهانه، دلار",0,2147,true,1000000)}
   <label><span>پس از پایان سهمیه یا بودجه<FieldHelp>برآورد را مطابق تعرفه مدل، اندازه و کیفیت تنظیم کنید. بودجه با این برآورد رزرو می‌شود؛ مبلغ نهایی سرویس ممکن است بیشتر باشد. سقف مدیر سامانه هم اعمال می‌شود. روز و ماه به وقت تهران محاسبه می‌شوند.</FieldHelp></span><select value={String(value.onLimit)} onChange={e=>update("onLimit",e.target.value)}><option value="stop">توقف این شاخه</option><option value="wait">انتظار تا تجدید سهمیه</option><option value="continue">ادامه با تصویر قبلی یا بدون تصویر</option></select></label>

  </details>
  <label><span>در صورت خطای تولید</span><select value={String(value.onError)} onChange={e=>update("onError",e.target.value)}><option value="stop">توقف</option><option value="review">ارسال برای بررسی انسانی</option><option value="continue">ادامه با تصویر قبلی یا بدون تصویر</option></select></label>
  <label><FieldHelp>برای شیت، آماده‌سازی تصویر پیش از تأیید داخلی مجموعه انجام می‌شود. این کارت ویدئو تولید نمی‌کند.</FieldHelp><input type="checkbox" checked={value.requireApproval===true} onChange={e=>update("requireApproval",e.target.checked)}/> تصویر تولیدشده قبل از ادامه تأیید شود</label>

  {error?<p role="status">{error}</p>:null}
  {usage?<><h3>مصرف این کارت</h3><p>{usage.totals.images.toLocaleString("fa-IR")} تصویر · {usage.totals.failed.toLocaleString("fa-IR")} خطا · {(usage.totals.costMicros/1e6).toLocaleString("fa-IR")} دلار {usage.totals.estimated?"(شامل برآورد و رزرو)":"گزارش‌شده"}</p><p>توکن گزارش‌شده: ورودی {usage.totals.inputTokens.toLocaleString("fa-IR")} · خروجی {usage.totals.outputTokens.toLocaleString("fa-IR")}</p>{usage.capped?<small>گزارش به ۱۰۰۰ درخواست اخیر محدود است.</small>:null}{usage.jobs.map(job=><article key={job.id}><small>{new Date(job.createdAt).toLocaleString("fa-IR",{timeZone:"Asia/Tehran"})} · {({reserved:"در حال تولید یا نتیجه نامعلوم",completed:"ساخته شد",failed:"ناموفق",rejected:"رد درخواست توسط سرویس"} as Record<string,string>)[job.status]} · {job.model}</small>{job.error?<p>{job.error}</p>:null}<div className="image-generation-previews">{job.images.map(image=><a key={image.url} href={image.url} target="_blank" rel="noreferrer"><img src={image.url} alt="تصویر تولیدشده" loading="lazy"/></a>)}</div></article>)}</>:null}
 </section>;
}
