"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandLogo } from "./brand-logo";
import { apiFetch } from "../lib/session";

type Step = { key: string; type: string; name: string; subtitle: string; config: Record<string, unknown> };
type Account = { id: string; channel: string; displayName: string | null; externalAccountId: string; isActive: boolean };
type Activity = { run: { id: string; status: string; createdAt: string } | null; publication: { status: string; createdAt: string; publishedAt: string | null; externalUrl: string | null } | null };
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
const errors: Record<string, string> = { invalid_rss_url: "نشانی RSS باید HTTPS عمومی باشد", eitaa_account_required: "کانال ایتا را انتخاب کن", eitaa_account_not_found: "اتصال ایتا معتبر نیست", ai_token_not_configured: "توکن AI را تنظیم کن", auto_workflow_requires_rss_ai_and_eitaa_in_order: "ابتدا منبع RSS و سپس مرحله‌های موردنظر را اضافه کن" };
const availableTypes = ["rss_source", "manual_input", "ai", "human_approval", "draft", "publish"];
const upcomingChannels = ["اینستاگرام", "تلگرام", "بله", "X"];

export function WorkflowBuilder() {
  const router = useRouter();
  const [mode, setMode] = useState<"manual" | "auto">("auto");
  const [steps, setSteps] = useState<Step[]>([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [name, setName] = useState("جریان جدید");
  const [prompt, setPrompt] = useState("");
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [aiReady, setAiReady] = useState(false);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("آماده ذخیره");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [insertAt, setInsertAt] = useState<number | null>(null);

  useEffect(() => {
    void Promise.all([apiFetch("/social-accounts"), apiFetch("/settings/ai")]).then(async ([accountsResponse, aiResponse]) => {
      if (accountsResponse.ok) setAccounts(await accountsResponse.json());
      if (aiResponse.ok) setAiReady((await aiResponse.json()).configured);
    }).catch(() => {});
    const id = new URLSearchParams(window.location.search).get("id");
    if (!id) return;
    const loadActivity = () => void apiFetch(`/workflows/${encodeURIComponent(id)}/activity`)
      .then(async (response) => response.ok ? response.json() : null).then(setActivity).catch(() => {});
    loadActivity();
    const timer = window.setInterval(loadActivity, 30_000);
    void apiFetch(`/workflows/${encodeURIComponent(id)}`).then(async (response) => {
      if (!response.ok) throw new Error("جریان پیدا نشد");
      return response.json();
    }).then((data: { workflow: { id: string; name: string; autonomyMode: string; status: string }; version: { prompt: string | null } | null;
      steps: Array<{ key: string; type: string; name: string; config: Record<string, unknown>; order: number }> }) => {
      setWorkflowId(data.workflow.id); setName(data.workflow.name); setPrompt(data.version?.prompt ?? "");
      const automatic = data.workflow.autonomyMode === "full_auto";
      setMode(automatic ? "auto" : "manual"); setAutoEnabled(automatic && data.workflow.status === "active");
      const loaded = [...data.steps].sort((a, b) => a.order - b.order).map((step) => ({ ...step, config: step.config ?? {},
        subtitle: [...autoSteps, ...manualSteps].find((item) => item.type === step.type)?.subtitle ?? "مرحله سفارشی" }));
      setSteps(loaded); setSelectedKey(loaded[0]?.key ?? ""); setMessage("جریان بارگذاری شد");
    }).catch((error) => setMessage(error instanceof Error ? error.message : "بارگذاری ناموفق بود"));
    return () => window.clearInterval(timer);
  }, []);

  const eitaaAccounts = useMemo(() => accounts.filter((account) => account.channel === "eitaa" && account.isActive), [accounts]);
  const selected = steps.find((step) => step.key === selectedKey) ?? steps[0];
  const feedUrl = String(steps.find((step) => step.type === "rss_source")?.config.feedUrl ?? "");
  const accountId = String(steps.find((step) => step.type === "publish")?.config.accountId ?? "");
  const updateConfig = (key: string, field: string, value: string) => setSteps((current) => current.map((step) =>
    step.key === key ? { ...step, config: { ...step.config, [field]: value } } : step));
  const validOrder = (items: Step[]) => {
    const types = items.map((item) => item.type);
    if (!types.length) return true;
    return ["rss_source", "manual_input"].includes(types[0]) &&
      !types.slice(1).some((type) => ["rss_source", "manual_input"].includes(type)) &&
      types.every((type) => availableTypes.includes(type) && types.filter((other) => other === type).length === 1) &&
      (!types.includes("publish") || types.at(-1) === "publish");
  };
  const relocated = (items: Step[], from: number, to: number) => {
    const next = [...items]; next.splice(to, 0, next.splice(from, 1)[0]); return next;
  };
  const canMove = (from: number, to: number) => to >= 0 && to < steps.length && validOrder(relocated(steps, from, to));
  const move = (from: number, to: number) => { if (from !== to && canMove(from, to)) setSteps((current) => relocated(current, from, to)); };
  const addOptions = (index: number) => {
    const candidates = steps.length ? ["ai", "human_approval", "draft", "publish"] : ["rss_source", "manual_input"];
    return candidates.filter((type) => !steps.some((step) => step.type === type) &&
      validOrder([...steps.slice(0, index + 1), { ...[...manualSteps, ...autoSteps].find((step) => step.type === type)! }, ...steps.slice(index + 1)]));
  };
  const add = (type: string, index: number) => {
    if (!addOptions(index).includes(type)) return;
    const template = [...manualSteps, ...autoSteps].find((step) => step.type === type)!;
    const item = { ...template, key: `${type}-${Date.now()}` };
    setSteps((current) => [...current.slice(0, index + 1), item, ...current.slice(index + 1)]);
    if (type === "rss_source" || type === "manual_input") setMode(type === "rss_source" ? "auto" : "manual");
    setSelectedKey(item.key); setInsertAt(null);
  };
  const remove = (step: Step) => {
    if (["rss_source", "manual_input"].includes(step.type)) {
      setSteps([]); setMode("auto"); setSelectedKey(""); setAutoEnabled(false);
      setMessage("منبع حذف شد؛ مراحل وابسته هم از بوم برداشته شدند. برای اعمال، ذخیره کن.");
      return;
    }
    setSteps((current) => current.filter((item) => item.key !== step.key));
    if (selectedKey === step.key) setSelectedKey(steps[0]?.key ?? "");
  };
  const save = async (active = autoEnabled) => {
    setBusy(true); setMessage("در حال ذخیره...");
    try {
      if (!name.trim()) throw new Error("نام جریان را وارد کن");
      if (!validOrder(steps)) throw new Error("ترتیب مراحل جریان معتبر نیست");
      if (active && (mode !== "auto" || steps.length < 2 || !feedUrl)) throw new Error("برای فعال‌سازی، منبع RSS و دست‌کم یک مرحلهٔ دیگر لازم است");
      if (active && steps.some((step) => step.type === "ai") && !aiReady) throw new Error("برای اجرای کارت AI، توکن هوش مصنوعی را تنظیم کن");
      if (active && steps.some((step) => step.type === "publish") && !accountId) throw new Error("برای انتشار، کانال ایتا را انتخاب کن");
      const connections = steps.slice(0, -1).map((step, index) => ({ sourceKey: step.key, targetKey: steps[index + 1].key }));
      const body = { name: name.trim(), description: steps.map((step) => step.name).join(" ← ") || "بوم خالی",
        status: mode === "auto" && active ? "active" : "draft", autonomyMode: mode === "auto" ? "full_auto" : "assisted", prompt,
        steps: steps.map((step, order) => ({ key: step.key, type: step.type, name: step.name,
          config: step.config, position: { x: order * 220, y: 0 }, order })), connections };
      const response = await apiFetch(workflowId ? `/workflows/${workflowId}` : "/workflows", {
        method: workflowId ? "PUT" : "POST", body: JSON.stringify(body),
      });
      if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(errors[error.error] ?? error.error ?? `ذخیره ناموفق (${response.status})`); }
      const data = await response.json(); setWorkflowId(data.workflow.id); setAutoEnabled(mode === "auto" && active);
      if (!workflowId) window.history.replaceState(null, "", `/workflows/new?id=${data.workflow.id}`);
      void apiFetch(`/workflows/${data.workflow.id}/activity`).then(async (response) => response.ok ? response.json() : null).then(setActivity).catch(() => {});
      setMessage(active && mode === "auto" ? "✓ پایش خودکار فعال شد" : "✓ تغییرات ذخیره شد");
      return data.workflow.id as string;
    } catch (error) { setMessage(error instanceof Error ? error.message : "ذخیره ناموفق بود"); return null; }
    finally { setBusy(false); }
  };
  const run = async () => {
    if (!prompt.trim()) { setMessage("برای اجرای دستی، متن را وارد کن"); return; }
    if (!steps.some((step) => step.type === "manual_input")) { setMessage("ابتدا کارت ورودی دستی را اضافه کن"); return; }
    if (steps.some((step) => step.type === "ai") && !aiReady) { setMessage("برای اجرای AI، توکن آن را تنظیم کن"); return; }
    if (steps.some((step) => step.type === "publish") && !accountId) { setMessage("برای انتشار، کانال ایتا را انتخاب کن"); return; }
    const id = await save(false); if (!id) return;
    setBusy(true);
    try {
      const response = await apiFetch(`/workflows/${id}/runs`, { method: "POST", body: JSON.stringify({ trigger: "manual", input: { prompt } }) });
      if (!response.ok) throw new Error("اجرای جریان ناموفق بود");
      const data = await response.json(); router.push(`/runs/${data.id}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "اجرای جریان ناموفق بود"); }
    finally { setBusy(false); }
  };
  const statusText = !steps.length ? "بوم خالی · هنوز جریانی ساخته نشده" : mode === "auto" ? autoEnabled ? "● پایش فعال · هر ۵ دقیقه" : "○ پیش‌نویس · ارسال خاموش" : "اجرای دستی";
  const activityLabel = activity?.publication?.status === "published" ? "آخرین ارسال موفق" : activity?.publication?.status === "failed" ? "آخرین ارسال ناموفق" : activity?.run?.status === "failed" ? "آخرین اجرای ناموفق" : "آخرین فعالیت";
  return <main className="workflow-page builder-page">
    <header className="app-header"><div className="brand-lockup"><BrandLogo /><span>میز کار / {name}</span></div>
      <div className="header-actions"><span className="save-status" role="status">{message}</span>
        <button className="ghost-button" onClick={() => void save(autoEnabled)} disabled={busy}>ذخیره تغییرات</button>
        {mode === "auto" ? <button className="primary-button" onClick={() => void save(!autoEnabled)} disabled={busy || !steps.length}>
          {autoEnabled ? "توقف پایش" : "فعال‌سازی خودکار"}</button>
          : <button className="primary-button" onClick={() => void run()} disabled={busy || !prompt.trim()}>▶ اجرای جریان</button>}
      </div></header>
    <div className="builder-layout">
      <section className="builder-workspace" aria-label="بوم جریان">
        <div className="builder-toolbar"><div><h1>میز کار جریان</h1><p>از یک منبع شروع کن، سپس مرحله‌ها را به انتخاب خودت اضافه کن.</p></div>
          <div className="builder-toolbar-actions"><span className={`status-pill ${autoEnabled ? "is-live" : ""}`}>{statusText}</span>
            {steps.length && addOptions(steps.length - 1).length ? <button className="ghost-button" onClick={() => setInsertAt(insertAt === steps.length - 1 ? null : steps.length - 1)}>+ افزودن کارت</button> : null}</div></div>
        <div className="builder-activity"><strong>{activityLabel}</strong><span>{activity?.publication ? `${activity.publication.status === "published" ? "منتشر شد" : activity.publication.status === "failed" ? "نیاز به بررسی" : "در صف انتشار"} · ${new Date(activity.publication.publishedAt ?? activity.publication.createdAt).toLocaleString("fa-IR")}` : activity?.run ? `${activity.run.status} · ${new Date(activity.run.createdAt).toLocaleString("fa-IR")}` : "هنوز خبری پردازش نشده است"}</span>
          {activity?.publication?.status === "failed" ? <Link href="/analytics">بررسی خطا ←</Link> : activity?.publication?.externalUrl ? <a href={activity.publication.externalUrl} target="_blank" rel="noreferrer">دیدن خبر ↗</a> : null}</div>
        <div className="builder-canvas">{!steps.length ? <div className="builder-empty"><div className="builder-empty-icon">+</div><h2>جریان خودت را بساز</h2><p>بوم خالی است. یکی از منابع را انتخاب کن؛ بعد می‌توانی AI، تأیید، پیش‌نویس یا انتشار را به مسیر اضافه کنی.</p>
          <div className="builder-empty-actions"><button onClick={() => add("rss_source", -1)}>+ خبر از RSS</button><button onClick={() => add("manual_input", -1)}>+ ورودی دستی</button></div></div> : <div className="builder-node-list">{steps.map((step, index) => <div className="builder-stage" key={step.key}>
          <article className={`builder-node ${dragIndex === index ? "dragging" : ""} ${selected?.key === step.key ? "selected" : ""}`}
            draggable onDragStart={() => setDragIndex(index)} onDragEnd={() => setDragIndex(null)}
            onDragOver={(event) => { if (dragIndex !== null && canMove(dragIndex, index)) event.preventDefault(); }}
            onDrop={(event) => { event.preventDefault(); if (dragIndex !== null) move(dragIndex, index); setDragIndex(null); }}>
            <button className="builder-node-select" onClick={() => setSelectedKey(step.key)} aria-pressed={selected?.key === step.key}>
              <span className="builder-node-top"><span className="builder-node-icon">{labels[step.type] ?? "کارت"}</span><span>۰{index + 1}</span></span>
              <strong>{step.name}</strong><small>{step.type === "rss_source" && feedUrl ? (() => { try { return new URL(feedUrl).hostname; } catch { return step.subtitle; } })() : step.type === "publish" && accountId ? eitaaAccounts.find((a) => a.id === accountId)?.displayName ?? step.subtitle : step.subtitle}</small>
            </button><div className="builder-node-actions">
              <button onClick={() => move(index, index - 1)} disabled={!canMove(index, index - 1)} aria-label={`انتقال ${step.name} به راست`}>→</button>
              <button onClick={() => move(index, index + 1)} disabled={!canMove(index, index + 1)} aria-label={`انتقال ${step.name} به چپ`}>←</button>
              <button onClick={() => remove(step)} aria-label={`حذف ${step.name}`}>×</button>
            </div>
          </article>{index < steps.length - 1 ? <div className="builder-insert"><span aria-hidden="true">←</span>{addOptions(index).length ? <div className="builder-insert-wrap">
            <button className="builder-insert-button" onClick={() => setInsertAt(insertAt === index ? null : index)} aria-label={`افزودن مرحله پس از ${step.name}`} aria-expanded={insertAt === index}>+</button>
            {insertAt === index ? <div className="builder-insert-options">{addOptions(index).map((type) => <button key={type} onClick={() => add(type, index)}>{type === "publish" ? "انتشار ایتا" : type === "draft" ? "پیش‌نویس" : type === "ai" ? "بازنویسی AI" : "تأیید انسانی"}</button>)}</div> : null}</div> : null}</div> : null}
        </div>)}{insertAt === steps.length - 1 && addOptions(steps.length - 1).length ? <div className="builder-end-options">{addOptions(steps.length - 1).map((type) => <button key={type} onClick={() => add(type, steps.length - 1)}>+ {type === "publish" ? "انتشار ایتا" : type === "draft" ? "پیش‌نویس" : type === "ai" ? "بازنویسی AI" : "تأیید انسانی"}</button>)}</div> : null}</div>}</div>
        <div className="builder-hint">برای انتشار، کارت «انتشار ایتا» را به انتهای مسیر اضافه کن. انتشار به‌صورت پیش‌فرض در هیچ جریان تازه‌ای فعال نیست.</div>
        <div className="builder-channels"><strong>کانال‌های انتشار</strong><div><span className="channel-ready">ایتا · قابل افزودن از کارت‌ها</span>{upcomingChannels.map((channel) => <button className="channel-upcoming" key={channel} disabled title="در نسخه‌های بعدی فعال می‌شود">{channel} · به‌زودی</button>)}</div></div>
      </section>
      <aside className="builder-settings"><h2>تنظیمات جریان</h2><label><span>نام جریان</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <div className="builder-help"><strong>روش اجرا</strong><p>{!steps.length ? "با انتخاب اولین کارت مشخص می‌شود." : mode === "auto" ? "خبر خودکار از RSS" : "ورودی دستی"}</p></div>
        {selected ? <div className="builder-selected-title"><small>تنظیمات کارت انتخاب‌شده</small><strong>{selected.name}</strong><p>{selected.subtitle}</p></div> : <div className="builder-help"><p>اولین کارت را از بوم انتخاب کن تا تنظیماتش اینجا نمایش داده شود.</p></div>}
        {selected?.type === "rss_source" ? <label><span>آدرس خوراک RSS</span><input type="url" dir="ltr" placeholder="https://example.com/feed.xml" value={feedUrl}
          onChange={(event) => updateConfig(selected.key, "feedUrl", event.target.value)} /></label>
        : selected?.type === "publish" ? <><label><span>کانال ایتا</span><select value={accountId} onChange={(event) => updateConfig(selected.key, "accountId", event.target.value)}>
          <option value="">انتخاب کانال</option>{eitaaAccounts.map((account) => <option key={account.id} value={account.id}>{account.displayName ?? account.externalAccountId}</option>)}</select></label>
          {!eitaaAccounts.length ? <Link className="builder-note" href="/connections">+ ابتدا کانال ایتا را وصل کن</Link> : null}</>
        : selected?.type === "ai" ? <><label><span>دستور بازنویسی این جریان</span><textarea value={String(selected.config.instructions ?? "")}
          onChange={(event) => updateConfig(selected.key, "instructions", event.target.value)} maxLength={3000}
          placeholder="مثلاً: خبر را در دو جملهٔ کوتاه و بی‌طرف برای کانال ایتا بازنویسی کن. نام‌ها و اعداد را حفظ کن." /></label>
          <small className="builder-note">دستورهای این کارت برای هر خبر همین جریان اجرا می‌شوند. اطلاعات تازه خارج از متن منبع ساخته نمی‌شود.</small>
          <Link className="builder-note" href="/settings/ai">{aiReady ? "✓ توکن AI تنظیم شده · تغییر مدل" : "+ توکن و مدل AI را تنظیم کن"}</Link></>
        : selected?.type === "manual_input" ? <label><span>متن ورودی</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="متن خبر یا موضوع را بنویس" /></label>
        : selected ? <div className="builder-help"><p>{selected.type === "human_approval" ? "هر خبر پیش از ادامه منتظر تأیید تو می‌ماند." : "متن خروجی برای مشاهده و ویرایش در استودیو نگهداری می‌شود."}</p></div> : null}
        {mode === "auto" && !autoEnabled && steps.length ? <div className="builder-help"><strong>پیش از فعال‌سازی</strong><p>برای AI توکن همان سرویس و برای انتشار، کانال ایتا را تنظیم کن. کارت‌هایی را که لازم نداری اضافه نکن.</p></div> : null}
      </aside>
    </div>
  </main>;
}
