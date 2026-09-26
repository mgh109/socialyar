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
type AIProfile = { id: string; name: string; provider: string; model: string };
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
  ai_profile_not_found: "مدل AI انتخاب‌شده موجود نیست؛ یک مدل معتبر انتخاب کن.",
  invalid_publish_interval: "فاصلهٔ انتشار معتبر نیست.",
  duplicate_publish_channel: "هر کانال خروجی را فقط به یک کارت انتشار وصل کن.",
};
const nodeWidth = 190;
const nodeHeight = 150;
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
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [viewport, setViewport] = useState({ width: 800, height: 520 });
  const [name, setName] = useState("جریان جدید");
  const [prompt, setPrompt] = useState("");
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [aiReady, setAiReady] = useState(false);
  const [aiProfiles, setAiProfiles] = useState<AIProfile[]>([]);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("آماده ذخیره");
  const selected = steps.find((step) => step.key === selectedKey);
  const manual = steps.some((step) => step.type === "manual_input") && !steps.some((step) => step.type === "rss_source");
  const eitaaAccounts = accounts.filter((account) => account.channel === "eitaa" && account.isActive);
  const edgeId = (edge: Edge) => `${edge.sourceKey}→${edge.targetKey}`;
  const edgeName = (key: string) => {
    const step = steps.find((item) => item.key === key);
    if (!step) return "کارت حذف‌شده";
    const kind = step.type === "rss_source" ? ` · ${sourceNames[String(step.config.sourceKind ?? "rss")]}` : "";
    return `${step.name}${kind}`;
  };
  const surfaceWidth = Math.max(viewport.width, ...steps.map((step) => step.position.x + nodeWidth + 48), 540);
  const surfaceHeight = Math.max(viewport.height, ...steps.map((step) => step.position.y + nodeHeight + 48), 400);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => setViewport({ width: canvas.clientWidth, height: canvas.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    void Promise.all([apiFetch("/social-accounts"), apiFetch("/settings/ai/profiles")]).then(async ([a, ai]) => {
      if (a.ok) setAccounts(await a.json());
      if (ai.ok) { const data = await ai.json(); setAiProfiles(data.profiles); setAiReady(data.profiles.length > 0); }
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
        const x = Math.max(20, drag.x + event.clientX - drag.startX);
        const y = Math.max(20, drag.y + event.clientY - drag.startY);
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
      type === "filter" ? { keywords: "", mode: "include" } : type === "ai" ?
      { profileId: aiProfiles[0]?.id ?? "default" } : {};
    const step = { key, type, name: type === "rss_source" ? "منبع" :
      types.find((item) => item.type === type)?.label ?? "کارت", config,
      position: { x: Math.max(35, 560 - count % 3 * 250), y: 75 + Math.floor(count / 3) * 190 } };
    setSteps((current) => [...current, step]); setSelectedKey(key);
  };
  const update = (key: string, field: string, value: unknown) => setSteps((current) => current.map((step) =>
    step.key === key ? { ...step, config: { ...step.config, [field]: value } } : step));
  const remove = (key: string) => {
    setSteps((current) => current.filter((step) => step.key !== key));
    setEdges((current) => current.filter((edge) => edge.sourceKey !== key && edge.targetKey !== key));
    setSelectedEdge(null);
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
    setEdges(next); setSelectedEdge(edgeId({ sourceKey, targetKey })); setMessage("اتصال اضافه شد؛ تغییرات را ذخیره کن.");
  };
  const removeEdge = (edge: Edge) => {
    setEdges((current) => current.filter((item) => edgeId(item) !== edgeId(edge)));
    setSelectedEdge(null); setMessage("اتصال حذف شد؛ تغییرات را ذخیره کن.");
  };
  const arrange = () => {
    const rank = new Map<string, number>();
    const walk = (key: string, depth: number, seen = new Set<string>()) => {
      if (seen.has(key) || depth <= (rank.get(key) ?? -1)) return;
      rank.set(key, depth);
      const next = new Set(seen); next.add(key);
      edges.filter((edge) => edge.sourceKey === key).forEach((edge) => walk(edge.targetKey, depth + 1, next));
    };
    steps.filter(isSource).forEach((step) => walk(step.key, 0));
    steps.forEach((step) => { if (!rank.has(step.key)) walk(step.key, 0); });
    const levels = new Map<number, number>();
    const maxDepth = Math.max(0, ...rank.values());
    setSteps((current) => current.map((step) => {
      const depth = rank.get(step.key) ?? 0;
      const row = levels.get(depth) ?? 0; levels.set(depth, row + 1);
      return { ...step, position: { x: 36 + (maxDepth - depth) * 250, y: 35 + row * 185 } };
    }));
    setMessage("کارت‌ها مرتب شدند؛ تغییرات را ذخیره کن.");
  };
  const save = async (active = autoEnabled) => {
    setBusy(true); setMessage("در حال ذخیره...");
    try {
      if (!name.trim()) throw new Error("نام جریان را وارد کن.");
      if (active && steps.some((step) => step.type === "ai" && !aiProfiles.some((profile) =>
        profile.id === String(step.config.profileId ?? "default")))) throw new Error("برای هر کارت AI یک مدل معتبر انتخاب کن.");
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
      <div className="graph-frame"><div className="graph-canvas-controls"><div className="graph-canvas-actions">
        <div className="graph-palette"><details><summary>+ افزودن کارت</summary><div className="graph-palette-menu">
        {types.map((item) => <button key={`${item.type}-${item.kind ?? ""}`} type="button" onClick={(event) => {
          add(item.type, item.kind); event.currentTarget.closest("details")?.removeAttribute("open");
        }}>{item.label}</button>)}</div></details></div>
        <button type="button" className="graph-icon-action" title="مرتب‌سازی کارت‌ها" aria-label="مرتب‌سازی کارت‌ها" onClick={arrange} disabled={!steps.length}>⤢</button>
        </div><div className="graph-canvas-meta"><span className={`graph-canvas-status ${autoEnabled ? "active" : ""}`} title={autoEnabled ? "پایش فعال؛ هر ۵ دقیقه" : "پیش‌نویس"}>{autoEnabled ? "● فعال" : "○ پیش‌نویس"}</span>
        {activity && (activity.publication || activity.queueCount || activity.run) ? <details className="graph-activity"><summary title="آخرین فعالیت همین جریان" aria-label="آخرین فعالیت همین جریان">فعالیت</summary><div><strong>آخرین فعالیت همین جریان</strong><span>{activity.publication?.status === "published" ? "منتشر شد" :
        activity.publication?.status === "failed" ? "ارسال ناموفق" : activity.publication ? "در صف انتشار" : activity.run?.status ?? "بدون خبر"}
        {activity.queueCount ? ` · ${activity.queueCount.toLocaleString("fa-IR")} خبر در صف` : ""}</span>
        {activity.publication?.externalUrl ? <a href={activity.publication.externalUrl} target="_blank" rel="noreferrer">دیدن خبر ↗</a> : null}</div></details> : null}</div></div>
      <div className="graph-scroll" ref={canvasRef} onPointerUp={(event) => {
        if (connecting && event.target === event.currentTarget) { setConnecting(null); setPointer(null); }
      }}><div className="graph-surface" style={{ width: surfaceWidth, height: surfaceHeight }}>
        <svg className="graph-lines" width={surfaceWidth} height={surfaceHeight} role="group" aria-label="اتصال‌های جریان">
          {edges.map((edge) => {
            const from = steps.find((step) => step.key === edge.sourceKey), to = steps.find((step) => step.key === edge.targetKey);
            if (!from || !to) return null;
            const start = { x: from.position.x, y: from.position.y + 70 };
            const end = { x: to.position.x + nodeWidth, y: to.position.y + 70 };
            const path = stroke(start, end);
            const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
            const angle = Math.atan2(1.5 * (end.y - start.y), 1.5 * (end.x - start.x) + 138) * 180 / Math.PI;
            return <g key={edgeId(edge)} className={`graph-edge ${selectedEdge === edgeId(edge) ? "selected" : ""}`}>
              <path className="edge-visible" d={path} />
              <circle className="edge-direction-bg" cx={midpoint.x} cy={midpoint.y} r="11" />
              <path className="edge-direction" d="M -6 -5 L 1 0 L -6 5" transform={`translate(${midpoint.x} ${midpoint.y}) rotate(${angle})`} />
              <path className="edge-hit" d={path} role="button" tabIndex={0} aria-label={`اتصال ${edgeName(edge.sourceKey)} به ${edgeName(edge.targetKey)}`}
                onClick={() => { setSelectedEdge(edgeId(edge)); setSelectedKey(""); }}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedEdge(edgeId(edge)); setSelectedKey(""); } }} />
            </g>;
          })}
          {connecting && pointer && steps.find((step) => step.key === connecting) ? <path className="preview" d={stroke({
            x: steps.find((step) => step.key === connecting)!.position.x,
            y: steps.find((step) => step.key === connecting)!.position.y + 70 }, pointer)} /> : null}
        </svg>
        {!steps.length ? <div className="graph-empty">بوم خالی است. از «افزودن کارت» شروع کن.</div> : null}
        {steps.map((step) => <article key={step.key} className={`graph-node ${selectedKey === step.key ? "selected" : ""}`}
          style={{ left: step.position.x, top: step.position.y }} onClick={() => { setSelectedKey(step.key); setSelectedEdge(null); }}>
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
          <strong>{step.name}</strong><small title={step.type === "rss_source" ? String(step.config.feedUrl ?? step.config.channel ?? "") : undefined}>{step.type === "rss_source" ?
            String(step.config.feedUrl ?? step.config.channel ?? "").trim() ? String(step.config.feedUrl ?? step.config.channel) : "نیاز به تنظیم منبع" :
            step.type === "filter" ? `${step.config.mode === "exclude" ? "به‌جز" : "شامل"} ${step.config.keywords || "واژه‌ها را تنظیم کن"}` :
            step.type === "publish" ? eitaaAccounts.find((account) => account.id === step.config.accountId)?.displayName ?? "نیاز به انتخاب کانال" :
            step.type === "human_approval" ? "در انتظار بررسی شما" : "به کارت‌های دیگر وصل کن"}</small>
          {step.type === "rss_source" ? <div className="graph-source-footer">{String(step.config.feedUrl ?? step.config.channel ?? "").trim() ? "● آماده" : "○ تنظیم‌نشده"} · {sourceNames[String(step.config.sourceKind ?? "rss")]}</div> : null}
          {!isTerminal(step) ? <button className={`graph-port output ${connecting === step.key ? "active" : ""}`}
            title="خروجی؛ به ورودی کارت بعدی بکش یا کلیک کن" aria-label={`خروجی ${step.name}`}
            onPointerDown={(event) => { event.stopPropagation(); setConnecting(step.key); setPointer(null); }}
            onClick={(event) => { event.stopPropagation(); setConnecting(step.key); }}>●</button> : null}
        </article>)}
      </div></div></div>
    </section><aside className="builder-settings"><h2>تنظیمات جریان</h2><label><span>نام جریان</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
      {selectedEdge ? <div className="graph-edge-settings"><strong>اتصال انتخاب‌شده</strong>
        <p>{edgeName(edges.find((edge) => edgeId(edge) === selectedEdge)?.sourceKey ?? "")} ← {edgeName(edges.find((edge) => edgeId(edge) === selectedEdge)?.targetKey ?? "")}</p>
        <button type="button" onClick={() => { const edge = edges.find((item) => edgeId(item) === selectedEdge); if (edge) removeEdge(edge); }}>حذف اتصال</button></div> : null}
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
        {selected.type === "ai" ? <><label><span>مدل و توکن این کارت</span><select value={String(selected.config.profileId ?? "default")}
          onChange={(event) => update(selected.key, "profileId", event.target.value)}>
          {!aiProfiles.some((profile) => profile.id === String(selected.config.profileId ?? "default")) ?
            <option value={String(selected.config.profileId ?? "default")}>مدل انتخاب‌شده موجود نیست</option> : null}
          {aiProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.provider} / {profile.model}</option>)}
          </select></label><label><span>دستور بازنویسی</span><textarea value={String(selected.config.instructions ?? "")}
          onChange={(event) => update(selected.key, "instructions", event.target.value)} placeholder="خبر را کوتاه و دقیق بازنویسی کن." /></label>
          <Link href="/settings/ai">{aiReady ? "✓ مدل AI تنظیم شده" : "+ تنظیم مدل و توکن AI"}</Link></> : null}
        {selected.type === "manual_input" ? <label><span>متن ورودی</span><textarea value={prompt}
          onChange={(event) => setPrompt(event.target.value)} placeholder="متن خبر یا موضوع" /></label> : null}
        {selected.type === "human_approval" ? <div className="builder-help">این شاخه منتظر تأیید می‌ماند؛ شاخه‌های دیگر ادامه می‌دهند.</div> : null}
        <div className="graph-node-links"><strong>اتصال‌های این کارت</strong>{edges.filter((edge) => edge.sourceKey === selected.key || edge.targetKey === selected.key)
          .map((edge) => <button key={edgeId(edge)} onClick={() => removeEdge(edge)}>
            {edgeName(edge.sourceKey)} ← {edgeName(edge.targetKey)} · حذف ×</button>)}</div>
      </> : !selectedEdge ? <div className="builder-help">یک کارت یا خط اتصال را انتخاب کن تا تنظیماتش نمایش داده شود.</div> : null}
    </aside></div>
  </main>;
}
