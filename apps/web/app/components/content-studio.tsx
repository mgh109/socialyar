"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type Variant = {
  id: string;
  channel: "instagram" | "telegram" | "website" | "x" | "linkedin";
  title: string | null;
  body: string;
  hashtags: string[];
  settings: Record<string, unknown>;
  status: string;
};

type StudioPayload = {
  content: {
    id: string;
    title: string | null;
    body: string;
    status: string;
  };
  variants: Variant[];
  provenance: {
    runId: string;
    workflowId: string;
    workflowName: string;
  };
};

const channelLabels: Record<string, string> = {
  instagram: "Instagram",
  telegram: "Telegram",
  website: "Website",
  x: "X",
  linkedin: "LinkedIn",
};

export function ContentStudio({ runId }: { runId: string }) {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const [data, setData] = useState<StudioPayload | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [message, setMessage] = useState("در حال دریافت خروجی Run...");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetch(`${apiUrl}/runs/${runId}/content`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Content Studio failed (${response.status})`);
        return response.json();
      })
      .then((payload: StudioPayload) => {
        setData(payload);
        setActiveId(payload.variants[0]?.id ?? null);
        setMessage("● پیش‌نویس آماده بررسی");
      })
      .catch((error) => {
        setMessage(error instanceof Error ? error.message : "خطا در دریافت محتوا");
      });
  }, [apiUrl, runId]);

  const active = useMemo(
    () => data?.variants.find((variant) => variant.id === activeId) ?? null,
    [activeId, data],
  );

  const updateCanonical = (
    field: "title" | "body",
    value: string,
  ) => {
    setData((current) =>
      current
        ? {
            ...current,
            content: {
              ...current.content,
              [field]: value,
            },
          }
        : current,
    );
  };

  const updateVariant = (
    field: "title" | "body",
    value: string,
  ) => {
    if (!activeId) return;
    setData((current) =>
      current
        ? {
            ...current,
            variants: current.variants.map((variant) =>
              variant.id === activeId ? { ...variant, [field]: value } : variant,
            ),
          }
        : current,
    );
  };

  const saveCanonical = async () => {
    if (!data) return;
    setBusy(true);
    setMessage("در حال ذخیره...");

    try {
      const response = await fetch(`${apiUrl}/content/${data.content.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: data.content.title,
          body: data.content.body,
        }),
      });

      if (!response.ok) throw new Error(`Save failed (${response.status})`);
      setMessage("✓ پیش‌نویس ذخیره شد");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "ذخیره ناموفق بود");
    } finally {
      setBusy(false);
    }
  };

  const saveVariant = async () => {
    if (!active) return;
    setBusy(true);
    setMessage("در حال ذخیره نسخه کانال...");

    try {
      const response = await fetch(`${apiUrl}/content-variants/${active.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: active.title,
          body: active.body,
          hashtags: active.hashtags,
          settings: active.settings,
        }),
      });

      if (!response.ok) throw new Error(`Save failed (${response.status})`);
      setMessage(`✓ نسخه ${channelLabels[active.channel]} ذخیره شد`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "ذخیره نسخه ناموفق بود");
    } finally {
      setBusy(false);
    }
  };

  const sendForApproval = async () => {
    if (!active) return;
    setBusy(true);
    setMessage("در حال ارسال برای تأیید...");

    try {
      await saveVariant();

      const response = await fetch(
        `${apiUrl}/content-variants/${active.id}/approval`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reason:
              active.channel === "instagram"
                ? "بررسی نسخه شبکه اجتماعی قبل از انتشار"
                : "بررسی نهایی قبل از انتشار",
            agentRecommendation:
              "Agent پیشنهاد می‌کند این نسخه با یک بررسی کوتاه تأیید شود.",
          }),
        },
      );

      if (!response.ok) {
        throw new Error(`Approval failed (${response.status})`);
      }

      setData((current) =>
        current
          ? {
              ...current,
              variants: current.variants.map((variant) =>
                variant.id === active.id
                  ? { ...variant, status: "waiting_approval" }
                  : variant,
              ),
            }
          : current,
      );
      setMessage("✓ برای Approval ارسال شد");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "ارسال برای تأیید ناموفق بود");
    } finally {
      setBusy(false);
    }
  };

  const quickAction = (type: "shorter" | "formal" | "headline") => {
    if (!active) return;

    if (type === "shorter") {
      const shortened =
        active.body.length > 240
          ? `${active.body.slice(0, 237).trim()}...`
          : active.body;
      updateVariant("body", shortened);
      setMessage("کوتاه‌تر شد؛ برای ثبت، ذخیره کن");
      return;
    }

    if (type === "formal") {
      updateVariant(
        "body",
        active.body
          .replaceAll("می‌تونه", "می‌تواند")
          .replaceAll("می‌شه", "می‌شود")
          .replaceAll("خیلی", "بسیار"),
      );
      setMessage("لحن رسمی‌تر شد؛ برای ثبت، ذخیره کن");
      return;
    }

    updateVariant(
      "title",
      active.title?.startsWith("خبر مهم:")
        ? active.title
        : `خبر مهم: ${active.title ?? "خروجی جدید Workflow"}`,
    );
    setMessage("تیتر اصلاح شد؛ برای ثبت، ذخیره کن");
  };

  if (!data) {
    return (
      <main className="workflow-page">
        <header className="app-header">
          <div className="brand-lockup">
            <strong>SocialYar</strong>
            <span>استودیوی محتوا · خروجی Workflow</span>
          </div>
        </header>
        <div className="studio-loading">{message}</div>
      </main>
    );
  }

  return (
    <main className="workflow-page">
      <header className="app-header">
        <div className="brand-lockup">
          <strong>SocialYar</strong>
          <span>استودیوی محتوا · خروجی Workflow</span>
        </div>
        <div className="header-actions">
          <span className="save-status">{message}</span>
          <button className="ghost-button" onClick={saveCanonical} disabled={busy}>
            ذخیره پیش‌نویس
          </button>
          <button className="success-button" onClick={sendForApproval} disabled={busy || !active}>
            ارسال برای تأیید
          </button>
        </div>
      </header>

      <section className="studio-provenance">
        <div>
          <span className="micro-label">از اجرای جریان ساخته شده</span>
          <strong>
            Run #{runId.slice(0, 8)} · Workflow: {data.provenance.workflowName}
          </strong>
        </div>
        <Link className="ghost-link" href={`/runs/${runId}`}>
          ← بازگشت به اجرا
        </Link>
      </section>

      <section className="studio-layout">
        <div className="studio-main">
          <div className="studio-tabs">
            <button className="studio-tab active">نسخه نهایی</button>
            <button className="studio-tab">منبع اصلی</button>
            <button className="studio-tab">تصاویر</button>
            <button className="studio-tab">AI Actions</button>
          </div>

          <div className="content-editor-card">
            <input
              className="content-title-input"
              value={data.content.title ?? ""}
              onChange={(event) => updateCanonical("title", event.target.value)}
              placeholder="عنوان محتوا"
            />
            <textarea
              className="content-body-input"
              value={data.content.body}
              onChange={(event) => updateCanonical("body", event.target.value)}
            />

            <div className="content-source-row">
              <span>منبع: Workflow + Run provenance</span>
              <span>{data.variants.length} نسخه کانال</span>
            </div>
          </div>

          <div className="ai-actions-card">
            <h3>ویرایش سریع با AI</h3>
            <div className="quick-actions">
              <button onClick={() => quickAction("shorter")}>کوتاه‌تر</button>
              <button onClick={() => quickAction("formal")}>لحن رسمی‌تر</button>
              <button onClick={() => quickAction("headline")}>تیتر بهتر</button>
              <button onClick={saveVariant}>ذخیره نسخه فعال</button>
            </div>
            <p>هر تغییر روی همان Run و نسخه محتوای فعال ثبت می‌شود.</p>
          </div>
        </div>

        <aside className="studio-sidebar">
          <div className="studio-side-block">
            <h3>نسخه هر کانال</h3>
            <div className="channel-tabs">
              {data.variants.map((variant) => (
                <button
                  className={
                    variant.id === activeId
                      ? "channel-tab active"
                      : "channel-tab"
                  }
                  key={variant.id}
                  onClick={() => setActiveId(variant.id)}
                >
                  <span>{channelLabels[variant.channel]}</span>
                  <small>{variant.status}</small>
                </button>
              ))}
            </div>
          </div>

          {active ? (
            <>
              <div className="studio-side-block">
                <h3>تنظیمات خروجی</h3>
                <dl className="settings-list">
                  <div>
                    <dt>پلتفرم</dt>
                    <dd>{channelLabels[active.channel]}</dd>
                  </div>
                  <div>
                    <dt>لحن</dt>
                    <dd>{String(active.settings.tone ?? "auto")}</dd>
                  </div>
                  <div>
                    <dt>هشتگ</dt>
                    <dd>{active.hashtags.length || "خودکار"}</dd>
                  </div>
                  <div>
                    <dt>وضعیت</dt>
                    <dd>{active.status}</dd>
                  </div>
                </dl>
              </div>

              <div className="variant-editor">
                <input
                  value={active.title ?? ""}
                  onChange={(event) => updateVariant("title", event.target.value)}
                  placeholder="عنوان نسخه"
                />
                <textarea
                  value={active.body}
                  onChange={(event) => updateVariant("body", event.target.value)}
                />
                <input
                  value={active.hashtags.join(" ")}
                  onChange={(event) => {
                    const hashtags = event.target.value
                      .split(/\s+/)
                      .map((item) => item.trim())
                      .filter(Boolean);

                    setData((current) =>
                      current
                        ? {
                            ...current,
                            variants: current.variants.map((variant) =>
                              variant.id === active.id
                                ? { ...variant, hashtags }
                                : variant,
                            ),
                          }
                        : current,
                    );
                  }}
                  placeholder="#hashtag"
                />
              </div>
            </>
          ) : null}
        </aside>
      </section>
    </main>
  );
}
