"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandLogo } from "./brand-logo";
import { apiFetch } from "../lib/session";

type Position = { x: number; y: number };
type Step = { key: string; type: string; name: string; config: Record<string, unknown>; position: Position };
type Edge = { sourceKey: string; targetKey: string };
type Account = { id: string; channel: string; displayName: string | null; externalAccountId: string; isActive: boolean };
type Activity = { run: { status: string; createdAt: string } | null; publication: { status: string; publishedAt: string | null; externalUrl: string | null } | null; queueCount: number };
const isSource = (step: Step) => step.type === "rss_source" || step.type === "manual_input";
const isTerminal = (step: Step) => step.type === "publish" || step.type === "draft";
const sourceNames: Record<string, string> = { rss: "RSS", eitaa: "ایتا", bale: "بله" };
const types = [
  { type: "rss_source", kind: "rss", label: "منبع · RSS" },
  { type: "rss_source", kind: "eitaa", label: "منبع · ایتا" },
  { type: "rss_source", kind: "bale", label: "منبع · بله" },
  { type: "manual_input", label: "ورودی دستی" },
  { type: "filter", label: "شرط خبر" },
  { type: "ai", label: "بازنویسی AI" },
  { type: "human_approval", label: "تأیید انسانی" },
  { type: "draft", label: "پیش‌نویس" },
  { type: "publish", label: "انتشار ایتا" },
];
const errors: Record<string, string> = {
  graph_invalid_step: "یک کارت نامعتبر است.", graph_invalid_connection: "اتصال نامعتبر یا تکراری است.",
  graph_cycle: "اتصال حلقه‌ای مجاز نیست.", graph_missing_input: "همهٔ کارت‌های پردازش باید از یک منبع ورودی بگیرند.",
  graph_unfinished_branch: "هر شاخه باید به انتشار یا پیش‌نویس برسد.", graph_invalid_filter: "برای شرط، واژه‌های کلیدی وارد کن.",
  invalid_rss_url: "آدرس RSS باید HTTPS عمومی باشد.", invalid_eitaa_source: "شناسهٔ کانال ایتا معتبر نیست.",
  invalid_bale_source: "شناسهٔ کانال بله معتبر نیست.", eitaa_account_required: "کانال خروجی ایتا را انتخاب کن.",
  eitaa_account_not_found: "اتصال کانال ایتا معتبر نیست.", ai_token_not_configured: "توکن AI را تنظیم کن.",
  invalid_publish_interval: "فاصلهٔ انتشار معتبر نیست.",
  duplicate_publish_channel: "هر کانال خروجی را فقط به یک کارت انتشار وصل کن.",
};
const nodeWidth = 190;
const freshKey = () => `node-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function migrate(loaded: Step[], edges: Edge[]) {
  const steps: Step[] = [];
  const connections = [...edges];
  for (const step of loaded) {
    if (step.type !== "rss_source" || step.config.sourceKind) { steps.push(step); continue; }
    const feeds = Array.isArray(step.config.feedUrls) ? step.config.feedUrls : [step.config.feedUrl ?? ""];
    const eitaa = Array.isArray(step.config.eitaaChannels) ? step.config.eitaaChannels : [];
    const bale = Array.isArray(step.config.baleChannels) ? step.config.baleChannels : [];
    const sources = [
      ...feeds.filter((value) => typeof value === "string" && value.trim()).map((value) => ({ kind: "rss", feedUrl: value })),
      ...eitaa.map((value) => ({ kind: "eitaa", channel: value })),
      ...bale.map((value) => ({ kind: "bale", channel: value })),
    ];
    if (!sources.length) sources.push({ kind: "rss", feedUrl: "" });
    sources.forEach((config, index) => {
      const key = index ? freshKey() : step.key;
      steps.push({ ...step, key, name: "منبع", config: { sourceKind: config.kind, ...config },
        position: { x: step.position.x, y: step.position.y + index * 165 } });
      if (index) connections.push(...edges.filter((edge) => edge.sourceKey === step.key)
        .map((edge) => ({ sourceKey: key, targetKey: edge.targetKey })));
    });
  }
  return { steps, connections };
}

export function WorkflowBuilder() {
  const router = useRouter();
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ key: string; startX: number; startY: number; x: number; y: number } | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [connecting, setConnecting] = useState<string | null>(null);
  const [pointer, setPointer] = useState<Position | null>(null);
  const [name, setName] = useState("جریان جدید");
  const [prompt, setPrompt] = useState("");
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [aiReady, setAiReady] = useState(false);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("آماده ذخیره");
  const selected = steps.find((step) => step.key === selectedKey);
  const manual = steps.some((step) => step.type === "manual_input") && !steps.some((step) => step.type === "rss_source");
  const eitaaAccounts = accounts.filter((account) => account.channel === "eitaa" && account.isActive);

  useEffect(() => {
    void Promise.all([apiFetch("/social-accounts"), apiFetch("/settings/ai")]).then(async ([a, ai]) => {
      if (a.ok) setAccounts(await a.json());
      if (ai.ok) setAiReady((await ai.json()).configured);
    }).catch(() => {});
    const id = new URLSearchParams(window.location.search).get("id");
    if (!id) return;
    const refresh = () => void apiFetch(`/workflows/${encodeURIComponent(id)}/activity`)
      .then(async (response) => response.ok ? response.json() : null).then(setActivity).catch(() => {});
    refresh(); const timer = window.setInterval(refresh, 30_000);
    void apiFetch(`/workflows/${encodeURIComponent(id)}`).then(async (response) => {
      if (!response.ok) throw new Error("جریان پیدا نشد");
      return response.json();
    }).then((data: { workflow: { id: string; name: string; autonomyMode: string; status: string };
      version: { prompt: string | null } | null;
      steps: Array<{ key: string; type: string; name: string; config: Record<string, unknown>; position: Position; order: number }>;
      connections: Array<{ sourceKey?: string; targetKey?: string; sourceStepId: string; targetStepId: string }> }) => {
      setWorkflowId(data.workflow.id); setName(data.workflow.name); setPrompt(data.version?.prompt ?? "");
      setAutoEnabled(data.workflow.status === "active");
      const byId = new Map(data.steps.map((step) => [(step as typeof step & { id: string }).id, step.key]));
      const links = data.connections.map((edge) => ({ sourceKey: edge.sourceKey ?? byId.get(edge.sourceStepId) ?? "",
        targetKey: edge.targetKey ?? byId.get(edge.targetStepId) ?? "" })).filter((edge) => edge.sourceKey && edge.targetKey);
      const loaded = data.steps.sort((a, b) => a.order - b.order).map((step, index) => ({ ...step,
        position: step.position?.x || step.position?.y ? step.position : { x: 110 + index * 240, y: 230 } }));
      const migrated = migrate(loaded, links);
      setSteps(migrated.steps); setEdges(migrated.connections); setSelectedKey(migrated.steps[0]?.key ?? "");
      setMessage("جریان بارگذاری شد");
    }).catch((error) => setMessage(error instanceof Error ? error.message : "بارگذاری ناموفق بود"));
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (drag) {
        const x = Math.max(20, Math.min(1700, drag.x + event.clientX - drag.startX));
        const y = Math.max(20, Math.min(1050, drag.y + event.clientY - drag.startY));
        setSteps((current) => current.map((step) => step.key === drag.key ? { ...step, position: { x, y } } : step));
      }
      if (connecting && canvasRef.current) {
        const rect = canvasRef.current.getBoundingClientRect();
        setPointer({ x: event.clientX - rect.left + canvasRef.current.scrollLeft,
          y: event.clientY - rect.top + canvasRef.current.scrollTop });
      }
    };
    const up = () => { dragRef.current = null; };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [connecting]);

  const add = (type: string, kind?: string) => {
    const key = freshKey();
    const count = steps.length;
    const config = type === "rss_source" ? kind === "rss" ? { sourceKind: "rss", feedUrl: "" } :
      { sourceKind: kind, channel: "" } : type === "publish" ? { accountId: "", publishIntervalSeconds: 30 } :
      type === "filter" ? { keywords: "", mode: "include" } : {};
    const step = { key, type, name: type === "rss_source" ? "منبع" :
      types.find((item) => item.type === type)?.label ?? "کارت", config,
      position: { x: 80 + count % 5 * 250, y: 105 + Math.floor(count / 5) * 210 } };
    setSteps((current) => [...current, step]); setSelectedKey(key);
  };
  const update = (key: string, field: string, value: unknown) => setSteps((current) => current.map((step) =>
    step.key === key ? { ...step, config: { ...step.config, [field]: value } } : step));
  const remove = (key: string) => {
    setSteps((current) => current.filter((step) => step.key !== key));
    setEdges((current) => current.filter((edge) => edge.sourceKey !== key && edge.targetKey !== key));
    if (selectedKey === key) setSelectedKey("");
    setMessage("کارت حذف شد؛ تغییرات را ذخیره کن.");
  };
  const connect = (sourceKey: string, targetKey: string) => {
    const source = steps.find((step) => step.key === sourceKey), target = steps.find((step) => step.key === targetKey);
    setConnecting(null); setPointer(null);
    if (!source || !target || sourceKey === targetKey || isTerminal(source) || isSource(target)) {
      setMessage("این دو کارت نمی‌توانند در این جهت وصل شوند."); return;
    }
    if (edges.some((edge) => edge.sourceKey === sourceKey && edge.targetKey === targetKey)) return;
    const next = [...edges, { sourceKey, targetKey }];
    const visit = (key: string, seen = new Set<string>()): boolean => {
      if (key === sourceKey) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return next.filter((edge) => edge.sourceKey === key).some((edge) => visit(edge.targetKey, seen));
    };
    if (visit(targetKey)) { setMessage("اتصال حلقه‌ای مجاز نیست."); return; }
    setEdges(next); setMessage("اتصال اضافه شد؛ تغییرات را ذخیره کن.");
  };
  const save = async (active = autoEnabled) => {
    setBusy(true); setMessage("در حال ذخیره...");
    try {
      if (!name.trim()) throw new Error("نام جریان را وارد کن.");
      if (active && steps.some((step) => step.type === "ai") && !aiReady) throw new Error("برای اجرای AI، توکن را تنظیم کن.");
      const body = { name: name.trim(), description: `${steps.length} کارت · ${edges.length} اتصال`,
        status: active ? "active" : "draft", autonomyMode: manual ? "assisted" : "full_auto", prompt,
        steps: steps.map((step, order) => ({ ...step, order })), connections: edges };
      const response = await apiFetch(workflowId ? `/workflows/${workflowId}` : "/workflows", {
        method: workflowId ? "PUT" : "POST", body: JSON.stringify(body),
      });
      if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(errors[error.error] ?? error.error ?? `ذخیره ناموفق (${response.status})`); }
      const data = await response.json(); setWorkflowId(data.workflow.id); setAutoEnabled(active);
      if (!workflowId) window.history.replaceState(null, "", `/workflows/new?id=${data.workflow.id}`);
      setMessage(active ? "✓ جریان فعال شد" : "✓ تغییرات ذخیره شد");
      return data.workflow.id as string;
    } catch (error) { setMessage(error instanceof Error ? error.message : "ذخیره ناموفق بود"); return null; }
    finally { setBusy(false); }
  };
  const run = async () => {
    if (!prompt.trim()) { setMessage("متن ورودی را وارد کن."); return; }
    const source = steps.find((step) => step.type === "manual_input");
    if (!source) { setMessage("کارت ورودی دستی را اضافه کن."); return; }
    const id = await save(false); if (!id) return;
    setBusy(true);
    try {
      const response = await apiFetch(`/workflows/${id}/runs`, { method: "POST",
        body: JSON.stringify({ trigger: "manual", input: { prompt, sourceKey: source.key } }) });
      if (!response.ok) { const error = await response.json().catch(() => ({}));
        throw new Error(errors[error.error] ?? "اجرای جریان ناموفق بود"); }
      const data = await response.json(); router.push(`/runs/${data.id}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "اجرای جریان ناموفق بود"); }
    finally { setBusy(false); }
  };
  const stroke = (from: Position, to: Position) => `M ${from.x} ${from.y} C ${from.x - 92} ${from.y}, ${to.x + 92} ${to.y}, ${to.x} ${to.y}`;
  return <main className="workflow-page builder-page">
    <header className="app-header"><div className="brand-lockup"><BrandLogo /><span>میز کار / {name}</span></div>
      <div className="header-actions"><span className="save-status" role="status">{message}</span>
        <button className="ghost-button" onClick={() => void save(autoEnabled)} disabled={busy}>ذخیره تغییرات</button>
        {manual ? <button className="primary-button" onClick={() => void run()} disabled={busy}>▶ اجرای دستی</button> :
          <button className="primary-button" onClick={() => void save(!autoEnabled)} disabled={busy || !steps.length}>
            {autoEnabled ? "توقف پایش" : "فعال‌سازی خودکار"}</button>}
      </div></header>
    <div className="builder-layout"><section className="builder-workspace" aria-label="بوم جریان">
      <div className="graph-toolbar"><div><h1>میز کار جریان</h1><p>کارت را بکش؛ خروجی هر کارت را به ورودی کارت‌های مجاز وصل کن.</p></div>
        <span className="status-pill">{autoEnabled ? "● پایش فعال · هر ۵ دقیقه" : "○ پیش‌نویس"}</span></div>
      <div className="graph-palette">{types.map((item) => <button key={`${item.type}-${item.kind ?? ""}`} type="button" onClick={() => add(item.type, item.kind)}>
        + {item.label}</button>)}</div>
      {activity ? <div className="builder-activity"><strong>آخرین فعالیت</strong><span>{activity.publication?.status === "published" ? "منتشر شد" :
        activity.publication?.status === "failed" ? "ارسال ناموفق" : activity.publication ? "در صف انتشار" : activity.run?.status ?? "بدون خبر"}
        {activity.queueCount ? ` · ${activity.queueCount.toLocaleString("fa-IR")} خبر در صف` : ""}</span>
        {activity.publication?.externalUrl ? <a href={activity.publication.externalUrl} target="_blank" rel="noreferrer">دیدن خبر ↗</a> : null}</div> : null}
      <div className="graph-scroll" ref={canvasRef} onPointerUp={(event) => {
        if (connecting && event.target === event.currentTarget) { setConnecting(null); setPointer(null); }
      }}><div className="graph-surface">
        <svg className="graph-lines" width="1900" height="1200" aria-hidden="true">
          {edges.map((edge) => {
            const from = steps.find((step) => step.key === edge.sourceKey), to = steps.find((step) => step.key === edge.targetKey);
            if (!from || !to) return null;
            return <path key={`${edge.sourceKey}-${edge.targetKey}`} d={stroke({ x: from.position.x, y: from.position.y + 70 },
              { x: to.position.x + nodeWidth, y: to.position.y + 70 })} />;
          })}
          {connecting && pointer && steps.find((step) => step.key === connecting) ? <path className="preview" d={stroke({
            x: steps.find((step) => step.key === connecting)!.position.x,
            y: steps.find((step) => step.key === connecting)!.position.y + 70 }, pointer)} /> : null}
        </svg>
        {!steps.length ? <div className="graph-empty">بوم خالی است. از نوار بالا یک «منبع» اضافه کن.</div> : null}
        {steps.map((step) => <article key={step.key} className={`graph-node ${selectedKey === step.key ? "selected" : ""}`}
          style={{ left: step.position.x, top: step.position.y }} onClick={() => setSelectedKey(step.key)}>
          {!isSource(step) ? <button className="graph-port input" title="ورودی؛ خروجی یک کارت را اینجا رها کن"
            aria-label={`ورودی ${step.name}`} onPointerUp={(event) => { event.stopPropagation(); if (connecting) connect(connecting, step.key); }}
            onClick={() => { if (connecting) connect(connecting, step.key); }}>●</button> : null}
          <div className="graph-node-head" onPointerDown={(event) => {
            if (event.button !== 0) return;
            dragRef.current = { key: step.key, startX: event.clientX, startY: event.clientY,
              x: step.position.x, y: step.position.y }; setSelectedKey(step.key);
          }}><span className="graph-kind">{step.type === "rss_source" ? sourceNames[String(step.config.sourceKind ?? "rss")] :
            step.type === "filter" ? "شرط" : step.type === "publish" ? "ایتا" : step.type === "ai" ? "AI" : "کارت"}</span>
            <button type="button" aria-label={`حذف ${step.name}`} onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => { event.stopPropagation(); remove(step.key); }}>×</button></div>
          <strong>{step.name}</strong><small>{step.type === "rss_source" ? String(step.config.feedUrl ?? step.config.channel ?? sourceNames[String(step.config.sourceKind)]) :
            step.type === "filter" ? `${step.config.mode === "exclude" ? "به‌جز" : "شامل"} ${step.config.keywords || "واژه‌ها را تنظیم کن"}` :
            step.type === "publish" ? eitaaAccounts.find((account) => account.id === step.config.accountId)?.displayName ?? "کانال را انتخاب کن" :
            step.type === "human_approval" ? "در انتظار بررسی شما" : "به کارت‌های دیگر وصل کن"}</small>
          {step.type === "rss_source" ? <div className="graph-source-footer">نوع منبع: {sourceNames[String(step.config.sourceKind ?? "rss")]}</div> : null}
          {!isTerminal(step) ? <button className={`graph-port output ${connecting === step.key ? "active" : ""}`}
            title="خروجی؛ به ورودی کارت بعدی بکش یا کلیک کن" aria-label={`خروجی ${step.name}`}
            onPointerDown={(event) => { event.stopPropagation(); setConnecting(step.key); setPointer(null); }}
            onClick={(event) => { event.stopPropagation(); setConnecting(step.key); }}>●</button> : null}
        </article>)}
      </div></div>
      {edges.length ? <details className="graph-links"><summary>مدیریت اتصال‌ها ({edges.length})</summary><div>{edges.map((edge) => <button key={`${edge.sourceKey}-${edge.targetKey}`}
        onClick={() => setEdges((current) => current.filter((item) => item !== edge))}>
        {steps.find((step) => step.key === edge.sourceKey)?.name} ← {steps.find((step) => step.key === edge.targetKey)?.name} ×</button>)}</div></details> : null}
    </section><aside className="builder-settings"><h2>تنظیمات جریان</h2><label><span>نام جریان</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
      {selected ? <><div className="builder-selected-title"><small>کارت انتخاب‌شده</small><strong>{selected.name}</strong></div>
        {selected.type === "rss_source" ? <><label><span>نوع منبع</span><select value={String(selected.config.sourceKind ?? "rss")}
          onChange={(event) => { const kind = event.target.value; setSteps((current) => current.map((step) => step.key === selected.key ?
            { ...step, config: kind === "rss" ? { sourceKind: kind, feedUrl: "" } : { sourceKind: kind, channel: "" } } : step)); }}>
          <option value="rss">خوراک RSS</option><option value="eitaa">کانال عمومی ایتا</option><option value="bale">کانال عمومی بله</option></select></label>
          {selected.config.sourceKind === "eitaa" || selected.config.sourceKind === "bale" ? <label><span>شناسه یا لینک کانال</span>
            <input dir="ltr" placeholder={selected.config.sourceKind === "bale" ? "https://ble.ir/channel" : "https://eitaa.com/channel"}
              value={String(selected.config.channel ?? "")} onChange={(event) => update(selected.key, "channel", event.target.value)} /></label> :
            <label><span>آدرس RSS</span><input dir="ltr" type="url" placeholder="https://example.com/feed.xml"
              value={String(selected.config.feedUrl ?? "")} onChange={(event) => update(selected.key, "feedUrl", event.target.value)} /></label>}
          <small className="builder-note">هر کارت یک منبع دارد. برای منبع بیشتر کارت دیگری اضافه کن.</small></> : null}
        {selected.type === "filter" ? <><label><span>واژه‌های کلیدی (با ویرگول جدا کن)</span><textarea
          value={String(selected.config.keywords ?? "")} onChange={(event) => update(selected.key, "keywords", event.target.value)}
          placeholder="فوتبال، لیگ، ورزش" /></label><label><span>شرط عبور خبر</span><select value={String(selected.config.mode ?? "include")}
            onChange={(event) => update(selected.key, "mode", event.target.value)}><option value="include">شامل یکی از واژه‌ها</option>
            <option value="exclude">بدون این واژه‌ها</option></select></label>
          <small className="builder-note">برای شاخه‌های ورزشی و عمومی، دو کارت شرط جدا وصل کن.</small></> : null}
        {selected.type === "publish" ? <><label><span>کانال ایتا</span><select value={String(selected.config.accountId ?? "")}
          onChange={(event) => update(selected.key, "accountId", event.target.value)}><option value="">انتخاب کانال</option>
          {eitaaAccounts.map((account) => <option key={account.id} value={account.id}>{account.displayName ?? account.externalAccountId}</option>)}</select></label>
          <label><span>فاصلهٔ انتشار در همین کانال</span><select value={Number(selected.config.publishIntervalSeconds ?? 30)}
            onChange={(event) => update(selected.key, "publishIntervalSeconds", Number(event.target.value))}>
            <option value={30}>۳۰ ثانیه</option><option value={60}>۱ دقیقه</option><option value={120}>۲ دقیقه</option><option value={300}>۵ دقیقه</option></select></label>
          {!eitaaAccounts.length ? <Link href="/connections">+ اتصال کانال ایتا</Link> : null}</> : null}
        {selected.type === "ai" ? <><label><span>دستور بازنویسی</span><textarea value={String(selected.config.instructions ?? "")}
          onChange={(event) => update(selected.key, "instructions", event.target.value)} placeholder="خبر را کوتاه و دقیق بازنویسی کن." /></label>
          <Link href="/settings/ai">{aiReady ? "✓ مدل AI تنظیم شده" : "+ تنظیم مدل و توکن AI"}</Link></> : null}
        {selected.type === "manual_input" ? <label><span>متن ورودی</span><textarea value={prompt}
          onChange={(event) => setPrompt(event.target.value)} placeholder="متن خبر یا موضوع" /></label> : null}
        {selected.type === "human_approval" ? <div className="builder-help">این شاخه منتظر تأیید می‌ماند؛ شاخه‌های دیگر ادامه می‌دهند.</div> : null}
        <div className="graph-node-links"><strong>اتصال‌های این کارت</strong>{edges.filter((edge) => edge.sourceKey === selected.key || edge.targetKey === selected.key)
          .map((edge) => <button key={`${edge.sourceKey}-${edge.targetKey}`}
            onClick={() => setEdges((current) => current.filter((item) => item !== edge))}>
            {steps.find((step) => step.key === edge.sourceKey)?.name} ← {steps.find((step) => step.key === edge.targetKey)?.name} · حذف ×</button>)}</div>
      </> : <div className="builder-help">یک کارت را انتخاب کن تا تنظیماتش نمایش داده شود.</div>}
    </aside></div>
  </main>;
}
