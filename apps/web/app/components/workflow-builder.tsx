"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandLogo } from "./brand-logo";
import { apiFetch } from "../lib/session";

type Step = { key: string; type: string; name: string; subtitle: string; config: Record<string, unknown> };
type Account = { id: string; channel: string; displayName: string | null; externalAccountId: string; isActive: boolean };

const manualSteps: Step[] = [
  { key: "input", type: "manual_input", name: "متن ورودی", subtitle: "ورود دستی متن", config: {} },
  { key: "review", type: "human_approval", name: "تأیید انسانی", subtitle: "بررسی پیش از ادامه", config: {} },
  { key: "draft", type: "draft", name: "پیش‌نویس", subtitle: "قابل ویرایش در استودیو", config: {} },
];
const autoSteps: Step[] = [
  { key: "rss", type: "rss_source", name: "منبع خبر", subtitle: "خوراک RSS", config: { feedUrl: "" } },
  { key: "ai", type: "ai", name: "بازنویسی AI", subtitle: "مدل انتخاب‌شده در تنظیمات", config: {} },
  { key: "publish", type: "publish", name: "انتشار ایتا", subtitle: "کانال متصل", config: { accountId: "" } },
];
const labels: Record<string, string> = { rss_source: "RSS", manual_input: "ورودی", ai: "AI", human_approval: "تأیید", draft: "متن", publish: "ایتا" };

