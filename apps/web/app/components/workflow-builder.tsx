"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type Step = {
  key: string;
  type: string;
  name: string;
  subtitle: string;
  badge: string;
};

const initialSteps: Step[] = [
  { key: "monitor", type: "source", name: "پایش منابع", subtitle: "هر ۱۰ دقیقه", badge: "ورودی" },
  { key: "verify", type: "agent", name: "اعتبارسنجی خبر", subtitle: "حداقل ۲ منبع معتبر", badge: "ایجنت" },
  { key: "rewrite", type: "ai", name: "بازنویسی محتوا", subtitle: "با لحن رسانه", badge: "هوش مصنوعی" },
  { key: "sensitivity", type: "logic", name: "بررسی حساسیت", subtitle: "سیاسی / حساس؟", badge: "منطق" },
  { key: "approval", type: "human_approval", name: "تأیید انسانی", subtitle: "فقط برای محتوای حساس", badge: "انسان" },
  { key: "publish", type: "publish", name: "انتشار", subtitle: "سایت + تلگرام", badge: "انتشار" },
];

const defaultPrompt =
  "هر ۱۰ دقیقه خبرهای مهم AI را بررسی کن؛ فقط خبر معتبر را ادامه بده، با لحن رسانه بازنویسی کن، اگر سیاسی بود از من تأیید بگیر و بقیه را در سایت و تلگرام منتشر کن.";

export function WorkflowBuilder() {
  const router = useRouter();
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [steps] = useState(initialSteps);
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("آماده ذخیره");
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const workspaceId = process.env.NEXT_PUBLIC_WORKSPACE_ID ?? "";

  const connections = useMemo(
    () =>
      steps.slice(0, -1).map((step, index) => ({
        sourceKey: step.key,
        targetKey: steps[index + 1].key,
      })),
    [steps],
  );

  const save = async () => {
    if (!workspaceId) {
      setMessage("NEXT_PUBLIC_WORKSPACE_ID تنظیم نشده");
      return null;
    }

    setBusy(true);
    setMessage("در حال ذخیره...");

    try {
      const body = {
        workspaceId,
        name: "خبرهای AI",
        description: "کشف، اعتبارسنجی، تولید و انتشار خبرهای AI",
        autonomyMode: "assisted",
        prompt,
        steps: steps.map((step, order) => ({
          key: step.key,
          type: step.type,
          name: step.name,
          config:
            step.type === "human_approval"
              ? { recommendation: "محتوای حساس قبل از انتشار بررسی شود" }
              : {},
          position: { x: order * 190, y: 0 },
          order,
        })),
        connections,
      };

      const response = await fetch(`${apiUrl}/workflows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`Save failed (${response.status})`);
      }

      const data = await response.json();
      setWorkflowId(data.workflow.id);
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
      const id = workflowId ?? (await save());
      if (!id) return;

      const response = await fetch(`${apiUrl}/workflows/${id}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
          <strong>SocialYar</strong>
          <span>ساخت جریان با هوش مصنوعی</span>
        </div>
        <div className="header-actions">
          <span className="save-status">{message}</span>
          <button className="ghost-button" onClick={save} disabled={busy}>
            ذخیره
          </button>
          <button className="primary-button" onClick={run} disabled={busy}>
            ▶ اجرای جریان
          </button>
        </div>
      </header>

      <section className="workflow-layout">
        <div className="canvas-panel">
          <div className="canvas-title">
            <div>
              <h1>جریان پیشنهادی</h1>
              <p>۶ مرحله از روی درخواست تو ساخته شد · ۱ نقطه تأیید انسانی</p>
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
                    {index > 0 && index < 5 ? <span className="ai-badge">AI</span> : null}
                  </div>
                  <h3>{step.name}</h3>
                  <p>{step.subtitle}</p>
                  <span className="node-badge">{step.badge}</span>
                </article>
              ))}
            </div>
          </div>

          <div className="ai-summary">
            <h2>AI چه چیزی ساخته؟</h2>
            <div className="summary-points">
              <span>+ اعتبارسنجی با دو منبع</span>
              <span>+ قانون حساسیت و تأیید انسانی</span>
              <span>+ انتشار در سایت و تلگرام</span>
            </div>
            <p>فرض AI: چون منبع مشخص نکردی، از منابع با Trust بالا استفاده می‌شود.</p>
          </div>
        </div>

        <aside className="assistant-panel">
          <div>
            <h2>دستیار ساخت جریان</h2>
            <p>هدفت را بنویس؛ مرحله و اتصال‌ها مستقیم روی Canvas ساخته می‌شوند.</p>
          </div>

          <label className="prompt-box">
            <span>درخواست</span>
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          </label>

          <button className="primary-button wide">✦ ساخت جریان</button>

          <div className="understood-card">
            <h3>این چیزی است که فهمیدم</h3>
            <dl>
              <div><dt>هدف</dt><dd>کشف و انتشار سریع خبر معتبر</dd></div>
              <div><dt>تناوب</dt><dd>هر ۱۰ دقیقه</dd></div>
              <div><dt>اعتبار</dt><dd>حداقل ۲ منبع</dd></div>
              <div><dt>تأیید</dt><dd>فقط سیاسی / حساس</dd></div>
              <div><dt>خروجی</dt><dd>Website + Telegram</dd></div>
            </dl>
          </div>

          <div className="before-save">
            <h3>قبل از ذخیره</h3>
            <p>می‌توانی همه تغییرات را تأیید کنی یا با یک جمله اصلاحشان کنی.</p>
            <div className="inline-actions">
              <button className="ghost-button">✎ اصلاح با دستور</button>
              <button className="success-button" onClick={save} disabled={busy}>✓ تأیید و ذخیره</button>
            </div>
          </div>
        </aside>
      </section>
    </main>
  );
}
