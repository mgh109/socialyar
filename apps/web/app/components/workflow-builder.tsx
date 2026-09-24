"use client";

import { BrandLogo } from "./brand-logo";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "../lib/session";

type Step = {
  key: string;
  type: string;
  name: string;
  subtitle: string;
  badge: string;
  config?: Record<string, unknown>;
};

const initialSteps: Step[] = [
  { key: "input", type: "manual_input", name: "متن ورودی", subtitle: "متن را خودت وارد کن", badge: "ورودی" },
  { key: "review", type: "human_approval", name: "تأیید انسانی", subtitle: "پیش از ادامه", badge: "تأیید" },
  { key: "draft", type: "draft", name: "پیش‌نویس", subtitle: "آماده ویرایش در استودیو", badge: "خروجی" },
];

const defaultPrompt = "";

export function WorkflowBuilder() {
  const router = useRouter();
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [steps, setSteps] = useState<Step[]>(initialSteps);
  const [name, setName] = useState("خبرهای AI");
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("آماده ذخیره");

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("id");
    if (!id) return;
    void apiFetch(`/workflows/${encodeURIComponent(id)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("جریان پیدا نشد");
        return response.json();
      })
      .then((data: { workflow: { id: string; name: string }; version: { prompt: string | null } | null; steps: Array<{ key: string; type: string; name: string; config: Record<string, unknown> }> }) => {
        setWorkflowId(data.workflow.id);
        setName(data.workflow.name);
        setPrompt(data.version?.prompt ?? "");
        setSteps(data.steps.map((step) => ({
          ...step,
          subtitle: initialSteps.find((item) => item.key === step.key)?.subtitle ?? "",
          badge: initialSteps.find((item) => item.key === step.key)?.badge ?? step.type,
        })));
        setMessage("جریان ذخیره‌شده بارگذاری شد");
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : "بارگذاری جریان ناموفق بود"));
  }, []);

  const connections = useMemo(
    () =>
      steps.slice(0, -1).map((step, index) => ({
        sourceKey: step.key,
        targetKey: steps[index + 1].key,
      })),
    [steps],
  );

  const save = async () => {
    setBusy(true);
    setMessage("در حال ذخیره...");

    try {
      const body = {
        name,
        description: prompt.slice(0, 180),
        autonomyMode: "assisted",
        prompt,
        steps: steps.map((step, order) => ({
          key: step.key,
          type: step.type,
          name: step.name,
          config:
            step.type === "human_approval"
              ? { recommendation: "محتوای حساس قبل از انتشار بررسی شود", ...step.config }
              : step.config ?? {},
          position: { x: order * 190, y: 0 },
          order,
        })),
        connections,
      };

      const response = await apiFetch(workflowId ? `/workflows/${workflowId}` : "/workflows", {
        method: workflowId ? "PUT" : "POST",
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error ?? `Save failed (${response.status})`);
      }

      const data = await response.json();
      setWorkflowId(data.workflow.id);
      if (!workflowId) window.history.replaceState(null, "", `/workflows/new?id=${data.workflow.id}`);
      setMessage("✓ جریان ذخیره شد");
      return data.workflow.id as string;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "ذخیره ناموفق بود");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    setBusy(true);
    setMessage("در حال ساخت Run...");

    try {
      const id = await save();
      if (!id) return;

      const response = await apiFetch(`/workflows/${id}/runs`, {
        method: "POST",
        body: JSON.stringify({ trigger: "manual", input: { prompt } }),
      });

      if (!response.ok) throw new Error(`Run failed (${response.status})`);

      const data = await response.json();
      router.push(`/runs/${data.id}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "اجرای جریان ناموفق بود");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="workflow-page">
      <header className="app-header">
        <div className="brand-lockup">
          <BrandLogo />
          <span>ساخت جریان</span>
        </div>
        <div className="header-actions">
          <span className="save-status">{message}</span>
          <button className="ghost-button" onClick={save} disabled={busy || !name.trim()}>
            ذخیره
          </button>
          <button className="primary-button" onClick={run} disabled={busy || !name.trim() || !prompt.trim()}>
            ▶ اجرای جریان
          </button>
        </div>
      </header>

      <section className="workflow-layout">
        <div className="canvas-panel">
          <div className="canvas-title">
            <div>
              <h1>جریان دستی</h1>
              <p>ورودی دستی، تأیید و پیش‌نویس؛ تولید خودکار و پایش منابع هنوز فعال نیست</p>
            </div>
            <span className="status-pill">Assisted</span>
          </div>

          <div className="flow-canvas">
            <svg className="flow-lines" viewBox="0 0 1080 220" preserveAspectRatio="none" aria-hidden>
              {steps.slice(0, -1).map((_, index) => (
                <line
                  key={index}
                  x1={160 + index * 176}
                  y1="110"
                  x2={205 + index * 176}
                  y2="110"
                />
              ))}
            </svg>

            <div className="node-row">
              {steps.map((step, index) => (
                <article className={`flow-node node-${step.type}`} key={step.key}>
                  <div className="node-top">
                    <span className="node-index">{String(index + 1).padStart(2, "0")}</span>
                    {step.type === "ai" ? <span className="ai-badge">AI</span> : null}
                  </div>
                  <h3>{step.name}</h3>
                  <p>{step.subtitle}</p>
                  <span className="node-badge">{step.badge}</span>
                </article>
              ))}
            </div>
          </div>

          <div className="ai-summary">
            <h2>طرح این جریان</h2>
            <div className="summary-points">
              <span>+ دریافت متن از شما</span>
              <span>+ توقف برای تأیید</span>
              <span>+ ساخت پیش‌نویس قابل ویرایش</span>
            </div>
            <p>پیش از اجرا، تنظیمات هر مرحله را بررسی کن.</p>
          </div>
        </div>

        <aside className="assistant-panel">
          <div>
            <h2>دستیار ساخت جریان</h2>
            <p>متن را وارد کن؛ این نسخه یک مسیر دستی با تأیید انسانی می‌سازد.</p>
          </div>

          <label className="prompt-box">
            <span>نام جریان</span>
            <input value={name} onChange={(event) => setName(event.target.value)} required />
          </label>

          <label className="prompt-box">
            <span>درخواست</span>
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="متن خودت را برای ساخت پیش‌نویس وارد کن" />
          </label>

          <button className="primary-button wide" onClick={save} disabled={busy || !name.trim()}>ذخیره جریان</button>

          <div className="understood-card">
            <h3>این چیزی است که فهمیدم</h3>
            <dl>
              <div><dt>هدف</dt><dd>ساخت پیش‌نویس از متن ورودی</dd></div>
              <div><dt>تناوب</dt><dd>اجرای دستی</dd></div>
              <div><dt>اعتبار</dt><dd>متن واردشده توسط شما</dd></div>
              <div><dt>تأیید</dt><dd>قبل از ادامه</dd></div>
              <div><dt>خروجی</dt><dd>پیش‌نویس برای استودیو</dd></div>
            </dl>
          </div>

          <div className="before-save">
            <h3>قبل از ذخیره</h3>
            <p>متن و نام جریان را بررسی کن، سپس ذخیره کن.</p>
            <div className="inline-actions">
              <button className="success-button" onClick={save} disabled={busy}>✓ تأیید و ذخیره</button>
            </div>
          </div>
        </aside>
      </section>
    </main>
  );
}
