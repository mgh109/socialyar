"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch, refreshSession, requireOk, saveSession, type AuthSession } from "../lib/session";
export default function AccountPage() {
 const [session,setSession]=useState<Omit<AuthSession,"accessToken">|null>(null);const [busy,setBusy]=useState(false);const [message,setMessage]=useState("");
 useEffect(()=>{void refreshSession().then(setSession).catch(error=>setMessage(error.message));},[]);
 const switchWorkspace=async(workspaceId:string)=>{setBusy(true);setMessage("");try{const data=await requireOk(await apiFetch("/auth/switch-workspace",{method:"POST",body:JSON.stringify({workspaceId})}),"تغییر سازمان انجام نشد.");saveSession(data);window.location.assign("/");}catch(error){setMessage(error instanceof Error?error.message:"تغییر سازمان انجام نشد.");setBusy(false);}};
 return <main className="settings-page"><Link href="/">← میز کار</Link><h1>حساب کاربری</h1><section className="settings-card"><p>شماره همراه</p><strong dir="ltr">{session?.user.phone??session?.user.email??"…"}</strong><p>شناسه حساب</p><strong dir="ltr">{session?.user.id??"…"}</strong><p>نام</p><strong>{session?.user.name||"ثبت نشده"}</strong><p>سازمان فعلی</p><strong>{session?.workspace.name??"…"}</strong>
 {(session?.workspaces?.length??0)>1?<label><span>انتخاب سازمان</span><select disabled={busy} value={session?.workspace.id??""} onChange={event=>void switchWorkspace(event.target.value)}>{session?.workspaces?.map(workspace=><option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label>:null}
 <p>مدیر سامانه برای پشتیبانی و مدیریت اشتراک، اطلاعات کانال‌ها، جریان‌ها، وضعیت فعالیت و مصرف سازمان را مشاهده می‌کند؛ مشاهده او ثبت می‌شود.</p><p><Link className="ghost-link" href="/account/password">تغییر رمز عبور</Link></p>{session?.membership?.role==="manager"||session?.membership?.role==="owner"?<p><Link href="/settings/team">مدیریت اعضای سازمان</Link></p>:null}{session?.user.isPlatformAdmin?<p><Link href="/platform">مدیریت سازمان‌ها و اشتراک‌ها</Link></p>:null}{message?<p role="alert">{message}</p>:null}</section></main>;
}
