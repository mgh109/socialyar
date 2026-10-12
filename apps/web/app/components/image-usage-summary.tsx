"use client";
import { useEffect,useState } from "react";
import { apiFetch } from "../lib/session";
export function ImageUsageSummary({workflowId,period="30d"}:{workflowId?:string;period?:string}){
 const [totals,setTotals]=useState<{images:number;requests:number;failed:number;costMicros:number;estimated:boolean;inputTokens:number;outputTokens:number}|null>(null);const [error,setError]=useState("");
 useEffect(()=>{let active=true;let loading=false;const load=async()=>{if(loading)return;loading=true;try{const r=await apiFetch(`/analytics/image-usage?period=${period}${workflowId?`&workflowId=${workflowId}`:""}`);if(!r.ok)throw new Error("گزارش تصویر در دسترس نیست.");const data=await r.json();if(active){setTotals(data.totals);setError(data.capped?"گزارش به ۱۰۰۰ درخواست اخیر محدود است.":"");}}catch{if(active)setError("گزارش تصویر در دسترس نیست.");}finally{loading=false;}};void load();const timer=setInterval(()=>void load(),30000);return()=>{active=false;clearInterval(timer);};},[workflowId,period]);
 return <section aria-label="مصرف تولید تصویر"><strong>تولید تصویر</strong>{totals?<><p>{totals.requests.toLocaleString("fa-IR")} درخواست · {totals.images.toLocaleString("fa-IR")} تصویر · {totals.failed.toLocaleString("fa-IR")} خطا · {(totals.costMicros/1e6).toLocaleString("fa-IR")} دلار {totals.estimated?"(شامل برآورد و رزرو)":"گزارش‌شده"}</p><p>توکن گزارش‌شده: ورودی {totals.inputTokens.toLocaleString("fa-IR")} · خروجی {totals.outputTokens.toLocaleString("fa-IR")}</p></>:null}{error?<small role="status">{error}</small>:null}</section>;
}
