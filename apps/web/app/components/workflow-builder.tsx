"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandLogo } from "./brand-logo";
import type { CalendarItem } from "@socialyar/shared";
import { calendarLabels } from "./calendar-detail";
import { CollectionPanel } from "./collection-panel";
import { YoutubePanel, YoutubeIcon, youtubeStatus, type YoutubeItem } from "./youtube-panel";
import { ConnectionSelector, type SavedProxy } from "./connection-selector";
import { apiFetch } from "../lib/session";

type Position = { x: number; y: number };
type Step = { key: string; type: string; name: string; config: Record<string, unknown>; position: Position };
type Edge = { sourceKey: string; targetKey: string; condition?: { decision?: string } | null };
type ApiConnection = { id: string; name: string; baseUrl: string; authType: "bearer" | "api_key"; headerName: string | null };
type Account = { id: string; channel: string; displayName: string | null; externalAccountId: string; isActive: boolean };
type AIProfile = { id: string; name: string; provider: string; model: string };
type GeneratedBlueprint = { name: string; steps: Step[]; connections: Edge[]; warnings: string[];
  templateUsed?: boolean;
  usage: { provider: string; model: string; inputTokens: number | null; outputTokens: number | null; costMicros: number | null } | null };
type SourcePreview = { status: "ok"; rawCount: number; matchedCount: number; selectedCount: number;
  validCount: number; pagesFetched: number; capped: boolean; availablePaths: string[]; samples: Array<{ id: string; text: string }> };
type SourceHealth = { status: "ok" | "error" | "not_checked"; checkedAt?: string; error?: string;
  rawCount?: number; matchedCount?: number; selectedCount?: number; validCount?: number; queuedCount?: number;
  pagesFetched?: number; capped?: boolean };
type Activity = { run: { id: string; status: string; createdAt: string } | null; publication: { status: string; publishedAt: string | null; externalUrl: string | null } | null; queueCount: number };
type UsageTotals = { requests: number; inputTokens: number | string; outputTokens: number | string;
  costMicros: number | string; unreportedTokens: number; unreportedCost: number };
type WorkflowUsage = { totals: UsageTotals; byStep: Array<UsageTotals & { stepKey: string }> };
type LiveState = {
  connections?: Array<{ stepKey: string; route: string; proxyName: string | null }>;
  nextPollAt: string | null;
  events: Array<{ id: string; type: string; stepKey: string | null; createdAt: string; decision: string | null }>;
  active: Array<{ stepKey: string; status: string }>;
  filters: Array<{ stepKey: string; runId: string; passed: boolean; title: string | null; at: string | null }>;
  sources: Array<{ stepKey: string; status: string; at: string; count?: number; queuedCount?: number }>;
  publications: Array<{ id: string; stepKey: string; status: string; updatedAt: string; publishedAt: string | null }>;
};
const faNumber = (value: number | string) => Number(value).toLocaleString("fa-IR");
const dollarCost = (usage: UsageTotals) => (Number(usage.costMicros) / 1_000_000)
  .toLocaleString("fa-IR", { maximumFractionDigits: 4 });
