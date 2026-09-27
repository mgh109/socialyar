"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandLogo } from "./brand-logo";
import { TopMenu } from "./top-menu";
import { apiFetch } from "../lib/session";

type Position = { x: number; y: number };
type Step = { key: string; type: string; name: string; config: Record<string, unknown>; position: Position };
type Edge = { sourceKey: string; targetKey: string; condition?: { decision?: string } | null };
type ApiConnection = { id: string; name: string; baseUrl: string };
type Account = { id: string; channel: string; displayName: string | null; externalAccountId: string; isActive: boolean };
type AIProfile = { id: string; name: string; provider: string; model: string };
type Activity = { run: { id: string; status: string; createdAt: string } | null; publication: { status: string; publishedAt: string | null; externalUrl: string | null } | null; queueCount: number };
const isSource = (step: Step) => ["rss_source", "api_source", "manual_input"].includes(step.type);
const isTerminal = (step: Step) => ["publish", "draft", "api_action"].includes(step.type);
const sourceNames: Record<string, string> = { rss: "RSS", eitaa: "ایتا", bale: "بله" };
const types = [
  { type: "rss_source", kind: "rss", label: "منبع · RSS" },
  { type: "rss_source", kind: "eitaa", label: "منبع · ایتا" },
  { type: "rss_source", kind: "bale", label: "منبع · بله" },
  { type: "manual_input", label: "ورودی دستی" },
  { type: "api_source", label: "منبع · کامنت API" },
  { type: "comment_decision", label: "تصمیم کامنت · AI" },
  { type: "api_action", kind: "approve", label: "API · تأیید کامنت" },
  { type: "api_action", kind: "reject", label: "API · رد کامنت" },
  { type: "api_action", kind: "reply", label: "API · پاسخ کامنت" },
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
  ai_output_invalid: "تنظیم عنوان یا نشانی تصویر کارت AI معتبر نیست.",
  invalid_rss_url: "آدرس RSS باید HTTPS عمومی باشد.", invalid_eitaa_source: "شناسهٔ کانال ایتا معتبر نیست.",
  invalid_bale_source: "شناسهٔ کانال بله معتبر نیست.", eitaa_account_required: "کانال خروجی ایتا را انتخاب کن.",
  eitaa_account_not_found: "اتصال کانال ایتا معتبر نیست.", ai_token_not_configured: "توکن AI را تنظیم کن.",
  ai_profile_not_found: "مدل AI انتخاب‌شده موجود نیست؛ یک مدل معتبر انتخاب کن.",
  invalid_publish_interval: "فاصلهٔ انتشار معتبر نیست.",
  duplicate_publish_channel: "هر کانال خروجی را فقط به یک کارت انتشار وصل کن.",
  invalid_api_step: "اتصال، مسیر یا فیلدهای کارت API معتبر نیست.",
  invalid_comment_decision: "قواعد بررسی کامنت را وارد کن.",
  invalid_decision_branch: "برای هر خروجی کارت تصمیم، نتیجهٔ شاخه را انتخاب کن.",
  invalid_feedback_path: "منبع گروهی را به کارت AI با حالت «تحلیل بازخورد» وصل کن؛ این مسیر نباید به اقدام تکی کامنت برسد.",
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
  const [pollIntervalMinutes, setPollIntervalMinutes] = useState(5);
  const [prompt, setPrompt] = useState("");
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [aiReady, setAiReady] = useState(false);
  const [aiProfiles, setAiProfiles] = useState<AIProfile[]>([]);
  const [apiConnections, setApiConnections] = useState<ApiConnection[]>([]);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("آماده ذخیره");
  const selected = steps.find((step) => step.key === selectedKey);
  const manual = steps.some((step) => step.type === "manual_input") && !steps.some((step) => ["rss_source", "api_source"].includes(step.type));
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
    void Promise.all([apiFetch("/social-accounts"), apiFetch("/settings/ai/profiles"), apiFetch("/api-connections")]).then(async ([a, ai, apis]) => {
      if (a.ok) setAccounts(await a.json());
      if (ai.ok) { const data = await ai.json(); setAiProfiles(data.profiles); setAiReady(data.profiles.length > 0); }
      if (apis.ok) setApiConnections(await apis.json());
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
      version: { prompt: string | null; snapshot?: { pollIntervalMinutes?: number } } | null;
      steps: Array<{ key: string; type: string; name: string; config: Record<string, unknown>; position: Position; order: number }>;
      connections: Array<{ sourceKey?: string; targetKey?: string; sourceStepId: string; targetStepId: string; condition?: { decision?: string } | null }> }) => {
      setWorkflowId(data.workflow.id); setName(data.workflow.name); setPrompt(data.version?.prompt ?? "");
      setPollIntervalMinutes(data.version?.snapshot?.pollIntervalMinutes ?? 5);
      setAutoEnabled(data.workflow.status === "active");
      const byId = new Map(data.steps.map((step) => [(step as typeof step & { id: string }).id, step.key]));
      const links = data.connections.map((edge) => ({ sourceKey: edge.sourceKey ?? byId.get(edge.sourceStepId) ?? "",
        targetKey: edge.targetKey ?? byId.get(edge.targetStepId) ?? "", condition: edge.condition })).filter((edge) => edge.sourceKey && edge.targetKey);
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
      { profileId: aiProfiles[0]?.id ?? "default", aiMode: "rewrite" } : type === "api_source" ?
      { connectionId: apiConnections[0]?.id ?? "", path: "/comments", itemsPath: "data.comments", idField: "id", textField: "text", contextField: "context",
        readMode: "single", batchLimit: 10, postIdField: "postId", postId: "" } :
      type === "comment_decision" ? { profileId: aiProfiles[0]?.id ?? "default", rules: "" } :
      type === "api_action" ? { connectionId: apiConnections[0]?.id ?? "", path: "/comments/moderate", action: kind,
        method: "POST", idField: "commentId", statusField: "status", replyField: "reply" } : {};
    const step = { key, type, name: type === "rss_source" ? "منبع" :
      types.find((item) => item.type === type)?.label ?? "کارت", config,
      position: { x: Math.max(35, 560 - count % 3 * 250), y: 75 + Math.floor(count / 3) * 190 } };
    setSteps((current) => [...current, step]); setSelectedKey(key);
  };
  const update = (key: string, field: string, value: unknown) => setSteps((current) => current.map((step) =>
    step.key === key ? { ...step, config: { ...step.config, [field]: value } } : step));
  const remove = (key: string) => {
    const step = steps.find((item) => item.key === key);
    if (!step || !window.confirm(`کارت «${step.name}» و اتصال‌هایش حذف شود؟`)) return;
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
    const next = [...edges, { sourceKey, targetKey,
      condition: source.type === "comment_decision" ? { decision: target.type === "api_action" ? String(target.config.action) : "review" } : null }];
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
    if (!window.confirm(`اتصال «${edgeName(edge.sourceKey)}» به «${edgeName(edge.targetKey)}» حذف شود؟`)) return;
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
      if (active && steps.some((step) => ["ai", "comment_decision"].includes(step.type) && !aiProfiles.some((profile) =>
        profile.id === String(step.config.profileId ?? "default")))) throw new Error("برای هر کارت AI یک مدل معتبر انتخاب کن.");
      const body = { name: name.trim(), pollIntervalMinutes, description: `${steps.length} کارت · ${edges.length} اتصال`,
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
    <header className="app-header"><div className="brand-lockup"><BrandLogo /><TopMenu /><span>میز کار / {name}</span></div>
      <div className="header-actions"><span className="save-status" role="status">{message}</span>
        <details className="workflow-settings-menu"><summary>تنظیمات جریان</summary><div className="workflow-settings-popover">
          <strong>تنظیمات عمومی</strong>
          <label><span>نام جریان</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label><span>فاصلهٔ پایش منابع</span><select value={pollIntervalMinutes} onChange={(event) => setPollIntervalMinutes(Number(event.target.value))}>
            <option value={1}>هر ۱ دقیقه</option><option value={2}>هر ۲ دقیقه</option><option value={5}>هر ۵ دقیقه</option>
            <option value={10}>هر ۱۰ دقیقه</option><option value={15}>هر ۱۵ دقیقه</option></select></label>
          <small>فاصلهٔ ارسال خبر در کارت انتشار تنظیم می‌شود.</small>
        </div></details>
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
        </div><div className="graph-canvas-meta"><span className={`graph-canvas-status ${autoEnabled ? "active" : ""}`} title={autoEnabled ? `پایش فعال؛ هر ${pollIntervalMinutes} دقیقه` : "پیش‌نویس"}>{autoEnabled ? `● هر ${pollIntervalMinutes} دقیقه` : "○ پیش‌نویس"}</span>
        {activity && (activity.publication || activity.queueCount || activity.run) ? <details className="graph-activity"><summary title="آخرین فعالیت همین جریان" aria-label="آخرین فعالیت همین جریان">فعالیت</summary><div><strong>آخرین فعالیت همین جریان</strong><span>{activity.publication?.status === "published" ? "منتشر شد" :
        activity.publication?.status === "failed" ? "ارسال ناموفق" : activity.publication ? "در صف انتشار" : activity.run?.status ?? "بدون خبر"}
        {activity.queueCount ? ` · ${activity.queueCount.toLocaleString("fa-IR")} خبر در صف` : ""}</span>
        {activity.run ? <Link href={`/runs/${activity.run.id}`}>دیدن آخرین اجرا و تحلیل ←</Link> : null}
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
            return <g key={edgeId(edge)} className={`graph-edge ${selectedEdge === edgeId(edge) ? "selected" : ""}`}>
              <path className="edge-visible" d={path} />
              <circle className="edge-glow" r="3.5"><animateMotion dur="2.6s" repeatCount="indefinite" path={path} /></circle>
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
            step.type === "api_source" || step.type === "api_action" ? "API" : step.type === "comment_decision" ? "AI" :
            step.type === "filter" ? "شرط" : step.type === "publish" ? "ایتا" : step.type === "ai" ? "AI" : "کارت"}</span>
            <button type="button" className="graph-delete" title="حذف کارت" aria-label={`حذف ${step.name}`} onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => { event.stopPropagation(); remove(step.key); }}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg></button></div>
          <strong>{step.name}</strong><small title={step.type === "rss_source" ? String(step.config.feedUrl ?? step.config.channel ?? "") : undefined}>{step.type === "rss_source" ?
            String(step.config.feedUrl ?? step.config.channel ?? "").trim() ? String(step.config.feedUrl ?? step.config.channel) : "نیاز به تنظیم منبع" :
            step.type === "filter" ? `${step.config.mode === "exclude" ? "به‌جز" : "شامل"} ${step.config.keywords || "واژه‌ها را تنظیم کن"}` :
            step.type === "publish" ? eitaaAccounts.find((account) => account.id === step.config.accountId)?.displayName ?? "نیاز به انتخاب کانال" :
            step.type === "api_source" || step.type === "api_action" ? apiConnections.find((item) => item.id === step.config.connectionId)?.name ?? "اتصال API را انتخاب کن" :
            step.type === "comment_decision" ? "تأیید، رد، پاسخ یا بررسی" :
            step.type === "ai" && step.config.aiMode === "feedback" ? "تحلیل بازخورد گروهی" :
            step.type === "human_approval" ? "در انتظار بررسی شما" : "به کارت‌های دیگر وصل کن"}</small>
          {step.type === "rss_source" ? <div className="graph-source-footer">{String(step.config.feedUrl ?? step.config.channel ?? "").trim() ? "● آماده" : "○ تنظیم‌نشده"} · {sourceNames[String(step.config.sourceKind ?? "rss")]}</div> : null}
          {!isTerminal(step) ? <button className={`graph-port output ${connecting === step.key ? "active" : ""}`}
            title="خروجی؛ به ورودی کارت بعدی بکش یا کلیک کن" aria-label={`خروجی ${step.name}`}
            onPointerDown={(event) => { event.stopPropagation(); setConnecting(step.key); setPointer(null); }}
            onClick={(event) => { event.stopPropagation(); setConnecting(step.key); }}>●</button> : null}
        </article>)}
      </div></div></div>
    </section><aside className="builder-settings"><h2>{selected ? "تنظیمات کارت" : selectedEdge ? "تنظیمات اتصال" : "کارت‌ها"}</h2>
      {selectedEdge ? <div className="graph-edge-settings"><strong>اتصال انتخاب‌شده</strong>
        <p>{edgeName(edges.find((edge) => edgeId(edge) === selectedEdge)?.sourceKey ?? "")} ← {edgeName(edges.find((edge) => edgeId(edge) === selectedEdge)?.targetKey ?? "")}</p>
        {steps.find((step) => step.key === edges.find((edge) => edgeId(edge) === selectedEdge)?.sourceKey)?.type === "comment_decision" ?
          <label><span>این مسیر برای کدام تصمیم است؟</span><select value={edges.find((edge) => edgeId(edge) === selectedEdge)?.condition?.decision ?? "review"}
            onChange={(event) => setEdges((current) => current.map((edge) => edgeId(edge) === selectedEdge ?
              { ...edge, condition: { decision: event.target.value } } : edge))}>
            <option value="approve">تأیید</option><option value="reject">رد</option><option value="reply">پاسخ</option>
            <option value="review">بررسی انسانی</option></select></label> : null}
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
        {selected.type === "api_source" || selected.type === "api_action" ? <>
          <label><span>اتصال API</span><select value={String(selected.config.connectionId ?? "")}
            onChange={(event) => update(selected.key, "connectionId", event.target.value)}><option value="">انتخاب اتصال</option>
            {apiConnections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}</select></label>
          <Link href="/settings/api">مدیریت اتصال‌ها و توکن‌ها</Link>
          <label><span>مسیر نسبی روی همان میزبان</span><input dir="ltr" value={String(selected.config.path ?? "")}
            onChange={(event) => update(selected.key, "path", event.target.value)} placeholder="/comments" /></label>
          {selected.type === "api_source" ? <>
            <label><span>روش خواندن کامنت‌ها</span><select value={String(selected.config.readMode ?? "single")}
              onChange={(event) => update(selected.key, "readMode", event.target.value)}>
              <option value="single">تکی؛ برای تصمیم و اقدام هر کامنت</option>
              <option value="batch">گروهی؛ آخرین کامنت‌ها</option>
              <option value="post">گروهی؛ کامنت‌های یک نوشته</option></select></label>
            {selected.config.readMode === "batch" || selected.config.readMode === "post" ? <>
              <label><span>حداکثر کامنت در هر تحلیل</span><select value={Number(selected.config.batchLimit ?? 10)}
                onChange={(event) => update(selected.key, "batchLimit", Number(event.target.value))}>
                <option value={10}>۱۰ کامنت</option><option value={25}>۲۵ کامنت</option><option value={50}>۵۰ کامنت</option></select></label>
              {selected.config.readMode === "post" ? <>
                <label><span>فیلد شناسهٔ نوشته در هر کامنت</span><input dir="ltr" value={String(selected.config.postIdField ?? "postId")}
                  onChange={(event) => update(selected.key, "postIdField", event.target.value)} placeholder="postId" /></label>
                <label><span>شناسهٔ نوشته</span><input dir="ltr" value={String(selected.config.postId ?? "")}
                  onChange={(event) => update(selected.key, "postId", event.target.value)} placeholder="123" /></label>
              </> : null}
              <small className="builder-note">این حالت را به کارت AI با گزینهٔ «تحلیل بازخورد» وصل کن. API باید کامنت‌های تازه‌تر را اول برگرداند؛ از همان پاسخ حداکثر ۵۰ مورد خوانده می‌شود.</small>
            </> : null}
            {([ ["itemsPath", "مسیر آرایهٔ کامنت‌ها", "data.comments"], ["idField", "فیلد شناسه", "id"],
              ["textField", "فیلد متن", "text"], ["contextField", "فیلد زمینه (اختیاری)", "context"] ] as const)
              .map(([key, label, hint]) => <label key={key}><span>{label}</span><input dir="ltr" value={String(selected.config[key] ?? "")}
                placeholder={hint} onChange={(event) => update(selected.key, key, event.target.value)} /></label>)}
            <small className="builder-note">پایش طبق فاصلهٔ جریان انجام می‌شود؛ گروهی با شناسه‌های یکسان دوباره تحلیل نمی‌شود.</small>
          </> : <>
            <label><span>اقدام</span><select value={String(selected.config.action ?? "approve")}
              onChange={(event) => update(selected.key, "action", event.target.value)}><option value="approve">تأیید</option>
              <option value="reject">رد</option><option value="reply">پاسخ</option></select></label>
            <label><span>روش درخواست</span><select value={String(selected.config.method ?? "POST")}
              onChange={(event) => update(selected.key, "method", event.target.value)}><option>POST</option><option>PATCH</option></select></label>
            {([ ["idField", "کلید شناسهٔ کامنت", "commentId"],
              [selected.config.action === "reply" ? "replyField" : "statusField", selected.config.action === "reply" ? "کلید متن پاسخ" : "کلید وضعیت", selected.config.action === "reply" ? "reply" : "status"] ] as const)
              .map(([key, label, hint]) => <label key={key}><span>{label}</span><input dir="ltr" value={String(selected.config[key] ?? "")}
                placeholder={hint} onChange={(event) => update(selected.key, key, event.target.value)} /></label>)}
            {selected.config.action !== "reply" ? <><label><span>مقدار تأیید</span><input dir="ltr" value={String(selected.config.approveValue ?? "approved")}
              onChange={(event) => update(selected.key, "approveValue", event.target.value)} /></label>
              <label><span>مقدار رد</span><input dir="ltr" value={String(selected.config.rejectValue ?? "rejected")}
                onChange={(event) => update(selected.key, "rejectValue", event.target.value)} /></label></> : null}
            <small className="builder-note">اگر نتیجهٔ درخواست نامشخص باشد، ارسال خودکار دوباره انجام نمی‌شود.</small>
          </>}
        </> : null}
        {selected.type === "comment_decision" ? <>
          <label><span>مدل تصمیم</span><select value={String(selected.config.profileId ?? "default")}
            onChange={(event) => update(selected.key, "profileId", event.target.value)}><option value="default">مدل پیش‌فرض</option>
            {aiProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>)}</select></label>
          <label><span>قواعد و محدودیت‌های تصمیم</span><textarea value={String(selected.config.rules ?? "")}
            onChange={(event) => update(selected.key, "rules", event.target.value)}
            placeholder="کامنت‌های محترمانه را تأیید کن؛ توهین را رد کن؛ سؤال مرتبط را پاسخ بده؛ مورد مبهم را برای بررسی بفرست." /></label>
          <small className="builder-note">برای هر اتصال خروجی، تصمیم تأیید، رد، پاسخ یا بررسی انسانی را انتخاب کن.</small>
        </> : null}
        {selected.type === "publish" ? <><label><span>کانال ایتا</span><select value={String(selected.config.accountId ?? "")}
          onChange={(event) => update(selected.key, "accountId", event.target.value)}><option value="">انتخاب کانال</option>
          {eitaaAccounts.map((account) => <option key={account.id} value={account.id}>{account.displayName ?? account.externalAccountId}</option>)}</select></label>
          <label><span>فاصلهٔ انتشار در همین کانال</span><select value={Number(selected.config.publishIntervalSeconds ?? 30)}
            onChange={(event) => update(selected.key, "publishIntervalSeconds", Number(event.target.value))}>
            <option value={30}>۳۰ ثانیه</option><option value={60}>۱ دقیقه</option><option value={120}>۲ دقیقه</option><option value={300}>۵ دقیقه</option></select></label>
          {!eitaaAccounts.length ? <Link href="/connections">+ اتصال کانال ایتا</Link> : null}</> : null}
        {selected.type === "ai" ? <><label><span>کار این کارت</span><select value={String(selected.config.aiMode ?? "rewrite")}
          onChange={(event) => update(selected.key, "aiMode", event.target.value)}>
          <option value="rewrite">بازنویسی خبر</option><option value="feedback">تحلیل بازخورد کامنت‌ها</option></select></label>
          <label><span>مدل و توکن این کارت</span><select value={String(selected.config.profileId ?? "default")}
          onChange={(event) => update(selected.key, "profileId", event.target.value)}>
          {!aiProfiles.some((profile) => profile.id === String(selected.config.profileId ?? "default")) ?
            <option value={String(selected.config.profileId ?? "default")}>مدل انتخاب‌شده موجود نیست</option> : null}
          {aiProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.provider} / {profile.model}</option>)}
          </select></label><label><span>{selected.config.aiMode === "feedback" ? "راهنمای تحلیل (اختیاری)" : "دستور بازنویسی متن"}</span><textarea value={String(selected.config.instructions ?? "")}
          onChange={(event) => update(selected.key, "instructions", event.target.value)} placeholder={selected.config.aiMode === "feedback" ?
            "بازخورد کاربران را دربارهٔ کیفیت خدمات توضیح بده و نگرانی‌های پرتکرار را مشخص کن." : "خبر را کوتاه و دقیق بازنویسی کن."} /></label>
          {selected.config.aiMode === "feedback" ? <small className="builder-note">هر کامنت جدا برچسب می‌گیرد؛ شمارش مثبت، منفی و خنثی از برچسب‌ها محاسبه می‌شود. نتیجه را در صفحهٔ اجرای جریان ببین.</small> : <>
          <label><span>عنوان خبر</span><select value={String(selected.config.titleMode ?? "keep")}
            onChange={(event) => update(selected.key, "titleMode", event.target.value)}>
            <option value="keep">عنوان اصلی را نگه دار</option><option value="rewrite">عنوان را با AI بازنویسی کن</option>
            <option value="custom">عنوان ثابت دلخواه</option></select></label>
          {selected.config.titleMode === "rewrite" ? <label><span>راهنمای عنوان (اختیاری)</span><input
            value={String(selected.config.titleInstructions ?? "")} onChange={(event) => update(selected.key, "titleInstructions", event.target.value)}
            placeholder="مثلاً کوتاه و بدون اغراق" /></label> : null}
          {selected.config.titleMode === "custom" ? <label><span>عنوان ثابت</span><input maxLength={180}
            value={String(selected.config.customTitle ?? "")} onChange={(event) => update(selected.key, "customTitle", event.target.value)} /></label> : null}
          <label><span>تصویر خبر</span><select value={String(selected.config.imageMode ?? "keep")}
            onChange={(event) => update(selected.key, "imageMode", event.target.value)}>
            <option value="keep">تصویر منبع را نگه دار</option><option value="remove">بدون تصویر منتشر کن</option>
            <option value="custom">از نشانی تصویر دلخواه استفاده کن</option></select></label>
          {selected.config.imageMode === "custom" ? <label><span>نشانی تصویر (HTTPS)</span><input dir="ltr" type="url"
            value={String(selected.config.customImageUrl ?? "")} onChange={(event) => update(selected.key, "customImageUrl", event.target.value)}
            placeholder="https://example.com/news.jpg" /></label> : null}
          </>}
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
