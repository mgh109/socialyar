"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, getStoredUser, refreshSession, requireOk, saveSession } from "../../lib/session";
export default function PasswordPage() {
 const router=useRouter();const [currentPassword,setCurrent]=useState("");const [newPassword,setNew]=useState("");const [confirm,setConfirm]=useState("");const [busy,setBusy]=useState(false);const [message,setMessage]=useState("");const [phone,setPhone]=useState("");
 const submit=async(event:FormEvent)=>{event.preventDefault();if(newPassword!==confirm){setMessage("تکرار رمز عبور یکسان نیست.");return;}setBusy(true);setMessage("");try{const session=await requireOk(await apiFetch("/auth/password",{method:"POST",body:JSON.stringify({currentPassword,newPassword,...(!getStoredUser()?.phone?{phone}:{})})}),"تغییر رمز انجام نشد؛ رمز فعلی و شرایط رمز جدید را بررسی کنید.");saveSession(session);await refreshSession();router.replace("/");}catch(error){setMessage(error instanceof Error?error.message:"تغییر رمز انجام نشد.");}finally{setBusy(false);}};
 return <main className="settings-page"><h1>تغییر رمز عبور</h1><section className="settings-card"><p>{getStoredUser()?.mustChangePassword?"برای شروع کار، رمز عبور اولیه را با رمز شخصی خودتان جایگزین کنید.":"رمز عبور حساب خود را تغییر دهید."}</p><form className="auth-form" onSubmit={submit}>
 {!getStoredUser()?.phone?<label><span>شماره همراه برای ورودهای بعدی</span><input required dir="ltr" inputMode="tel" value={phone} onChange={e=>setPhone(e.target.value)}/></label>:null}
 <label><span>رمز فعلی</span><input type="password" dir="ltr" autoComplete="current-password" required value={currentPassword} onChange={e=>setCurrent(e.target.value)}/></label>
 <label><span>رمز جدید، حداقل ۱۰ نویسه</span><input type="password" dir="ltr" autoComplete="new-password" minLength={10} maxLength={128} required value={newPassword} onChange={e=>setNew(e.target.value)}/></label>
 <label><span>تکرار رمز جدید</span><input type="password" dir="ltr" autoComplete="new-password" required value={confirm} onChange={e=>setConfirm(e.target.value)}/></label>
 {message?<p role="alert">{message}</p>:null}<button className="primary-button" disabled={busy}>{busy?"در حال ذخیره…":"ذخیره رمز جدید"}</button></form></section></main>;
}