const isSource = (step: Step) => ["rss_source", "api_source", "manual_input", "collection_source"].includes(step.type);
const isTerminal = (step: Step) => ["publish", "draft", "api_action"].includes(step.type);
const sourceNames: Record<string, string> = { rss: "خبرخوان", eitaa: "ایتا", bale: "بله" };
const publishNames: Record<string, string> = { youtube: "یوتیوب", eitaa: "ایتا", bale: "بله", instagram: "اینستاگرام", telegram: "تلگرام", website: "وب‌سایت" };
const pollPresets = [1, 5, 15, 60, 1440];
const publishPresets = [30, 60, 300, 3600, 86400];
function durationLabel(minutes: number) {
  return minutes % 1440 === 0 ? `هر ${minutes / 1440} روز` :
    minutes % 60 === 0 ? `هر ${minutes / 60} ساعت` : `هر ${minutes} دقیقه`;
}
const types = [
  { type: "source", label: "منبع" },
  { type: "collection_source", label: "مجموعه از اکسل / گوگل‌شیت" },
  { type: "filter", label: "شرط" },
  { type: "ai", label: "هوش مصنوعی" },
  { type: "human_approval", label: "تأیید انسانی" },
  { type: "draft", label: "پیش‌نویس" },
  { type: "publish", label: "انتشار" },
  { type: "api_action", label: "اقدام سرویس" },
];
const errors: Record<string, string> = {
  graph_invalid_step: "یک کارت نامعتبر است.", graph_invalid_connection: "اتصال نامعتبر یا تکراری است.",
  graph_cycle: "اتصال حلقه‌ای مجاز نیست.", graph_missing_input: "همهٔ کارت‌های پردازش باید از یک منبع ورودی بگیرند.",
  graph_unfinished_branch: "هر شاخه باید به انتشار یا پیش‌نویس برسد.", graph_invalid_filter: "برای شرط، واژه‌های کلیدی وارد کن.",
  ai_output_invalid: "تنظیم عنوان یا نشانی تصویر کارت هوش مصنوعی معتبر نیست.",
  invalid_rss_url: "آدرس خوراک خبری باید امن و عمومی باشد.", invalid_eitaa_source: "شناسهٔ کانال ایتا معتبر نیست.",
  invalid_bale_source: "شناسهٔ کانال بله معتبر نیست.", eitaa_account_required: "مقصد انتشار را انتخاب کن.",
  eitaa_account_not_found: "اتصال مقصد انتشار معتبر یا فعال نیست.", ai_token_not_configured: "توکن هوش مصنوعی را تنظیم کن.",
  ai_profile_not_found: "مدل هوش مصنوعی انتخاب‌شده موجود نیست؛ یک مدل معتبر انتخاب کن.",
  invalid_publish_interval: "فاصلهٔ انتشار معتبر نیست.",
  invalid_publishing_connection: "مسیر اتصال معتبر نیست؛ یک پروکسی فعال از همین فضای کاری انتخاب کنید.",
  duplicate_publish_channel: "هر کانال خروجی را فقط به یک کارت انتشار وصل کن.",
  invalid_api_step: "اتصال، مسیر یا فیلدهای کارت API معتبر نیست.",
  invalid_comment_decision: "قواعد بررسی کامنت را وارد کن.",
  invalid_decision_branch: "برای هر خروجی کارت تصمیم، نتیجهٔ شاخه را انتخاب کن.",
  invalid_feedback_path: "منبع گروهی را به «تحلیل بازخورد» وصل کن. برای اقدام تکی، گزینهٔ «هر کامنت جداگانه» را روی همان منبع فعال کن.",
  reply_requires_approval: "کارت ارسال پاسخ باید مستقیم بعد از کارت تأیید انسانی باشد.",
};
const nodeWidth = 190;
const nodeHeight = 150;
const freshKey = () => `node-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
function countdownLabel(nextPollAt: string | null | undefined, now: number, active: boolean) {
  if (!active) return "پایش متوقف";
  if (!nextPollAt) return "در انتظار نوبت پایش";
  const seconds = Math.max(0, Math.ceil((new Date(nextPollAt).getTime() - now) / 1000));
  if (!seconds) return "در نوبت پایش";
  const two = (value: number) => value.toLocaleString("fa-IR", { minimumIntegerDigits: 2 });
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  if (hours >= 24) return `${faNumber(Math.floor(hours / 24))} روز، ${two(hours % 24)}:${two(minutes)}`;
  return `${hours ? `${two(hours)}:` : ""}${two(minutes)}:${two(seconds % 60)}`;
}

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
  const seenLiveEvents = useRef(new Set<string>());
  const seenPublicationStates = useRef(new Map<string, string>());
  const seenSourceOutputs = useRef(new Set<string>());
  const openedAt = useRef(Date.now());
  const [steps, setSteps] = useState<Step[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  edgesRef.current = edges;
  const [selectedKey, setSelectedKey] = useState("");
  const [connecting, setConnecting] = useState<string | null>(null);
  const [pointer, setPointer] = useState<Position | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [viewport, setViewport] = useState({ width: 800, height: 520 });
  const [name, setName] = useState("جریان جدید");
  const [pollIntervalMinutes, setPollIntervalMinutes] = useState(5);
  const [prompt, setPrompt] = useState("");
  const [collectionOutputs,setCollectionOutputs]=useState<CalendarItem[]>([]);
  const [youtubeItems, setYoutubeItems] = useState<YoutubeItem[]>([]);
  const [savedProxies, setSavedProxies] = useState<SavedProxy[]>([]);
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [aiReady, setAiReady] = useState(false);
  const [aiProfiles, setAiProfiles] = useState<AIProfile[]>([]);
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [generatorRequest, setGeneratorRequest] = useState("");
  const [generatorProfile, setGeneratorProfile] = useState("default");
  const [generatorBusy, setGeneratorBusy] = useState(false);
  const [generatorError, setGeneratorError] = useState("");
  const [generated, setGenerated] = useState<GeneratedBlueprint | null>(null);
  const [generationUsage, setGenerationUsage] = useState<GeneratedBlueprint["usage"]>(null);
  const [apiConnections, setApiConnections] = useState<ApiConnection[]>([]);
  const [connectionFormOpen, setConnectionFormOpen] = useState(false);
  const [connectionEditingId, setConnectionEditingId] = useState<string | null>(null);
  const [connectionName, setConnectionName] = useState("");
  const [connectionBaseUrl, setConnectionBaseUrl] = useState("");
  const [connectionAuthType, setConnectionAuthType] = useState<"bearer" | "api_key">("bearer");
  const [connectionHeaderName, setConnectionHeaderName] = useState("X-API-Key");
  const [connectionToken, setConnectionToken] = useState("");
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const [sourcePreview, setSourcePreview] = useState<SourcePreview | null>(null);
  const [sourcePreviewError, setSourcePreviewError] = useState("");
  const [sourcePreviewBusy, setSourcePreviewBusy] = useState(false);
  const [sourceHealth, setSourceHealth] = useState<SourceHealth | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [usage, setUsage] = useState<WorkflowUsage | null>(null);
  const [usagePeriod, setUsagePeriod] = useState<"7d" | "30d" | "all">("30d");
  const [usageError, setUsageError] = useState("");
  const [live, setLive] = useState<LiveState | null>(null);
  const [clock, setClock] = useState(Date.now());
  const [edgePulses, setEdgePulses] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("آماده ذخیره");
  const refreshYoutube = () => {
    if (!workflowId) return;
    void apiFetch(`/youtube/items?workflowId=${workflowId}`).then((r) => r.ok ? r.json() : []).then(setYoutubeItems).catch(()=>{});
    void apiFetch(`/calendar/items?workflowId=${workflowId}`).then((r)=>r.ok?r.json():[]).then((items:CalendarItem[])=>setCollectionOutputs(items.filter((i)=>i.workflowId===workflowId && i.settings.collectionId && i.kind==="variant"))).catch(()=>{});
  };
  useEffect(() => { refreshYoutube(); const timer = setInterval(refreshYoutube, 3000); return () => clearInterval(timer); }, [workflowId]);
  useEffect(() => { void apiFetch("/proxies").then((r) => r.ok ? r.json() : []).then(setSavedProxies).catch(() => {}); }, [selectedKey]);
  const cardConnection = (step: Step) => {
    const channel = accounts.find((a) => a.id === step.config.accountId)?.channel;
    if (!["youtube", "telegram", "instagram"].includes(channel ?? "")) return "اتصال مستقیم";
    const policy = step.config.connection as { mode?: string; proxyId?: string } | undefined;
    const item = youtubeItems.find((i) => i.stepKey === step.key);
    const lastRoute = [...(item?.logs ?? [])].reverse().find((log) => log.route);
    if (lastRoute) return lastRoute.route === "proxy" ? `آخرین اجرا با پروکسی: ${lastRoute.proxyName}` : "آخرین اجرا: مستقیم";
    const lastConnection = live?.connections?.find((event) => event.stepKey === step.key);
    if (lastConnection) return lastConnection.route === "proxy" ? `آخرین اجرا با پروکسی: ${lastConnection.proxyName}` : "آخرین اجرا: مستقیم";
    const name = savedProxies.find((p) => p.id === policy?.proxyId)?.name ?? "انتخاب‌نشده یا حذف‌شده";
    return policy?.mode === "proxy" ? `پروکسی: ${name}` : policy?.mode === "auto" ? `خودکار: مستقیم ← ${name}` : "اتصال مستقیم";
  };
  const selected = steps.find((step) => step.key === selectedKey);
  const selectedUsage = usage?.byStep.find((item) => item.stepKey === selectedKey);
  const manual = steps.some((step) => step.type === "manual_input") && !steps.some((step) => ["rss_source", "api_source"].includes(step.type));
  const publishAccounts = accounts.filter((account) => account.isActive && account.channel in publishNames);
  const edgeId = (edge: Edge) => `${edge.sourceKey}→${edge.targetKey}`;
  const stepActivity = (step: Step) => {
    if (step.type === "collection_source") {
      const outputs=youtubeItems.filter((i) => i.settings.collectionSourceKey===step.key);
      const other=collectionOutputs.filter((i)=>i.settings.collectionSourceKey===step.key);
      if(other.some((i)=>i.status==="sending"))return {label:"در حال ارسال مجموعه",state:"running"};
      if(other.some((i)=>i.status==="failed"))return {label:"بعضی مقصدها نیازمند بررسی‌اند",state:"failed"};
      if(other.some((i)=>i.status==="waiting_approval"))return {label:"خروجی‌ها منتظر تأیید",state:"waiting"};
      if(other.length && !outputs.length)return {label:`${faNumber(other.length)} خروجی در تقویم`,state:"completed"};
      const preparing=outputs.filter((i) => i.status==="preparing").length;
      const failed=outputs.filter((i) => i.status==="failed").length;
      if (preparing) return { label:`دریافت ${faNumber(preparing)} فایل`,state:"running" };
      if (failed) return { label:`${faNumber(failed)} فایل نیازمند بررسی`,state:"failed" };
      if (outputs.length) return { label:`${faNumber(outputs.length)} محتوا در مجموعه`,state:"completed" };
      return { label:"منتظر ورود اکسل",state:"idle" };
    }
    if (step.type === "publish" && accounts.find((a) => a.id === step.config.accountId)?.channel === "youtube") {
      const item = youtubeItems.find((i) => i.stepKey === step.key);
      return { label: youtubeStatus(item), state: item?.status === "uploading" || item?.status === "processing" || item?.status === "preparing" ? "running" :
        item?.status === "published" ? "completed" : item?.status === "failed" ? "failed" : "waiting" };
    }
    const sending = live?.publications.find((item) => item.stepKey === step.key && ["publishing", "sending"].includes(item.status));
    if (sending) return { label: "در حال ارسال به کانال...", state: "running" };
    const imported=step.type==="publish" ? collectionOutputs.filter((i)=>i.stepKey===step.key) : [];
    if(imported.length){const item=imported.find((i)=>i.status==="sending") ?? imported.find((i)=>i.status==="failed") ?? imported.find((i)=>i.status==="waiting_approval") ?? imported[0];return {label:calendarLabels[item.status],state:item.status==="sending"?"running":item.status==="failed"?"failed":item.status==="published"?"completed":"waiting"};}
    const calendarItem = step.type === "publish" ? live?.publications.find((item) => item.stepKey === step.key) : null;
    if (calendarItem) {
      const statuses: Record<string, { label: string; state: string }> = { waiting_approval: { label: "منتظر تأیید", state: "waiting" }, scheduled: { label: "زمان‌بندی‌شده", state: "waiting" },
        queued: { label: "در صف انتشار", state: "waiting" }, stopped: { label: "متوقف‌شده", state: "idle" }, draft: { label: "بدون زمان‌بندی", state: "idle" },
        failed: { label: "ارسال ناموفق", state: "failed" }, published: { label: "منتشرشده", state: "completed" } };
      if (statuses[calendarItem.status]) return statuses[calendarItem.status];
    }
    const recentPublication = live?.publications.find((item) => item.stepKey === step.key &&
      ["published", "failed"].includes(item.status) && Date.now() - new Date(item.updatedAt).getTime() < 10000);
    if (recentPublication?.status === "published") return { label: "پیام ارسال شد", state: "completed" };
    if (recentPublication?.status === "failed") return { label: "ارسال ناموفق بود", state: "failed" };
    const source = live?.sources.find((item) => item.stepKey === step.key);
    if (source?.status === "reading") return { label: "در حال خواندن منبع...", state: "running" };
    const active = live?.active.find((item) => item.stepKey === step.key);
    if (active?.status === "waiting_approval") return { label: "در انتظار تأیید شما", state: "waiting" };
    if (active) return { label: step.type === "ai" || step.type === "comment_decision" ? "هوش مصنوعی در حال کار..." : "در حال پردازش...", state: "running" };
    const recent = [...(live?.events ?? [])].reverse().find((item) => item.stepKey === step.key &&
      Date.now() - new Date(item.createdAt).getTime() < 8000 &&
      ["step_completed", "step_failed", "retry", "approval_requested"].includes(item.type));
    if (recent?.type === "step_failed") return { label: "خطا؛ جزئیات در آخرین اجرا", state: "failed" };
    if (recent?.type === "retry") return { label: "تلاش دوباره...", state: "running" };
    if (recent?.type === "approval_requested") return { label: "در انتظار تأیید شما", state: "waiting" };
    const filterResult = step.type === "filter" ? live?.filters?.find((item) => item.stepKey === step.key) : null;
    if (filterResult) return { label: filterResult.passed ? "آخرین خبر عبور کرد" : "آخرین خبر رد شد",
      state: filterResult.passed ? "completed" : "filtered" };
    if (recent?.type === "step_completed") return { label: "این مرحله خروجی داد", state: "completed" };
    if (source?.status === "error") return { label: "خواندن منبع ناموفق بود", state: "failed" };
    if (source?.status === "queued") return { label: `${faNumber(source.queuedCount ?? 0)} خبر تازه وارد صف شد`, state: "completed" };
    if (source?.status === "no_new") return { label: `${faNumber(source.count ?? 0)} خوانده شد · خبر تازه: ۰`, state: "idle" };
    if (source?.status === "read") return { label: `${faNumber(source.count ?? 0)} مورد خوانده شد`, state: "completed" };
    return null;
  };
  const edgeName = (key: string) => {
    const step = steps.find((item) => item.key === key);
    if (!step) return "کارت حذف‌شده";
    const kind = step.type === "rss_source" ? ` · ${sourceNames[String(step.config.sourceKind ?? "rss")]}` : "";
    return `${step.name}${kind}`;
  };
  const surfaceWidth = Math.max(viewport.width, ...steps.map((step) => step.position.x + nodeWidth + 48), 540);
  const surfaceHeight = Math.max(viewport.height, ...steps.map((step) => step.position.y + nodeHeight + 48), 400);

  useEffect(() => {
    const interval = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    seenLiveEvents.current.clear();
    seenPublicationStates.current.clear();
    seenSourceOutputs.current.clear();
    openedAt.current = Date.now();
    setLive(null); setEdgePulses({});
    if (!workflowId) return;
    let active = true;
    let fetching = false;
    const timers = new Set<number>();
    const flash = (key: string, id: string) => {
      setEdgePulses((current) => ({ ...current, [key]: id }));
      const timer = window.setTimeout(() => {
        setEdgePulses((current) => { if (current[key] !== id) return current;
          const next = { ...current }; delete next[key]; return next; });
        timers.delete(timer);
      }, 4600);
      timers.add(timer);
    };
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const response = await apiFetch(`/workflows/${encodeURIComponent(workflowId)}/live`);
        if (!response.ok) return;
        const snapshot = await response.json() as LiveState;
        if (!active) return;
        setLive(snapshot);
        for (const source of snapshot.sources) {
          if (source.status !== "queued" || !source.queuedCount) continue;
          const outputId = `${source.stepKey}:${source.at}`;
          if (seenSourceOutputs.current.has(outputId)) continue;
          seenSourceOutputs.current.add(outputId);
          if (new Date(source.at).getTime() < openedAt.current - 10_000) continue;
          for (const edge of edgesRef.current.filter((item) => item.sourceKey === source.stepKey))
            flash(`${edge.sourceKey}→${edge.targetKey}`, `source-${outputId}`);
        }
        for (const event of snapshot.events) {
          if (seenLiveEvents.current.has(event.id)) continue;
          seenLiveEvents.current.add(event.id);
          if (event.type !== "step_completed" || !event.stepKey || new Date(event.createdAt).getTime() < openedAt.current) continue;
          for (const edge of edgesRef.current.filter((item) => item.sourceKey === event.stepKey &&
            (!item.condition?.decision || item.condition.decision === event.decision))) {
            flash(`${edge.sourceKey}→${edge.targetKey}`, event.id);
          }
        }
        for (const publication of snapshot.publications) {
          const previous = seenPublicationStates.current.get(publication.id);
          seenPublicationStates.current.set(publication.id, publication.status);
          if (publication.status !== "published" || previous === "published" ||
            !publication.publishedAt || (previous === undefined &&
              new Date(publication.publishedAt).getTime() < openedAt.current - 10_000)) continue;
          for (const edge of edgesRef.current.filter((item) => item.targetKey === publication.stepKey))
            flash(`${edge.sourceKey}→${edge.targetKey}`, `publication-${publication.id}`);
        }
      } catch { /* The next poll can recover without showing a fake running state. */ }
      finally { fetching = false; }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 2000);
    return () => { active = false; window.clearInterval(interval); timers.forEach(window.clearTimeout); };
  }, [workflowId]);

  useEffect(() => {
    if (!workflowId) { setUsage(null); return; }
    let active = true;
    const refresh = () => void apiFetch(`/analytics/ai-usage?workflowId=${encodeURIComponent(workflowId)}&period=${usagePeriod}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("گزارش مصرف در دسترس نیست");
        const report = await response.json() as WorkflowUsage;
        if (active) { setUsage(report); setUsageError(""); }
      }).catch(() => { if (active) setUsageError("گزارش مصرف در دسترس نیست"); });
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [workflowId, usagePeriod]);

  useEffect(() => {
    setConnectionFormOpen(false); setConnectionEditingId(null); setConnectionToken(""); setConnectionError("");
    setSourcePreview(null); setSourcePreviewError(""); setSourceHealth(null);
  }, [selectedKey]);

  useEffect(() => {
    if (!workflowId || selected?.type !== "api_source") return;
    const key = selected.key;
    const refresh = () => void apiFetch(`/workflows/${workflowId}/sources/${encodeURIComponent(key)}/status`)
      .then(async (response) => response.ok ? response.json() as Promise<SourceHealth> : null)
      .then((value) => { if (value) setSourceHealth(value); }).catch(() => {});
    refresh(); const timer = window.setInterval(refresh, 15000);
    return () => window.clearInterval(timer);
  }, [workflowId, selectedKey, selected?.type]);

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
      if (ai.ok) { const data = await ai.json(); setAiProfiles(data.profiles); setAiReady(data.profiles.length > 0);
        setGeneratorProfile(data.profiles[0]?.id ?? "default"); }
      if (apis.ok) setApiConnections(await apis.json());
    }).catch(() => {});
    const params = new URLSearchParams(window.location.search);
    if (params.get("ai") === "1") setGeneratorOpen(true);
    const id = params.get("id");
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
      setSteps(migrated.steps); setEdges(migrated.connections); setSelectedKey(migrated.steps.some((step) => step.key === params.get("step")) ? params.get("step")! : migrated.steps[0]?.key ?? "");
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

  const add = (requestedType: string) => {
    const type = requestedType === "source" ? "rss_source" : requestedType;
    const key = freshKey();
    const count = steps.length;
    const config = type === "rss_source" ? { sourceKind: "rss", feedUrl: "" } :
      type === "publish" ? { accountId: "", publishIntervalSeconds: 30 } :
      type === "filter" ? { keywords: "", mode: "include" } : type === "ai" ?
      { profileId: aiProfiles[0]?.id ?? "default", aiMode: "rewrite" } : type === "api_source" ?
      { connectionId: apiConnections[0]?.id ?? "", path: "/comments", itemsPath: "data.comments", idField: "id", textField: "text", contextField: "context",
        readMode: "single", batchLimit: 10, includeIndividual: false, postIdField: "postId", postId: "" } :
      type === "comment_decision" ? { profileId: aiProfiles[0]?.id ?? "default", rules: "" } :
      type === "api_action" ? { connectionId: apiConnections[0]?.id ?? "", path: "/comments/moderate", action: "approve",
        method: "POST", idField: "commentId", statusField: "status", replyField: "reply" } : {};
    const step = { key, type, name: type === "rss_source" ? "منبع" :
      types.find((item) => item.type === type)?.label ?? "کارت", config,
      position: { x: Math.max(35, 560 - count % 3 * 250), y: 75 + Math.floor(count / 3) * 190 } };
    setSteps((current) => [...current, step]); setSelectedKey(key);
  };
  const update = (key: string, field: string, value: unknown) => setSteps((current) => current.map((step) =>
    step.key === key ? { ...step, config: { ...step.config, [field]: value } } : step));
  const openConnectionForm = (connection?: ApiConnection) => {
    setConnectionEditingId(connection?.id ?? null);
    setConnectionName(connection?.name ?? ""); setConnectionBaseUrl(connection?.baseUrl ?? "");
    setConnectionAuthType(connection?.authType ?? "bearer"); setConnectionHeaderName(connection?.headerName ?? "X-API-Key");
    setConnectionToken(""); setConnectionError(""); setConnectionFormOpen(true);
  };
  const saveConnection = async (cardKey: string) => {
    if (!connectionName.trim() || !connectionBaseUrl.trim() || (!connectionEditingId && !connectionToken.trim())) {
      setConnectionError("نام، نشانی و توکن اتصال جدید را وارد کن."); return;
    }
    setConnectionBusy(true); setConnectionError("");
    try {
      const response = await apiFetch(connectionEditingId ? `/api-connections/${connectionEditingId}` : "/api-connections", {
        method: connectionEditingId ? "PUT" : "POST",
        body: JSON.stringify({ name: connectionName.trim(), baseUrl: connectionBaseUrl.trim(), authType: connectionAuthType,
          headerName: connectionAuthType === "api_key" ? connectionHeaderName.trim() : null,
          ...(connectionToken.trim() ? { token: connectionToken.trim() } : {}) }),
      });
      const data = await response.json().catch(() => ({})) as ApiConnection & { error?: string };
      if (!response.ok) throw new Error(data.error === "secret_key_missing" ?
        "کلید رمزنگاری HOOR_SECRET_KEY روی سرویس API تنظیم نشده است." : data.error === "invalid_api_connection" ?
        "نشانی باید HTTPS عمومی و نام هدر باید با X- شروع شود." : `ذخیره اتصال ناموفق بود (${data.error ?? response.status}).`);
      setApiConnections((current) => [...current.filter((item) => item.id !== data.id), data].sort((a, b) => a.name.localeCompare(b.name)));
      update(cardKey, "connectionId", data.id);
      setConnectionFormOpen(false); setConnectionToken(""); setConnectionEditingId(null);
      setMessage("اتصال API ذخیره و به کارت انتخاب شد؛ تغییرات جریان را ذخیره کن.");
    } catch (error) { setConnectionError(error instanceof Error ? error.message : "اتصال ذخیره نشد."); }
    finally { setConnectionBusy(false); }
  };
  const previewSource = async (step: Step) => {
    const connectionId = String(step.config.connectionId ?? "");
    if (!connectionId) { setSourcePreviewError("ابتدا اتصال API را انتخاب یا ایجاد کن."); return; }
    setSourcePreviewBusy(true); setSourcePreview(null); setSourcePreviewError("");
    try {
      const response = await apiFetch(`/api-connections/${connectionId}/preview`, { method: "POST",
        body: JSON.stringify({ path: String(step.config.path ?? ""), itemsPath: String(step.config.itemsPath ?? ""),
          idField: String(step.config.idField ?? ""), textField: String(step.config.textField ?? ""),
          contextField: String(step.config.contextField ?? ""), readMode: String(step.config.readMode ?? "single"),
          batchLimit: Number(step.config.batchLimit ?? 10), readAll: step.config.readAll === true,
          postId: String(step.config.postId ?? ""),
          postIdField: String(step.config.postIdField ?? "postId") }) });
      const data = await response.json() as SourcePreview & { message?: string; error?: string };
      if (!response.ok) throw new Error(data.message ?? `آزمایش ناموفق بود (${data.error ?? response.status}).`);
      setSourcePreview(data);
    } catch (error) { setSourcePreviewError(error instanceof Error ? error.message : "خواندن کامنت‌ها ناموفق بود."); }
    finally { setSourcePreviewBusy(false); }
  };
  const switchSource = (key: string, kind: string) => {
    const type = kind === "api" ? "api_source" : kind === "manual" ? "manual_input" : "rss_source";
    const config = kind === "api" ? { connectionId: apiConnections[0]?.id ?? "", path: "/comments",
      itemsPath: "data.comments", idField: "id", textField: "text", contextField: "context", readMode: "single",
      batchLimit: 10, includeIndividual: false, postIdField: "postId", postId: "" } : kind === "manual" ? {} :
      kind === "rss" ? { sourceKind: "rss", feedUrl: "" } : { sourceKind: kind, channel: "" };
    setSteps((current) => current.map((step) => step.key === key ? { ...step, type, name: "منبع", config } : step));
    setMessage("نوع منبع تغییر کرد؛ تنظیماتش را تکمیل و ذخیره کن.");
  };
  const switchAI = (key: string, mode: string) => {
    const type = mode === "decision" ? "comment_decision" : "ai";
    setSteps((current) => current.map((step) => step.key === key ? { ...step, type, name: "هوش مصنوعی",
      config: { ...step.config, aiMode: mode, ...(mode === "decision" ? { rules: step.config.rules ?? "" } : {}) } } : step));
    setEdges((current) => current.map((edge) => edge.sourceKey === key ? { ...edge,
      condition: mode === "decision" ? { decision: String(steps.find((item) => item.key === edge.targetKey)?.config.action ?? "review") } : null } : edge));
    setMessage(mode === "decision" ? "برای اتصال‌های خروجی، تصمیم هر شاخه را مشخص کن." : "حالت هوش مصنوعی تغییر کرد؛ ذخیره کن.");
  };
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
    if (source?.type === "collection_source" && target?.type !== "publish") { setMessage("کارت مجموعه را مستقیم به کارت‌های انتشار وصل کن."); return; }
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
  const generateWorkflow = async () => {
    if (generatorRequest.trim().length < 20) { setGeneratorError("هدف جریان را با جزئیات بیشتری بنویس."); return; }
    setGeneratorBusy(true); setGeneratorError(""); setGenerated(null); setGenerationUsage(null);
    try {
      const response = await apiFetch("/workflows/generate", { method: "POST",
        body: JSON.stringify({ request: generatorRequest.trim(), profileId: generatorProfile }) });
      const data = await response.json() as GeneratedBlueprint & { error?: string };
      setGenerationUsage(data.usage ?? null);
      if (!response.ok) throw new Error(data.error === "ai_not_configured" ? "ابتدا یک مدل و توکن هوش مصنوعی تنظیم کن." :
        data.error === "ai_graph_invalid" ? "مدل ساختار جریان معتبری برنگرداند. درخواست را واضح‌تر بنویس و دوباره امتحان کن." :
        "ساخت جریان ناموفق بود. اتصال مدل را بررسی کن و دوباره تلاش کن.");
      setGenerated(data);
    } catch (error) { setGeneratorError(error instanceof Error ? error.message : "ساخت جریان ناموفق بود."); }
    finally { setGeneratorBusy(false); }
  };
  const applyGeneratedWorkflow = () => {
    if (!generated) return;
    if (steps.length && !window.confirm("کارت‌های فعلی با پیشنهاد جدید جایگزین شوند؟ تغییرات ذخیره‌نشده از دست می‌روند.")) return;
    const keys = new Map(generated.steps.map((step) => [step.key, freshKey()]));
    setSteps(generated.steps.map((step) => ({ ...step, key: keys.get(step.key)!,
      config: ["ai", "comment_decision"].includes(step.type) ? { ...step.config, profileId: generatorProfile } : step.config })));
    setEdges(generated.connections.map((edge) => ({ ...edge,
      sourceKey: keys.get(edge.sourceKey)!, targetKey: keys.get(edge.targetKey)! })));
    setName(generated.name); setSelectedKey(""); setSelectedEdge(null); setAutoEnabled(false);
    setMessage("پیشنهاد AI روی بوم قرار گرفت؛ تنظیمات کارت‌ها را بررسی و پیش‌نویس را ذخیره کن.");
    setGeneratorOpen(false);
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
    <header className="app-header"><div className="brand-lockup"><BrandLogo /><span>میز کار / {name}</span></div>
      <div className="header-actions"><span className="save-status" role="status">{message}</span>
        <details className="workflow-settings-menu"><summary>تنظیمات جریان</summary><div className="workflow-settings-popover">
          <strong>تنظیمات عمومی</strong>
          <label><span>نام جریان</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label><span>فاصلهٔ پایش منابع</span><select value={pollPresets.includes(pollIntervalMinutes) ? String(pollIntervalMinutes) : "custom"}
            onChange={(event) => setPollIntervalMinutes(event.target.value === "custom" ? 30 : Number(event.target.value))}>
            <option value={1}>هر ۱ دقیقه</option><option value={5}>هر ۵ دقیقه</option><option value={15}>هر ۱۵ دقیقه</option>
            <option value={60}>هر ۱ ساعت</option><option value={1440}>روزی یک‌بار</option><option value="custom">عدد دلخواه</option></select></label>
          {!pollPresets.includes(pollIntervalMinutes) ? <label><span>فاصلهٔ دلخواه (دقیقه، ۱ تا ۱۰۰۸۰)</span>
            <input type="number" min={1} max={10080} value={pollIntervalMinutes}
              onChange={(event) => setPollIntervalMinutes(Number(event.target.value))} /></label> : null}
          <small>فاصلهٔ ارسال خبر در کارت انتشار تنظیم می‌شود.</small>
        </div></details>
        <button className="ghost-button" onClick={() => void save(autoEnabled)} disabled={busy}>ذخیره تغییرات</button>
        {manual ? <button className="primary-button" onClick={() => void run()} disabled={busy}>▶ اجرای دستی</button> :
          <button className="primary-button" onClick={() => void save(!autoEnabled)} disabled={busy || !steps.length}>
            {autoEnabled ? "توقف پایش" : "فعال‌سازی خودکار"}</button>}
      </div></header>
    <div className="builder-layout"><section className="builder-workspace" aria-label="بوم جریان">
      <div className="graph-frame"><div className="graph-canvas-controls"><div className="graph-canvas-actions">
        {!workflowId ? <button type="button" className="graph-icon-action graph-ai-create" onClick={() => setGeneratorOpen(true)}>✦ ساخت با هوش مصنوعی</button> : null}
        <div className="graph-palette"><details><summary>+ افزودن کارت</summary><div className="graph-palette-menu">
        {types.map((item) => <button key={item.type} type="button" onClick={(event) => {
          add(item.type); event.currentTarget.closest("details")?.removeAttribute("open");
        }}>{item.label}</button>)}</div></details></div>
        <button type="button" className="graph-icon-action" title="مرتب‌سازی کارت‌ها" aria-label="مرتب‌سازی کارت‌ها" onClick={arrange} disabled={!steps.length}>⤢</button>
        </div><div className="graph-canvas-meta"><span className={`graph-canvas-status ${autoEnabled ? "active" : ""}`} title={autoEnabled ? `پایش فعال؛ ${durationLabel(pollIntervalMinutes)}` : "پیش‌نویس"}>{autoEnabled ? `● ${durationLabel(pollIntervalMinutes)}` : "○ پیش‌نویس"}</span>
        {workflowId ? <details className="graph-activity graph-usage"><summary>مصرف AI {usage?.totals.requests ? `· ${faNumber(usage.totals.requests)}` : ""}</summary>
          <div><strong>مصرف هوش مصنوعی این جریان</strong>
            <select aria-label="بازهٔ مصرف این جریان" value={usagePeriod} onChange={(event) => setUsagePeriod(event.target.value as "7d" | "30d" | "all")}>
              <option value="7d">۷ روز اخیر</option><option value="30d">۳۰ روز اخیر</option><option value="all">همهٔ زمان‌ها</option>
            </select>
            {usageError ? <span role="alert">{usageError}</span> : usage?.totals.requests ? <>
              <span>{faNumber(usage.totals.requests)} درخواست از مدل</span>
              <span>{faNumber(usage.totals.inputTokens)} توکن ورودی · {faNumber(usage.totals.outputTokens)} توکن خروجی</span>
              <span>هزینهٔ گزارش‌شده: {dollarCost(usage.totals)} دلار</span>
              {usage.totals.unreportedCost > 0 ? <small>هزینهٔ {faNumber(usage.totals.unreportedCost)} درخواست گزارش نشده؛ مبلغ بالا کامل نیست.</small> : null}
              {usage.totals.unreportedTokens > 0 ? <small>آمار توکن {faNumber(usage.totals.unreportedTokens)} درخواست کامل نیست.</small> : null}
            </> : <span>هنوز مصرفی برای این جریان ثبت نشده است.</span>}
            <Link href="/analytics">آمار همهٔ جریان‌ها ←</Link>
          </div></details> : null}
        {activity && (activity.publication || activity.queueCount || activity.run) ? <details className="graph-activity"><summary title="آخرین فعالیت همین جریان" aria-label="آخرین فعالیت همین جریان">فعالیت</summary><div><strong>آخرین فعالیت همین جریان</strong><span>{activity.publication?.status === "published" ? "منتشر شد" :
        activity.publication?.status === "failed" ? "ارسال ناموفق" : activity.publication ? "در صف انتشار" : activity.run?.status ?? "بدون خبر"}
        {activity.queueCount ? ` · ${activity.queueCount.toLocaleString("fa-IR")} خبر در صف` : ""}</span>
        {activity.run ? <Link href={`/runs/${activity.run.id}`}>دیدن آخرین اجرا و تحلیل ←</Link> : null}
        {activity.publication?.externalUrl ? <a href={activity.publication.externalUrl} target="_blank" rel="noreferrer">دیدن خبر ↗</a> : null}</div></details> : null}</div></div>
      {generatorOpen && !workflowId ? <div className="workflow-generator-backdrop" role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget && !generatorBusy) setGeneratorOpen(false);
      }}><section className="workflow-generator" role="dialog" aria-modal="true" aria-labelledby="workflow-generator-title" dir="rtl">
        <div className="workflow-generator-heading"><div><small>دستیار ساخت جریان</small><h2 id="workflow-generator-title">جریانت را توضیح بده</h2></div>
          <button type="button" aria-label="بستن" onClick={() => setGeneratorOpen(false)} disabled={generatorBusy}>×</button></div>
        <p>منبع، شرط‌ها، هوش مصنوعی، تأیید انسانی و مقصد را به زبان خودت بنویس. نتیجه به‌صورت پیش‌نویس روی بوم می‌آید.</p>
        <label><span>مدل سازنده</span><select value={generatorProfile} onChange={(event) => setGeneratorProfile(event.target.value)}>
          {aiProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>)}</select></label>
        {!aiProfiles.length ? <Link href="/settings/ai">ابتدا یک مدل و توکن ثبت کن ←</Link> : null}
        <label><span>توضیح جریان</span><textarea value={generatorRequest} onChange={(event) => setGeneratorRequest(event.target.value)}
          placeholder="مثلاً خبرهای ورزشی را از این RSS بخوان، فقط خبرهای فوتبال را نگه دار، با مدل فارسی بازنویسی کن، برای تأیید من بفرست و بعد در کانال ایتا منتشر کن. فاصلهٔ ارسال ۳۰ ثانیه باشد."
          maxLength={4000} /></label>
        <button type="button" className="primary-button" onClick={() => void generateWorkflow()} disabled={generatorBusy || !aiProfiles.length}>
          {generatorBusy ? "در حال طراحی جریان..." : "پیشنهاد ساخت جریان"}</button>
        {generatorError ? <p className="workflow-generator-error" role="alert">{generatorError}</p> : null}
        {generationUsage ? <div className="workflow-generator-cost"><strong>مصرف همین درخواست</strong><span>
          {generationUsage.costMicros === null ? "هزینه توسط سرویس گزارش نشده" :
            `هزینهٔ گزارش‌شده: ${(generationUsage.costMicros / 1_000_000).toLocaleString("fa-IR", { maximumFractionDigits: 6 })} دلار`}
        </span><small>ورودی: {generationUsage.inputTokens === null ? "گزارش نشده" : faNumber(generationUsage.inputTokens)} توکن · خروجی: {generationUsage.outputTokens === null ? "گزارش نشده" : faNumber(generationUsage.outputTokens)} توکن</small></div> : null}
        {generated?.templateUsed ? <div className="workflow-generator-cost"><strong>هزینهٔ ساخت: ۰ دلار</strong>
          <small>این درخواست با الگوی آمادهٔ مدیریت کامنت ساخته شد؛ برای ساخت بوم از مدل درخواست تازه‌ای گرفته نشد. تحلیل کامنت‌ها هنگام اجرای جریان مصرف جداگانه دارد.</small></div> : null}
        {generated ? <div className="workflow-generator-result"><strong>{generated.name}</strong>
          <span>{faNumber(generated.steps.length)} کارت · {faNumber(generated.connections.length)} اتصال</span>
          <ol>{generated.steps.map((step) => <li key={step.key}>{step.name}</li>)}</ol>
          {generated.warnings.length ? <div className="workflow-generator-warnings"><strong>قبل از فعال‌سازی تکمیل کن:</strong>
            {generated.warnings.map((warning, index) => <span key={index}>{warning}</span>)}</div> : null}
          <button type="button" className="primary-button" onClick={applyGeneratedWorkflow}>نمایش پیش‌نویس روی بوم</button>
        </div> : null}
      </section></div> : null}
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
            const sending = live?.publications.some((item) => item.stepKey === edge.targetKey && item.status === "publishing");
            return <g key={edgeId(edge)} className={`graph-edge ${selectedEdge === edgeId(edge) ? "selected" : ""} ${sending ? "sending" : ""}`}>
              <path className="edge-visible" d={path} />
              {sending ? <circle className="edge-sending-glow" r="4"><animateMotion begin="indefinite" dur="4s" repeatCount="indefinite" path={path}
                ref={(animation) => { if (animation && !animation.hasAttribute("data-started")) { animation.setAttribute("data-started", "true"); (animation as SVGElement & { beginElement: () => void }).beginElement(); } }} /></circle> : null}
              {edgePulses[edgeId(edge)] ? <circle key={edgePulses[edgeId(edge)]} className="edge-glow" r="4">
                <animateMotion begin="indefinite" dur="4s" fill="freeze" path={path}
                  ref={(animation) => { if (animation && !animation.hasAttribute("data-started")) { animation.setAttribute("data-started", "true"); (animation as SVGElement & { beginElement: () => void }).beginElement(); } }} /></circle> : null}
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
        {steps.map((step) => <article key={step.key} className={`graph-node ${isSource(step) ? "role-source" : isTerminal(step) ? "role-output" : "role-process"} ${selectedKey === step.key ? "selected" : ""} ${stepActivity(step)?.state ? `node-${stepActivity(step)?.state}` : ""}`}
          style={{ left: step.position.x, top: step.position.y }} onClick={() => { setSelectedKey(step.key); setSelectedEdge(null); }}>
          {!isSource(step) ? <button className="graph-port input" title="ورودی؛ خروجی یک کارت را اینجا رها کن"
            aria-label={`ورودی ${step.name}`} onPointerUp={(event) => { event.stopPropagation(); if (connecting) connect(connecting, step.key); }}
            onClick={() => { if (connecting) connect(connecting, step.key); }}>●</button> : null}
          <div className="graph-node-head" onPointerDown={(event) => {
            if (event.button !== 0) return;
            dragRef.current = { key: step.key, startX: event.clientX, startY: event.clientY,
              x: step.position.x, y: step.position.y }; setSelectedKey(step.key);
          }}><span className="graph-kind">{step.type === "rss_source" ? sourceNames[String(step.config.sourceKind ?? "rss")] :
            step.type === "api_source" || step.type === "api_action" ? "سرویس" : step.type === "comment_decision" ? "هوش" :
            step.type === "filter" ? "شرط" : step.type === "publish" ?
              publishNames[accounts.find((account) => account.id === step.config.accountId)?.channel ?? ""] ?? "خروجی" :
              step.type === "ai" ? "هوش" : "کارت"}</span>
            <button type="button" className="graph-delete" title="حذف کارت" aria-label={`حذف ${step.name}`} onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => { event.stopPropagation(); remove(step.key); }}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg></button></div>
          <span className="graph-role-label">{stepActivity(step) ? <><span className={stepActivity(step)!.state === "running" ? "graph-live-spinner" : "graph-live-dot"} />{stepActivity(step)!.label}</> :
            isSource(step) ? "ورودی" : isTerminal(step) ? "خروجی" : "پردازش"}</span>
          <strong>{step.type === "publish" && accounts.find((a) => a.id === step.config.accountId)?.channel === "youtube" ? <><YoutubeIcon /> یوتیوب</> : step.type === "publish" ? "انتشار شبکه‌ها" : step.name}</strong>
          {youtubeItems.find((i) => i.stepKey === step.key)?.status === "published" ? <a onClick={(e) => e.stopPropagation()} target="_blank" rel="noreferrer" href={`https://www.youtube.com/watch?v=${youtubeItems.find((i) => i.stepKey === step.key)?.videoId}`}>مشاهده در یوتیوب</a> : null}
          <small title={step.type === "rss_source" ? String(step.config.feedUrl ?? step.config.channel ?? "") : undefined}>{step.type === "rss_source" ?
            String(step.config.feedUrl ?? step.config.channel ?? "").trim() ? String(step.config.feedUrl ?? step.config.channel) : "نیاز به تنظیم منبع" :
            step.type === "filter" ? `${step.config.mode === "exclude" ? "به‌جز" : "شامل"} ${step.config.keywords || "واژه‌ها را تنظیم کن"}` :
            step.type === "publish" ? publishAccounts.find((account) => account.id === step.config.accountId)?.displayName ?? "مقصد را انتخاب کن" :
            step.type === "api_source" || step.type === "api_action" ? apiConnections.find((item) => item.id === step.config.connectionId)?.name ?? "اتصال سرویس را انتخاب کن" :
            step.type === "comment_decision" ? "تأیید، رد، پاسخ یا بررسی" :
            step.type === "ai" && step.config.aiMode === "feedback" ? "تحلیل بازخورد گروهی" :
            step.type === "collection_source" ? "اکسل، گوگل‌شیت و برنامه انتشار" : step.type === "human_approval" ? "در انتظار بررسی شما" : "به کارت‌های دیگر وصل کن"}</small>
          {step.type === "rss_source" ? <div className="graph-source-footer graph-source-schedule"><span>{String(step.config.feedUrl ?? step.config.channel ?? "").trim() ? "● آماده" : "○ تنظیم‌نشده"} · {sourceNames[String(step.config.sourceKind ?? "rss")]}</span>
            <span title="زمان تقریبی پایش بعدی">{countdownLabel(live?.nextPollAt, clock, autoEnabled)}</span></div> : null}
          {step.type === "api_source" ? <div className="graph-source-footer graph-source-schedule"><span>منبع API</span>
            <span title="زمان تقریبی پایش بعدی">{countdownLabel(live?.nextPollAt, clock, autoEnabled)}</span></div> : null}
          {step.type === "publish" ? <div className="graph-source-footer graph-connection-label" title={cardConnection(step)}>{step.config.accountId ? cardConnection(step) : "○ مقصد انتخاب نشده است"}</div> : null}
          {step.type === "filter" && live?.filters?.some((item) => item.stepKey === step.key) ?
            <div className={`graph-source-footer graph-filter-footer ${live.filters.find((item) => item.stepKey === step.key)?.passed ? "passed" : "rejected"}`}>
              {live.filters.find((item) => item.stepKey === step.key)?.passed ? "✓ عبور کرد" : "⊘ رد شد"} · آخرین خبر
            </div> : null}
          {["ai", "comment_decision"].includes(step.type) && usage?.byStep.find((item) => item.stepKey === step.key) ?
            <div className="graph-source-footer graph-usage-footer">مصرف {usagePeriod === "7d" ? "۷ روز" : usagePeriod === "all" ? "کل" : "۳۰ روز"} ·
              {faNumber(usage.byStep.find((item) => item.stepKey === step.key)!.requests)} درخواست</div> : null}
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
        {selected.type === "filter" && live?.filters?.find((item) => item.stepKey === selected.key) ? (() => {
          const result = live.filters.find((item) => item.stepKey === selected.key)!;
          return <section className={`graph-filter-result ${result.passed ? "passed" : "rejected"}`} aria-label="آخرین نتیجهٔ شرط">
            <strong>آخرین نتیجه: {result.passed ? "خبر عبور کرد" : "خبر رد شد"}</strong>
            <span>{result.title || "خبر بدون عنوان"}</span>
            {result.at ? <small>{new Date(result.at).toLocaleString("fa-IR")}</small> : null}
            <Link href={`/runs/${result.runId}`}>دیدن جزئیات اجرا ←</Link>
          </section>;
        })() : null}
        {["ai", "comment_decision"].includes(selected.type) && workflowId ? <section className="card-usage-report" aria-label="مصرف این کارت">
          <strong>مصرف این کارت · {usagePeriod === "7d" ? "۷ روز اخیر" : usagePeriod === "all" ? "همهٔ زمان‌ها" : "۳۰ روز اخیر"}</strong>
          {selectedUsage ? <><span>{faNumber(selectedUsage.requests)} بار از مدل درخواست شده</span>
            <span>{faNumber(selectedUsage.inputTokens)} توکن ورودی · {faNumber(selectedUsage.outputTokens)} توکن خروجی</span>
            <span>هزینهٔ گزارش‌شده: {dollarCost(selectedUsage)} دلار</span>
            {selectedUsage.unreportedCost > 0 || selectedUsage.unreportedTokens > 0 ?
              <small>بخشی از مصرف را سرویس گزارش نکرده؛ رقم هزینه ممکن است کامل نباشد.</small> : null}</> :
            <span>هنوز برای این کارت مصرفی ثبت نشده است.</span>}
          <small>توکن، مقدار متن پردازش‌شده توسط مدل است؛ این عدد تعداد خبر نیست.</small>
        </section> : null}
        {isSource(selected) && selected.type !== "collection_source" ? <label><span>نوع منبع</span><select value={selected.type === "api_source" ? "api" :
          selected.type === "manual_input" ? "manual" : String(selected.config.sourceKind ?? "rss")}
          onChange={(event) => switchSource(selected.key, event.target.value)}>
          <option value="rss">RSS</option><option value="eitaa">کانال ایتا</option><option value="bale">کانال بله</option>
          <option value="api">کامنت API</option><option value="manual">ورودی دستی</option></select></label> : null}
        {selected.type === "collection_source" ? <CollectionPanel key={selected.key} workflowId={workflowId} stepKey={selected.key}
          targets={steps.filter((s) => s.type === "publish" && ["youtube", "telegram", "eitaa", "bale", "instagram", "website"].includes(accounts.find((a) => a.id === s.config.accountId)?.channel ?? "") && edges.some((e) => e.sourceKey === selected.key && e.targetKey === s.key)).map((s)=>({...s,config:{...s.config,collectionChannel:accounts.find((a)=>a.id===s.config.accountId)?.channel}}))}
          config={selected.config} update={(key,value) => update(selected.key,key,value)} refresh={refreshYoutube} items={youtubeItems} calendarOutputs={collectionOutputs} /> : null}
        {selected.type === "rss_source" ? <>
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
            onChange={(event) => { update(selected.key, "connectionId", event.target.value); setConnectionFormOpen(false); setConnectionToken(""); }}><option value="">انتخاب اتصال</option>
            {apiConnections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}</select></label>
          <div className="api-connection-actions">
            <button type="button" onClick={() => openConnectionForm()}>+ اتصال جدید</button>
            {apiConnections.find((connection) => connection.id === selected.config.connectionId) ? <button type="button"
              onClick={() => openConnectionForm(apiConnections.find((connection) => connection.id === selected.config.connectionId))}>ویرایش اتصال</button> : null}
          </div>
          {connectionFormOpen ? <div className="api-connection-inline">
            <strong>{connectionEditingId ? "ویرایش اتصال مشترک" : "اتصال API جدید"}</strong>
            {connectionEditingId ? <small>تغییر این اتصال روی همهٔ کارت‌هایی که از آن استفاده می‌کنند اثر می‌گذارد.</small> : null}
            <label><span>نام اتصال</span><input value={connectionName} onChange={(event) => setConnectionName(event.target.value)} placeholder="API کامنت‌ها" /></label>
            <label><span>نشانی پایهٔ HTTPS</span><input dir="ltr" type="url" value={connectionBaseUrl}
              onChange={(event) => setConnectionBaseUrl(event.target.value)} placeholder="https://api.example.com" /></label>
            <label><span>روش احراز هویت</span><select value={connectionAuthType}
              onChange={(event) => setConnectionAuthType(event.target.value as "bearer" | "api_key")}>
              <option value="bearer">Bearer Token</option><option value="api_key">کلید در هدر X-API-Key</option></select></label>
            {connectionAuthType === "api_key" ? <label><span>نام هدر</span><input dir="ltr" value={connectionHeaderName}
              onChange={(event) => setConnectionHeaderName(event.target.value)} placeholder="X-API-Key" /></label> : null}
            <label><span>{connectionEditingId ? "توکن تازه (اختیاری)" : "توکن API"}</span><input type="password" autoComplete="new-password"
              value={connectionToken} onChange={(event) => setConnectionToken(event.target.value)} placeholder={connectionEditingId ? "توکن قبلی حفظ می‌شود" : "توکن را وارد کن"} /></label>
            {connectionError ? <small role="alert" className="api-connection-error">{connectionError}</small> : null}
            <div className="api-connection-actions"><button type="button" disabled={connectionBusy}
              onClick={() => void saveConnection(selected.key)}>{connectionBusy ? "در حال ذخیره..." : "ذخیره و انتخاب اتصال"}</button>
              <button type="button" disabled={connectionBusy} onClick={() => { setConnectionFormOpen(false); setConnectionToken(""); setConnectionError(""); }}>انصراف</button></div>
          </div> : null}
          <label><span>مسیر نسبی روی همان میزبان</span><input dir="ltr" value={String(selected.config.path ?? "")}
            onChange={(event) => update(selected.key, "path", event.target.value)} placeholder="/comments" /></label>
          {selected.type === "api_source" ? <>
            <label><span>روش خواندن کامنت‌ها</span><select value={String(selected.config.readMode ?? "single")}
              onChange={(event) => update(selected.key, "readMode", event.target.value)}>
              <option value="single">تکی؛ برای تصمیم و اقدام هر کامنت</option>
              <option value="batch">گروهی؛ آخرین کامنت‌ها</option>
              <option value="post">گروهی؛ کامنت‌های یک نوشته</option></select></label>
            {selected.config.readMode === "batch" || selected.config.readMode === "post" ? <>
              <label className="builder-check"><input type="checkbox" checked={selected.config.includeIndividual === true}
                onChange={(event) => update(selected.key, "includeIndividual", event.target.checked)} />
                <span>در کنار تحلیل گروهی، هر کامنت تازه را جداگانه برای تصمیم و اقدام هم بفرست</span></label>
              <label><span>تعداد کامنت برای تحلیل</span><select value={selected.config.readAll === true ? "all" :
                [10, 25, 50].includes(Number(selected.config.batchLimit ?? 10)) ? String(selected.config.batchLimit ?? 10) : "custom"}
                onChange={(event) => { const value = event.target.value;
                  update(selected.key, "readAll", value === "all");
                  if (value !== "all" && value !== "custom") update(selected.key, "batchLimit", Number(value));
                  if (value === "custom" && [10, 25, 50].includes(Number(selected.config.batchLimit))) update(selected.key, "batchLimit", 100);
                }}><option value="10">۱۰ کامنت</option><option value="25">۲۵ کامنت</option><option value="50">۵۰ کامنت</option>
                <option value="custom">عدد دلخواه</option><option value="all">همهٔ کامنت‌ها (تا ۵۰۰۰ یا ۱۰۰ صفحه)</option></select></label>
              {selected.config.readAll !== true && ![10, 25, 50].includes(Number(selected.config.batchLimit ?? 10)) ?
                <label><span>تعداد دلخواه (۱ تا ۱۰۰۰)</span><input type="number" min={1} max={1000} value={Number(selected.config.batchLimit ?? 100)}
                  onChange={(event) => update(selected.key, "batchLimit", Number(event.target.value))} /></label> : null}
              {selected.config.readMode === "post" ? <>
                <label><span>فیلد شناسهٔ نوشته در هر کامنت</span><input dir="ltr" value={String(selected.config.postIdField ?? "postId")}
                  onChange={(event) => update(selected.key, "postIdField", event.target.value)} placeholder="postId" /></label>
                <label><span>شناسهٔ نوشته</span><input dir="ltr" value={String(selected.config.postId ?? "")}
                  onChange={(event) => update(selected.key, "postId", event.target.value)} placeholder="123" /></label>
              </> : null}
              <small className="builder-note">صفحه‌های API با PageNumber/PageSize خوانده می‌شوند؛ هر تحلیل حداکثر ۵۰ کامنت دارد. حالت «همه» در هر پایش تا ۵۰۰۰ مورد یا ۱۰۰ صفحه را می‌خواند.</small>
            </> : null}
            {([ ["itemsPath", "مسیر آرایهٔ کامنت‌ها", "data.comments"], ["idField", "فیلد شناسه", "id"],
              ["textField", "فیلد متن", "text"], ["contextField", "فیلد زمینه (اختیاری)", "context"] ] as const)
              .map(([key, label, hint]) => <label key={key}><span>{label}</span><input dir="ltr" value={String(selected.config[key] ?? "")}
                placeholder={hint} onChange={(event) => update(selected.key, key, event.target.value)} /></label>)}
            <div className="api-source-check">
              <button type="button" disabled={sourcePreviewBusy} onClick={() => void previewSource(selected)}>
                {sourcePreviewBusy ? "در حال خواندن API..." : "آزمایش اتصال و خواندن کامنت‌ها"}</button>
              {sourcePreviewError ? <p role="alert" className="api-connection-error">{sourcePreviewError}</p> : null}
              {sourcePreview ? <div role="status"><strong>✓ اتصال برقرار شد</strong>
                <p>{sourcePreview.pagesFetched.toLocaleString("fa-IR")} صفحه · {sourcePreview.rawCount.toLocaleString("fa-IR")} مورد · مطابق فیلتر: {sourcePreview.matchedCount.toLocaleString("fa-IR")} · قابل خواندن: {sourcePreview.validCount.toLocaleString("fa-IR")}</p>
                {sourcePreview.capped ? <small>سقف این نوبت رسید؛ ممکن است موارد بیشتری هنوز خوانده نشده باشند.</small> : null}
                {sourcePreview.validCount === 0 ? <p>هیچ کامنتی با فیلدهای فعلی خوانده نشد. مسیرهای آرایه: {sourcePreview.availablePaths.join("، ") || "پیدا نشد"}. فیلد شناسه، متن و فیلتر نوشته را بررسی کن.</p> :
                  sourcePreview.samples.map((item) => <p key={item.id} className="api-source-sample"><b>#{item.id}</b> {item.text}</p>)}
                <small>این آزمایش چیزی منتشر نمی‌کند و وارد صف نمی‌کند.</small>
              </div> : null}
            </div>
            {workflowId ? <div className="api-source-check"><strong>آخرین پایش خودکار</strong>
              {!sourceHealth || sourceHealth.status === "not_checked" ? <p>هنوز نتیجهٔ پایش این منبع ثبت نشده است. اگر جریان فعال است و پس از یک نوبت پایش هم همین پیام ماند، وضعیت worker را بررسی کن.</p> :
                sourceHealth.status === "error" ? <p role="alert" className="api-connection-error">{sourceHealth.error}</p> :
                <p>{sourceHealth.pagesFetched?.toLocaleString("fa-IR")} صفحه · {sourceHealth.rawCount?.toLocaleString("fa-IR")} مورد · {sourceHealth.validCount?.toLocaleString("fa-IR")} کامنت خوانده‌شده · {sourceHealth.queuedCount?.toLocaleString("fa-IR")} اجرای تازه در صف</p>}
              {sourceHealth?.status === "ok" && sourceHealth.validCount && !sourceHealth.queuedCount ?
                <small>کامنت خوانده شد، اما مورد تازه‌ای برای پردازش نبود؛ شناسه‌ها یا محتوای این گروه قبلاً پردازش شده‌اند.</small> : null}
              {sourceHealth?.checkedAt ? <small>زمان بررسی: {new Date(sourceHealth.checkedAt).toLocaleString("fa-IR")}</small> : null}
              {activity?.run ? <Link href={`/runs/${activity.run.id}`}>دیدن آخرین اجرای جریان ←</Link> : null}
            </div> : null}
            <small className="builder-note">پایش طبق فاصلهٔ جریان انجام می‌شود؛ گروهی با شناسه‌های یکسان دوباره تحلیل نمی‌شود.</small>
          </> : <>
            <label><span>اقدام</span><select value={String(selected.config.action ?? "approve")}
              onChange={(event) => { const action = event.target.value; update(selected.key, "action", action);
                setEdges((current) => current.map((edge) => edge.targetKey === selected.key &&
                  steps.find((step) => step.key === edge.sourceKey)?.type === "comment_decision" ?
                  { ...edge, condition: { decision: action } } : edge));
              }}><option value="approve">تأیید</option>
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
        {["ai", "comment_decision"].includes(selected.type) ? <label><span>کار هوش مصنوعی</span><select
          value={selected.type === "comment_decision" ? "decision" : String(selected.config.aiMode ?? "rewrite")}
          onChange={(event) => switchAI(selected.key, event.target.value)}>
          <option value="rewrite">بازنویسی خبر</option><option value="feedback">تحلیل بازخورد کامنت‌ها</option>
          <option value="decision">تصمیم برای هر کامنت</option></select></label> : null}
        {selected.type === "comment_decision" ? <>
          <label><span>مدل تصمیم</span><select value={String(selected.config.profileId ?? "default")}
            onChange={(event) => update(selected.key, "profileId", event.target.value)}><option value="default">مدل پیش‌فرض</option>
            {aiProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>)}</select></label>
          <label><span>قواعد و محدودیت‌های تصمیم</span><textarea value={String(selected.config.rules ?? "")}
            onChange={(event) => update(selected.key, "rules", event.target.value)}
            placeholder="کامنت‌های محترمانه را تأیید کن؛ توهین را رد کن؛ سؤال مرتبط را پاسخ بده؛ مورد مبهم را برای بررسی بفرست." /></label>
          <small className="builder-note">برای هر اتصال خروجی، تصمیم تأیید، رد، پاسخ یا بررسی انسانی را انتخاب کن.</small>
        </> : null}
        {selected.type === "publish" ? <><label><span>مقصد انتشار</span><select value={String(selected.config.accountId ?? "")}
          onChange={(event) => update(selected.key, "accountId", event.target.value)}><option value="">انتخاب مقصد</option>
          {publishAccounts.map((account) => <option key={account.id} value={account.id}>{publishNames[account.channel]} · {account.displayName ?? account.externalAccountId}</option>)}</select></label>
          {["youtube", "telegram", "instagram"].includes(accounts.find((a) => a.id === selected.config.accountId)?.channel ?? "") ?
            <ConnectionSelector key={String(selected.config.accountId)} target={accounts.find((a) => a.id === selected.config.accountId)!.channel as "youtube" | "telegram" | "instagram"}
              value={selected.config.connection} onChange={(value) => update(selected.key, "connection", value)} /> : null}
          <a href="/connections">اتصال کانال یوتیوب با گوگل</a>
          {accounts.find((a) => a.id === selected.config.accountId)?.channel === "youtube" ? <YoutubePanel key={`${selected.key}-${selected.config.accountId}`} workflowId={workflowId} stepKey={selected.key}
            accountId={String(selected.config.accountId)} config={selected.config} update={(key, value) => update(selected.key, key, value)} items={youtubeItems} refresh={refreshYoutube} /> : null}
          {accounts.find((a) => a.id === selected.config.accountId)?.channel !== "youtube" ? <><label><span>فاصلهٔ انتشار در همین کانال</span><select
            value={publishPresets.includes(Number(selected.config.publishIntervalSeconds ?? 30)) ?
              String(selected.config.publishIntervalSeconds ?? 30) : "custom"}
            onChange={(event) => update(selected.key, "publishIntervalSeconds", event.target.value === "custom" ? 600 : Number(event.target.value))}>
            <option value={30}>۳۰ ثانیه</option><option value={60}>۱ دقیقه</option><option value={300}>۵ دقیقه</option>
            <option value={3600}>هر ۱ ساعت</option><option value={86400}>روزی یک‌بار</option><option value="custom">عدد دلخواه</option></select></label>
          {!publishPresets.includes(Number(selected.config.publishIntervalSeconds ?? 30)) ?
            <label><span>فاصلهٔ دلخواه (ثانیه، ۳۰ تا ۶۰۴۸۰۰)</span><input type="number" min={30} max={604800}
              value={Number(selected.config.publishIntervalSeconds ?? 600)}
              onChange={(event) => update(selected.key, "publishIntervalSeconds", Number(event.target.value))} /></label> : null}
          <small className="builder-note">این فاصله بین دو پیام همان مقصد اعمال می‌شود؛ تنظیم روزانه یعنی هر ۲۴ ساعت حداکثر یک ارسال.</small>
          {!publishAccounts.length ? <Link href="/connections">+ اتصال مقصد انتشار</Link> : null}
          <small className="builder-note">ایتا، تلگرام و وب‌سایت آمادهٔ انتشارند. اینستاگرام و بله پس از پیاده‌سازی و آزمایش ناشرشان اضافه می‌شوند.</small></> : null}</> : null}
        {selected.type === "ai" ? <><label><span>مدل و توکن این کارت</span><select value={String(selected.config.profileId ?? "default")}
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
