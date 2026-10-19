"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { instagramAITypes, instagramSources } from "@socialyar/shared";
import { apiFetch } from "../lib/session";
import { ConnectionSelector } from "./connection-selector";
import { PersianDateTimeField } from "./persian-date-time-field";

type Config = Record<string, unknown>;
type Report = {
  runId: string;
  status: string;
  at: string;
  output: Config | null;
  error: { message?: string } | null;
  costMicros: number;
  inputTokens: number;
  outputTokens: number;
  model: string | null;
};
const statuses: Record<string, string> = {
  completed: "انجام شد",
  failed: "ناموفق",
  waiting_approval: "منتظر تأیید",
  running: "در حال اجرا",
  queued: "در صف",
  retrying: "تلاش مجدد",
};
export function InstagramCardPanel({
  type,
  config,
  update,
  accounts,
  profiles,
  workflowId,
  stepKey,
  busy,
  run,
}: {
  type: string;
  config: Config;
  update: (key: string, value: unknown) => void;
  accounts: Array<{
    id: string;
    channel: string;
    displayName: string | null;
    externalAccountId: string;
    isActive: boolean;
  }>;
  profiles: Array<{ id: string; name: string }>;
  workflowId: string | null;
  stepKey: string;
  busy: boolean;
  run: () => Promise<void>;
}) {
  const [tab, setTab] = useState<"settings" | "results">("settings"),
    [reports, setReports] = useState<Report[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const source = instagramSources.includes(type),
    ai =
      instagramAITypes.includes(type) &&
      (type !== "instagram_action" || config.action === "reply"),
    creative = [
      "instagram_ideas",
      "instagram_script",
      "instagram_content",
    ].includes(type),
    support = ["instagram_action", "instagram_inbox"].includes(type);
  const [names, setNames] = useState(
    Array.isArray(config.usernames) ? config.usernames.join("\n") : "",
  );
  useEffect(() => {
    if (tab !== "results" || !workflowId) return;
    let disposed = false;
    const load = async () => {
      setLoading(true);
      try {
        const response = await apiFetch(
          `/workflows/${workflowId}/instagram?stepKey=${encodeURIComponent(stepKey)}`,
        );
        if (!response.ok)
          throw new Error("گزارش دریافت نشد؛ دوباره تلاش کنید.");
        const data = await response.json();
        if (!disposed) {
          setReports(data);
          setError("");
        }
      } catch (e) {
        if (!disposed)
          setError(e instanceof Error ? e.message : "گزارش دریافت نشد.");
      } finally {
        if (!disposed) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 10000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [tab, workflowId, stepKey]);
  const text = (key: string, label: string, rows = 3) => (
    <label>
      {label}
      <textarea
        rows={rows}
        maxLength={
          key === "references" ? 12000 : key === "context" ? 6000 : 4000
        }
        value={String(config[key] ?? "")}
        onChange={(e) => update(key, e.target.value)}
      />
    </label>
  );
  const number = (
    key: string,
    label: string,
    min: number,
    max: number,
    fallback: number,
  ) => (
    <label>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        value={Number(config[key] ?? fallback)}
        onChange={(e) => update(key, Number(e.target.value))}
      />
    </label>
  );
  const profile = (key: string, label: string) => (
    <label>
      {label}
      <select
        value={String(config[key] ?? "default")}
        onChange={(e) => update(key, e.target.value)}
      >
        <option value="default">مدل پیش‌فرض</option>
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <section
      className="instagram-card-panel"
      aria-label="تنظیمات و نتایج اینستاگرام"
    >
      <div className="instagram-card-tabs" role="group" aria-label="نمای کارت">
        <button
          type="button"
          className={tab === "settings" ? "primary-button" : "ghost-button"}
          onClick={() => setTab("settings")}
        >
          تنظیمات
        </button>
        <button
          type="button"
          className={tab === "results" ? "primary-button" : "ghost-button"}
          onClick={() => setTab("results")}
        >
          نتایج و فعالیت
        </button>
      </div>
      {tab === "results" ? (
        <div aria-live="polite">
          {error ? <p role="alert">{error}</p> : null}
          {loading && !reports.length ? <p>در حال دریافت…</p> : null}
          {!reports.length && !loading ? (
            <p>هنوز خروجی ثبت نشده است. جریان را ذخیره و اجرا کنید.</p>
          ) : null}
          {reports.map((report) => (
            <InstagramResult key={report.runId} report={report} />
          ))}
        </div>
      ) : (
        <>
          {!creative ? (
            <>
              <label>
                حساب اینستاگرام
                {type === "instagram_trends" ? "؛ برای رصد خودکار" : ""}
                <select
                  value={String(config.accountId ?? "")}
                  onChange={(e) => update("accountId", e.target.value)}
                >
                  <option value="">انتخاب حساب</option>
                  {accounts
                    .filter((a) => a.channel === "instagram" && a.isActive)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.displayName ?? a.externalAccountId}
                      </option>
                    ))}
                </select>
              </label>
              <Link href="/connections">مدیریت اتصال‌ها</Link>
              {config.accountId ? (
                <ConnectionSelector
                  target="instagram"
                  value={config.connection}
                  onChange={(v) => update("connection", v)}
                />
              ) : null}
            </>
          ) : null}
          {[
            "instagram_comments",
            "instagram_analysis",
            "instagram_inbox",
            "instagram_trends",
          ].includes(type)
            ? number("batchLimit", "حداکثر تعداد در هر بررسی", 1, 50, 20)
            : null}
          {type === "instagram_comments" ? (
            <>
              <label>
                شناسه پست؛ خالی برای آخرین پست‌ها
                <input
                  dir="ltr"
                  value={String(config.mediaId ?? "")}
                  onChange={(e) => update("mediaId", e.target.value)}
                />
              </label>
              <div>
                کامنت‌های بعد از
                <PersianDateTimeField
                  value={config.after}
                  onChange={(v) => update("after", v)}
                />
              </div>
            </>
          ) : null}
          {type === "instagram_action" ? (
            <label>
              اقدام
              <select
                value={String(config.action ?? "reply")}
                onChange={(e) => update("action", e.target.value)}
              >
                <option value="reply">پیشنهاد و ارسال پاسخ</option>
                <option value="hide">مخفی‌کردن کامنت</option>
                <option value="review">ارجاع به مدیر</option>
              </select>
            </label>
          ) : null}
          {type === "instagram_analysis" ? (
            <>
              {number("days", "بازه تحلیل؛ روز", 7, 90, 28)}
              <p className="connection-note">
                آمار بازه و آمار تجمعی نمونه پست‌ها در گزارش جدا نمایش داده
                می‌شوند.
              </p>
            </>
          ) : null}
          {type === "instagram_inbox" ? (
            <>
              <label>
                روش پاسخ
                <select
                  value={String(config.mode ?? "draft")}
                  onChange={(e) => update("mode", e.target.value)}
                >
                  <option value="draft">فقط پیشنهاد پاسخ</option>
                  <option value="reply">پیشنهاد و ارسال پاسخ</option>
                </select>
              </label>
              <p className="connection-note">
                نیازمند Instagram Login و مجوز پیام‌ها؛ فقط آخرین پیام ورودی
                مکالمه بررسی می‌شود. پاسخ خودکار در مهلت ۲۴ ساعته انجام می‌شود.
              </p>
            </>
          ) : null}
          {support ? (
            <>
              {text("context", "دانش کسب‌وکار؛ پاسخ‌ها فقط از این اطلاعات", 5)}
              <label>
                تأیید اقدام
                <select
                  value={config.requireApproval === false ? "auto" : "review"}
                  onChange={(e) =>
                    update("requireApproval", e.target.value === "review")
                  }
                >
                  <option value="review">پس از تأیید من</option>
                  <option value="auto">خودکار</option>
                </select>
              </label>
              {number("dailyLimit", "سقف اقدام روزانه حساب", 1, 100, 20)}
              <Link href="/approvals">بررسی و ویرایش پاسخ‌های منتظر تأیید</Link>
            </>
          ) : null}
          {type === "instagram_trends" ? (
            <>
              {text("goal", "حوزه و موضوع موردنظر", 2)}
              {text("audience", "مخاطب هدف", 2)}
              <label>
                حساب‌های منتخب؛ هر نام در یک خط
                <textarea
                  dir="ltr"
                  rows={4}
                  value={names}
                  onChange={(e) => {
                    setNames(e.target.value);
                    update(
                      "usernames",
                      e.target.value
                        .split(/[\n،,]/)
                        .map((s) => s.trim().replace(/^@/, ""))
                        .filter(Boolean),
                    );
                  }}
                />
              </label>
              <small>
                حداکثر ۵ حساب حرفه‌ای؛ نیازمند Facebook Login و مجوز Business
                Discovery.
              </small>
              {text(
                "references",
                "نمونه‌ها و سوژه‌های دستی؛ متن و لینک منبع",
                5,
              )}
              <p className="connection-note">
                پوشش فقط منابع منتخب است. رشد تعامل با دو نمونه دارای حداقل یک
                ساعت فاصله محاسبه می‌شود؛ نمونه بدون سابقه «سوژه پیشنهادی» است.
              </p>
            </>
          ) : null}
          {creative ? (
            <>
              <label>
                قالب محتوا
                <select
                  value={String(config.format ?? "reel")}
                  onChange={(e) => update("format", e.target.value)}
                >
                  <option value="reel">ریلز</option>
                  <option value="carousel">پست اسلایدی</option>
                  <option value="story">استوری</option>
                  <option value="image">پست تصویری</option>
                </select>
              </label>
              {type !== "instagram_script" && (type === "instagram_ideas" || config.format === "carousel")
                ? number(
                    "count",
                    type === "instagram_ideas" ? "تعداد ایده" : "تعداد اسلاید",
                    config.format === "carousel" ? 2 : 1,
                    10,
                    3,
                  )
                : null}
              {type === "instagram_script"
                ? number("seconds", "مدت سناریو؛ ثانیه", 5, 180, 30)
                : null}
              <details>
                <summary>برند، مخاطب و امکانات تولید</summary>
                {text("brand", "معرفی برند و ویژگی‌های محصول")}
                {text("audience", "مخاطب هدف", 2)}
                {text("goal", "هدف محتوا", 2)}
                <label>
                  لحن
                  <input
                    value={String(config.tone ?? "")}
                    onChange={(e) => update("tone", e.target.value)}
                  />
                </label>
                <label>
                  حضور چهره
                  <select
                    value={config.face ? "yes" : "no"}
                    onChange={(e) => update("face", e.target.value === "yes")}
                  >
                    <option value="no">بدون چهره</option>
                    <option value="yes">با چهره</option>
                  </select>
                </label>
                <label>
                  امکانات
                  <select
                    value={String(config.production ?? "existing")}
                    onChange={(e) => update("production", e.target.value)}
                  >
                    <option value="existing">فقط فایل‌های موجود</option>
                    <option value="filming">امکان فیلم‌برداری داریم</option>
                  </select>
                </label>
                <label>
                  بودجه تولید
                  <input
                    value={String(config.budget ?? "کم")}
                    onChange={(e) => update("budget", e.target.value)}
                  />
                </label>
              </details>
            </>
          ) : null}
          {ai ? (
            <>
              {profile("profileId", "مدل متن")}
              {text("instructions", "راهنمای اختصاصی این کارت")}
            </>
          ) : null}
          {type === "instagram_content" ? (
            <>
              <label>
                ساخت رسانه
                <select
                  value={config.generateImage ? "image" : "text"}
                  onChange={(e) =>
                    update("generateImage", e.target.value === "image")
                  }
                >
                  <option value="text">کپشن و متن اسلایدها</option>
                  <option value="image">
                    متن به همراه کاور یا تصاویر اسلایدها
                  </option>
                </select>
              </label>
              {config.generateImage ? (
                <>
                  {profile("imageProfileId", "مدل تولید تصویر")}
                  {number("dailyLimit", "سقف تصویر روزانه", 1, 100, 10)}
                  {number(
                    "estimatedCostMicros",
                    "برآورد هزینه هر تصویر؛ میکرودلار",
                    1,
                    10000000,
                    100000,
                  )}
                  <small>
                    هر اسلاید یک تصویر و هزینه جدا دارد؛ پیش‌نمایش را قبل از
                    انتشار بررسی کنید.
                  </small>
                </>
              ) : null}
              <p className="connection-note">
                برای ریلز، سناریو و کاور آماده می‌شود؛ فایل ویدئو را از منبع یا
                کارت انتشار اضافه کنید.
              </p>
            </>
          ) : null}
          {source &&
          ["instagram_analysis", "instagram_trends"].includes(type) ? (
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => void run()}
            >
              ذخیره و اجرای بررسی
            </button>
          ) : null}
          {source &&
          ["instagram_comments", "instagram_inbox"].includes(type) ? (
            <small>
              پس از اتصال کارت‌ها، جریان را فعال کنید؛ پیام‌های جدید در نتایج
              همین کارت ثبت می‌شوند.
            </small>
          ) : null}
        </>
      )}
    </section>
  );
}
function InstagramResult({ report }: { report: Report }) {
  const output = report.output ?? {},
    trends = output.trends as
      | {
          coverage?: string;
          items?: Array<{
            id: string;
            url: string;
            caption: string;
            label: string;
            growthPerHour: number | null;
            source: string;
            timestamp: string;
          }>;
        }
      | undefined;
  const images = Array.isArray(output.images)
    ? (output.images as Array<{ url: string }>)
    : [];
  const warnings =
    (output.instagramAnalysis as { warnings?: string[] } | undefined)
      ?.warnings ?? [];
  return (
    <article className="instagram-result">
      <div className="instagram-result-meta">
        <strong>{statuses[report.status] ?? "در حال بررسی"}</strong>
        <time>
          {new Date(report.at).toLocaleString("fa-IR", {
            timeZone: "Asia/Tehran",
          })}
        </time>
      </div>
      {report.error?.message ? (
        <p role="alert">{report.error.message}</p>
      ) : null}
      {output.title ? <h4>{String(output.title)}</h4> : null}
      {trends ? (
        <>
          <small>{trends.coverage}</small>
          {trends.items?.map((i) => (
            <div className="instagram-trend" key={i.id}>
              <strong>
                {i.label} · {i.source}
              </strong>
              <p>{i.caption}</p>
              {i.growthPerHour !== null ? (
                <small>
                  رشد تعامل در ساعت: {i.growthPerHour.toLocaleString("fa-IR")}
                </small>
              ) : null}
              {/^https:\/\/(www\.)?instagram\.com\//.test(i.url) ? (
                <a href={i.url} target="_blank" rel="noreferrer">
                  مشاهده منبع
                </a>
              ) : null}
            </div>
          ))}
        </>
      ) : null}
      {!trends && output.text ? (
        <p className="instagram-result-text">{String(output.text)}</p>
      ) : null}
      {output.reply ? (
        <>
          <strong>پاسخ پیشنهادی</strong>
          <p>{String(output.reply)}</p>
        </>
      ) : null}
      {output.actionStatus ? (
        <strong>
          {(
            {
              draft: "پاسخ پیشنهادی؛ ارسال نشده",
              succeeded: "اقدام در اینستاگرام تأیید شد",
              duplicate_skipped: "قبلاً انجام شده؛ تکرار نشد",
              referred: "نیازمند بررسی مدیر",
            } as Record<string, string>
          )[String(output.actionStatus)] ?? "در حال بررسی"}
        </strong>
      ) : null}
      {output.reason ? <small>{String(output.reason)}</small> : null}
      {output.productionStatus ? (
        <p>{String(output.productionStatus)}</p>
      ) : null}
      {images.length ? (
        <div className="instagram-result-images">
          {images.map((i, index) => (
            <a key={index} href={i.url} target="_blank" rel="noreferrer">
              <img
                src={i.url}
                alt={`خروجی ${(index + 1).toLocaleString("fa-IR")}`}
                loading="lazy"
              />
            </a>
          ))}
        </div>
      ) : null}
      {output.creative ? (
        <details>
          <summary>جزئیات ایده، سناریو یا بسته محتوا</summary>
          <CreativeDetails value={output.creative} />
        </details>
      ) : null}
      {warnings.map((w) => (
        <small key={w}>{w}</small>
      ))}
      {report.model ? (
        <small>
          {report.model} ·{" "}
          {(report.inputTokens + report.outputTokens).toLocaleString("fa-IR")}{" "}
          توکن · {(report.costMicros / 1000000).toLocaleString("fa-IR")} دلار
          هزینه گزارش‌شده متن
        </small>
      ) : null}
      <Link href={`/runs/${report.runId}`}>گزارش کامل اجرا</Link>
      {report.status === "waiting_approval" ? (
        <Link href="/approvals">بررسی و تأیید</Link>
      ) : null}
    </article>
  );
}
const labels: Record<string, string> = {
  summary: "خلاصه",
  ideas: "ایده‌ها",
  title: "عنوان",
  hook: "شروع",
  angle: "زاویه",
  format: "قالب",
  goal: "هدف",
  effort: "امکانات تولید",
  sourceIds: "شناسه منابع",
  scenes: "صحنه‌ها",
  start: "از ثانیه",
  end: "تا ثانیه",
  visual: "تصویر",
  voice: "گوینده",
  overlay: "متن تصویر",
  cta: "دعوت به اقدام",
  requirements: "نیازمندی‌ها",
  caption: "کپشن",
  coverPrompt: "شرح کاور",
  slides: "اسلایدها",
  heading: "عنوان اسلاید",
  body: "متن اسلاید",
  checklist: "بررسی پیش از انتشار",
  actions: "اقدام‌ها",
  evidence: "شاهد",
  metric: "معیار سنجش",
};
function CreativeDetails({ value }: { value: unknown }) {
  if (Array.isArray(value))
    return (
      <div>
        {value.map((v, i) => (
          <div className="instagram-detail" key={i}>
            <CreativeDetails value={v} />
          </div>
        ))}
      </div>
    );
  if (value && typeof value === "object")
    return (
      <dl>
        {Object.entries(value).map(([k, v]) => (
          <div key={k}>
            <dt>{labels[k] ?? k}</dt>
            <dd>
              <CreativeDetails value={v} />
            </dd>
          </div>
        ))}
      </dl>
    );
  return <span>{String(value ?? "")}</span>;
}