export function WorkflowBuilder() {
  const router = useRouter();
  const [mode, setMode] = useState<"manual" | "auto">("auto");
  const [steps, setSteps] = useState<Step[]>(autoSteps);
  const [name, setName] = useState("خبرهای ایتا");
  const [prompt, setPrompt] = useState("");
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [aiReady, setAiReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("آماده ذخیره");
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  useEffect(() => {
    void Promise.all([apiFetch("/social-accounts"), apiFetch("/settings/ai")]).then(async ([accountsResponse, aiResponse]) => {
      if (accountsResponse.ok) setAccounts(await accountsResponse.json());
      if (aiResponse.ok) setAiReady((await aiResponse.json()).configured);
    }).catch(() => {});
    const id = new URLSearchParams(window.location.search).get("id");
    if (!id) return;
    void apiFetch(`/workflows/${encodeURIComponent(id)}`).then(async (response) => {
      if (!response.ok) throw new Error("جریان پیدا نشد");
      return response.json();
    }).then((data: {
      workflow: { id: string; name: string; autonomyMode: string; status: string };
      version: { prompt: string | null } | null;
      steps: Array<{ key: string; type: string; name: string; config: Record<string, unknown>; order: number }>;
    }) => {
      setWorkflowId(data.workflow.id);
      setName(data.workflow.name);
      setPrompt(data.version?.prompt ?? "");
      const automatic = data.workflow.autonomyMode === "full_auto";
      setMode(automatic ? "auto" : "manual");
      setAutoEnabled(automatic && data.workflow.status === "active");
      setSteps(data.steps.sort((a, b) => a.order - b.order).map((step) => ({
        ...step, config: step.config ?? {},
        subtitle: [...autoSteps, ...manualSteps].find((item) => item.type === step.type)?.subtitle ?? "مرحله سفارشی",
      })));
      setMessage("جریان بارگذاری شد");
    }).catch((error) => setMessage(error instanceof Error ? error.message : "بارگذاری ناموفق بود"));
  }, []);

  const eitaaAccounts = useMemo(() => accounts.filter((account) => account.channel === "eitaa" && account.isActive), [accounts]);
  const feedUrl = String(steps.find((step) => step.type === "rss_source")?.config.feedUrl ?? "");
  const accountId = String(steps.find((step) => step.type === "publish")?.config.accountId ?? "");
  const updateConfig = (key: string, field: string, value: string) => setSteps((current) => current.map((step) =>
    step.key === key ? { ...step, config: { ...step.config, [field]: value } } : step));
  const move = (from: number, to: number) => {
    if (to < 0 || to >= steps.length || from === to) return;
    setSteps((current) => { const next = [...current]; next.splice(to, 0, next.splice(from, 1)[0]); return next; });
  };
  const add = (type: "human_approval" | "draft" | "ai") => {
    if (steps.some((step) => step.type === type)) return;
    const template = [...manualSteps, ...autoSteps].find((step) => step.type === type)!;
    const at = steps.findIndex((step) => step.type === (mode === "auto" ? "publish" : "draft"));
    setSteps((current) => { const next = [...current]; next.splice(at < 0 ? next.length : at, 0, { ...template, key: `${type}-${Date.now()}` }); return next; });
  };
  const save = async (active = autoEnabled) => {
    setBusy(true); setMessage("در حال ذخیره...");
    try {
      if (!name.trim()) throw new Error("نام جریان را وارد کن");
      if (mode === "auto" && active && (!feedUrl || !accountId || !aiReady)) {
        throw new Error("برای فعال‌سازی، RSS، حساب ایتا و توکن AI لازم است");
      }
      const connections = steps.slice(0, -1).map((step, index) => ({ sourceKey: step.key, targetKey: steps[index + 1].key }));
      const body = { name: name.trim(), description: mode === "auto" ? `RSS → AI → ایتا` : prompt.slice(0, 180),
        status: mode === "auto" && active ? "active" : "draft",
        autonomyMode: mode === "auto" ? "full_auto" : "assisted", prompt,
        steps: steps.map((step, order) => ({ key: step.key, type: step.type, name: step.name,
          config: step.config, position: { x: order * 220, y: 0 }, order })), connections };
      const response = await apiFetch(workflowId ? `/workflows/${workflowId}` : "/workflows", {
        method: workflowId ? "PUT" : "POST", body: JSON.stringify(body),
      });
      if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error ?? `ذخیره ناموفق (${response.status})`); }
      const data = await response.json();
      setWorkflowId(data.workflow.id);
      setAutoEnabled(mode === "auto" && active);
      if (!workflowId) window.history.replaceState(null, "", `/workflows/new?id=${data.workflow.id}`);
      setMessage(active && mode === "auto" ? "✓ پایش خودکار فعال شد" : "✓ جریان ذخیره شد");
      return data.workflow.id as string;
    } catch (error) { setMessage(error instanceof Error ? error.message : "ذخیره ناموفق بود"); return null; }
    finally { setBusy(false); }
  };
  const run = async () => {
    if (!prompt.trim()) { setMessage("برای اجرای دستی، متن را وارد کن"); return; }
    const id = await save(false);
    if (!id) return;
    setBusy(true);
    try {
      const response = await apiFetch(`/workflows/${id}/runs`, { method: "POST", body: JSON.stringify({ trigger: "manual", input: { prompt } }) });
      if (!response.ok) throw new Error("اجرای جریان ناموفق بود");
      const data = await response.json(); router.push(`/runs/${data.id}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "اجرای جریان ناموفق بود"); }
    finally { setBusy(false); }
  };
  return <main className="workflow-page builder-page">
    <header className="app-header"><div className="brand-lockup"><BrandLogo /><span>میز کار / {name}</span></div>
      <div className="header-actions"><span className="save-status" role="status">{message}</span>
        <button className="ghost-button" onClick={() => void save(false)} disabled={busy}>ذخیره پیش‌نویس</button>
        {mode === "auto" ? <button className="primary-button" onClick={() => void save(!autoEnabled)} disabled={busy}>
          {autoEnabled ? "توقف پایش" : "فعال‌سازی خودکار"}</button>
          : <button className="primary-button" onClick={() => void run()} disabled={busy || !prompt.trim()}>▶ اجرای جریان</button>}
      </div>
    </header>
    <div className="builder-layout">
      <section className="builder-workspace" aria-label="بوم جریان">
        <div className="builder-toolbar"><div><h1>میز کار جریان</h1><p>کارت‌ها را بکش و جابه‌جا کن؛ ترتیب اجرا مطابق ترتیب همین کارت‌هاست.</p></div>
          <div className="builder-toolbar-actions"><span className="status-pill">{mode === "auto" ? autoEnabled ? "● فعال" : "○ پیش‌نویس" : "اجرای دستی"}</span>
            <button className="ghost-button" onClick={() => add(mode === "auto" ? "human_approval" : "ai")}>+ {mode === "auto" ? "تأیید انسانی" : "بازنویسی AI"}</button>
            {mode === "auto" ? <button className="ghost-button" onClick={() => add("draft")}>+ پیش‌نویس</button> : null}</div>
        </div>
        <div className="builder-canvas"><div className="builder-node-list">
          {steps.map((step, index) => <article className={`builder-node ${dragIndex === index ? "dragging" : ""}`} key={step.key}
            draggable onDragStart={() => setDragIndex(index)} onDragEnd={() => setDragIndex(null)}
            onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (dragIndex !== null) move(dragIndex, index); setDragIndex(null); }}>
            <div className="builder-node-top"><span className="builder-node-icon">{labels[step.type] ?? "کارت"}</span><span>۰{index + 1}</span></div>
            <h2>{step.name}</h2><p>{step.subtitle}</p>
            <div className="builder-node-actions"><button onClick={() => move(index, index - 1)} disabled={index === 0} aria-label={`انتقال ${step.name} به راست`}>→</button>
              <button onClick={() => move(index, index + 1)} disabled={index === steps.length - 1} aria-label={`انتقال ${step.name} به چپ`}>←</button>
              {!["rss_source", "manual_input", "ai", "publish"].includes(step.type) ? <button onClick={() => setSteps((current) => current.filter((item) => item.key !== step.key))} aria-label={`حذف ${step.name}`}>×</button> : null}</div>
          </article>)}
        </div></div>
        <div className="builder-hint">{mode === "auto" ? "هر ۵ دقیقه RSS بررسی می‌شود؛ خبرهای تازه پس از بازنویسی به کانال انتخاب‌شده می‌روند." : "اجرای دستی متن را به تأیید و سپس استودیوی محتوا می‌فرستد."}</div>
      </section>
      <aside className="builder-settings"><h2>تنظیمات جریان</h2><label><span>نام جریان</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label><span>روش اجرا</span><select value={mode} onChange={(event) => { const next = event.target.value as "manual" | "auto"; setMode(next); setSteps(next === "auto" ? autoSteps : manualSteps); setAutoEnabled(false); }}>
          <option value="auto">خبر خودکار از RSS</option><option value="manual">ورودی دستی</option></select></label>
        {mode === "auto" ? <>
          <label><span>آدرس خوراک RSS</span><input type="url" dir="ltr" placeholder="https://example.com/feed.xml" value={feedUrl}
            onChange={(event) => updateConfig(steps.find((step) => step.type === "rss_source")?.key ?? "", "feedUrl", event.target.value)} /></label>
          <label><span>کانال ایتا</span><select value={accountId} onChange={(event) => updateConfig(steps.find((step) => step.type === "publish")?.key ?? "", "accountId", event.target.value)}>
            <option value="">انتخاب کانال</option>{eitaaAccounts.map((account) => <option key={account.id} value={account.id}>{account.displayName ?? account.externalAccountId}</option>)}
          </select></label>
          {!eitaaAccounts.length ? <Link className="builder-note" href="/connections">+ ابتدا توکن و شناسه کانال ایتا را وصل کن</Link> : null}
          <Link className="builder-note" href="/settings/ai">{aiReady ? "✓ توکن AI تنظیم شده · تغییر مدل" : "+ توکن و مدل AI را تنظیم کن"}</Link>
        </> : <label><span>متن ورودی</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="متن خبر یا موضوع را بنویس" /></label>}
        <div className="builder-help"><strong>کنترل انتشار</strong><p>برای بررسی هر خبر قبل از ارسال، کارت «تأیید انسانی» را اضافه کن. بدون آن، ارسال بعد از تولید متن خودکار است.</p></div>
      </aside>
    </div>
  </main>;
}
