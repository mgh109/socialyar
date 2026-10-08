"use client";
import { apiFetch, getWorkspaceId } from "../lib/session";
import { persianError } from "../lib/persian";

import { BrandLogo } from "./brand-logo";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";

type Channel = "telegram" | "website" | "instagram" | "x" | "linkedin" | "eitaa" | "youtube" | "bale";

type Account = {
  id: string;
  channel: Channel;
  externalAccountId: string;
  displayName: string | null;
  isActive: boolean;
  hasCredentials: boolean;
  credentialKeys: string[];
};

const channelMeta: Record<
  Channel,
  { label: string; description: string; native: boolean }
> = {
  youtube: { label: "یوتیوب", description: "اتصال کانال با ورود گوگل و دسترسی رسمی", native: true },
  bale: {label:"بله",description:"ارسال متن، تصویر و ویدئو با بازوی بله",native:true},
  eitaa: { label: "ایتا", description: "ارسال خبر به کانال با توکن ایتایار", native: true },
  telegram: {
    label: "تلگرام",
    description: "انتشار مستقیم با ربات رسمی تلگرام",
    native: true,
  },
  website: {
    label: "وب‌سایت",
    description: "انتشار از طریق اتصال وب‌سایت یا سامانه مدیریت محتوا",
    native: true,
  },
  instagram: {
    label: "اینستاگرام",
    description: "انتشار تصویر و Reels با دسترسی رسمی حساب حرفه‌ای",
    native: true,
  },
  x: {
    label: "ایکس",
    description: "ساختار اتصال آماده است؛ انتشار مستقیم هنوز فعال نیست",
    native: false,
  },
  linkedin: {
    label: "لینکدین",
    description: "ساختار اتصال آماده است؛ انتشار مستقیم هنوز فعال نیست",
    native: false,
  },
};

export function ConnectionsManager() {
  const workspaceId = getWorkspaceId();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [channel, setChannel] = useState<Channel>("telegram");
  const [displayName, setDisplayName] = useState("");
  const [externalAccountId, setExternalAccountId] = useState("");
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [instagramVersion,setInstagramVersion]=useState("");
  const [instagramLogin,setInstagramLogin]=useState("instagram");
  const [token, setToken] = useState("");
  const [fallbackWebhookUrl, setFallbackWebhookUrl] = useState("");
  const [message, setMessage] = useState("آماده اتصال");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    if (!workspaceId) {
      setMessage("ابتدا وارد حساب کاربری شوید");
      return;
    }

    const response = await apiFetch(
      `/social-accounts?workspaceId=${workspaceId}`,
    );
    if (!response.ok) throw new Error("Could not load connections");
    setAccounts(await response.json());
  };

  useEffect(() => {
    void load().catch((error) =>
      setMessage(persianError(error, "خطا در اتصال‌ها")),
    );
  }, [workspaceId]);

  const connectedChannels = useMemo(
    () => new Set(accounts.filter((account) => account.isActive).map((account) => account.channel)),
    [accounts],
  );

  const reset = () => {
    setDisplayName("");
    setExternalAccountId("");
    setBotToken("");
    setChatId("");
    setWebhookUrl("");
    setToken("");
    setFallbackWebhookUrl("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!workspaceId) return;

    const credentials: Record<string, string> = {};

    if (channel === "youtube") {
      setBusy(true);
      try { const response = await apiFetch("/youtube/connect", { method: "POST" }); const data = await response.json();
        if (!response.ok) throw new Error(data.message ?? data.error ?? "اتصال گوگل در سرور تنظیم نشده است"); window.location.assign(data.url);
      } catch (error) { setMessage(persianError(error, "خطای اتصال گوگل")); } finally { setBusy(false); }
      return;
    }
    if (channel === "telegram" || channel === "eitaa" || channel === "bale") {
      credentials.botToken = botToken;
      if (chatId) credentials.chatId = chatId;
    }

    if (channel === "instagram") {credentials.accessToken=token;credentials.apiVersion=instagramVersion;credentials.loginType=instagramLogin;}
    if (channel === "website") {
      credentials.webhookUrl = webhookUrl;
      if (token) credentials.token = token;
    }

    if (fallbackWebhookUrl) {
      credentials.fallbackWebhookUrl = fallbackWebhookUrl;
    }

    setBusy(true);
    setMessage("در حال ذخیره اتصال...");

    try {
      const response = await apiFetch(`/social-accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          channel,
          displayName: displayName || null,
          externalAccountId:
            externalAccountId ||
            (channel === "telegram" || channel === "eitaa" || channel === "bale" ? chatId : channel),
          credentials,
          isActive: true,
        }),
      });

      if (!response.ok) throw new Error(`Save failed (${response.status})`);

      await load();
      reset();
      setMessage("✓ اتصال ذخیره شد");
    } catch (error) {
      setMessage(persianError(error, "ذخیره اتصال ناموفق بود"));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (account: Account) => {
    setBusy(true);
    try {
      const response = await apiFetch(
        `/social-accounts/${account.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive: !account.isActive }),
        },
      );
      if (!response.ok) throw new Error("Toggle failed");
      await load();
      setMessage(account.isActive ? "اتصال غیرفعال شد" : "✓ اتصال فعال شد");
    } catch (error) {
      setMessage(persianError(error, "تغییر وضعیت ناموفق بود"));
    } finally {
      setBusy(false);
    }
  };

  const test = async (account: Account) => {
    setBusy(true);
    setMessage(`در حال تست ${channelMeta[account.channel].label}...`);
    try {
      const response = await apiFetch(
        account.channel === "youtube" ? `/youtube/accounts/${account.id}/test` : `/social-accounts/${account.id}/test`,
        { method: "POST" },
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message ?? data.error ?? "Connection test failed");
      }
      setMessage(`✓ اتصال ${channelMeta[account.channel].label} سالم است`);
    } catch (error) {
      setMessage(persianError(error, "تست اتصال ناموفق بود"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (account: Account) => {
    setBusy(true);
    try {
      const response = await apiFetch(
        account.channel === "youtube" ? `/youtube/accounts/${account.id}/disconnect` : `/social-accounts/${account.id}`,
        { method: account.channel === "youtube" ? "POST" : "DELETE" },
      );
      if (!response.ok && response.status !== 204) {
        throw new Error("Delete failed");
      }
      await load();
      setMessage("اتصال حذف شد");
    } catch (error) {
      setMessage(persianError(error, "حذف اتصال ناموفق بود"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="workflow-page">
      <header className="app-header">
        <div className="brand-lockup">
          <BrandLogo />
          <span>اتصال کانال‌ها</span>
        </div>
        <div className="header-actions">
          <span className="save-status">{message}</span>
          <Link className="ghost-link" href="/calendar">
            تقویم انتشار
          </Link>
        </div>
      </header>

      <section className="connections-shell">
        <div className="connections-main">
          <div className="approval-heading">
            <span className="micro-label">اتصال کانال‌ها</span>
            <h1>اکانت‌ها و مقصدهای انتشار</h1>
            <p>
              انتشار فقط با اتصال‌های فعال انجام می‌شود. اطلاعات محرمانه در این فهرست نمایش داده نمی‌شوند.
            </p>
          </div>

          <div className="connection-grid">
            {(Object.keys(channelMeta) as Channel[]).map((item) => (
              <article className="connection-channel-card" key={item}>
                <div>
                  <strong>{channelMeta[item].label}</strong>
                  <p>{channelMeta[item].description}</p>
                </div>
                <span className={connectedChannels.has(item) ? "connection-state online" : "connection-state"}>
                  {connectedChannels.has(item)
                    ? "● متصل"
                    : channelMeta[item].native
                      ? "○ آماده اتصال"
                      : "○ انتشار مستقیم فعال نیست"}
                </span>
              </article>
            ))}
          </div>

          <div className="connected-list">
            <h2>اتصال‌های ذخیره‌شده</h2>
            {accounts.length === 0 ? (
              <div className="empty-state">هنوز هیچ کانالی متصل نشده.</div>
            ) : (
              accounts.map((account) => (
                <article className="connected-account" key={account.id}>
                  <div className="connected-account-main">
                    <span className={account.isActive ? "live-dot online" : "live-dot"} />
                    <div>
                      <strong>
                        {account.displayName ||
                          channelMeta[account.channel].label}
                      </strong>
                      <small>
                        {channelMeta[account.channel].label} · {account.externalAccountId}
                      </small>
                      <small>
                        اطلاعات ورود: {account.hasCredentials ? "ذخیره شده" : "ثبت نشده"}
                      </small>
                    </div>
                  </div>

                  <div className="connected-account-actions">
                    <button
                      className="ghost-button"
                      onClick={() => test(account)}
                      disabled={busy || !channelMeta[account.channel].native}
                    >
                      تست اتصال
                    </button>
                    <button
                      className="ghost-button"
                      onClick={() => toggle(account)}
                      disabled={busy || account.channel === "youtube"}
                    >
                      {account.isActive ? "غیرفعال" : "فعال"}
                    </button>
                    <button
                      className="danger-button"
                      onClick={() => remove(account)}
                      disabled={busy}
                    >
                      {account.channel === "youtube" ? "قطع اتصال" : "حذف"}
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
        </div>

        <aside className="connection-form-panel">
          <button type="button" disabled={busy} onClick={async () => {
            setBusy(true); try { const r = await apiFetch("/youtube/health", { method: "POST" }); const data = await r.json();
              setMessage(data.checks ? data.checks.map((c: { service: string; reachable: boolean; error?: string }) => `${({ google: "گوگل", youtube: "یوتیوب", upload: "بارگذاری" } as Record<string,string>)[c.service] ?? "سرویس مقصد"}: ${c.reachable ? "در دسترس" : persianError(c.error, "قطع ارتباط")}`).join(" · ") : "بررسی شبکه ناموفق بود");
            } catch (e) { setMessage(persianError(e, "خطای بررسی شبکه")); } finally { setBusy(false); }
          }}>بررسی دسترسی سرور به گوگل و یوتیوب</button>
          <button type="button" disabled={busy} onClick={async () => {
            setBusy(true); try { const r = await apiFetch("/youtube/connect", { method: "POST" }); const data = await r.json();
              if (!r.ok) throw new Error(data.message ?? data.error); window.location.assign(data.url);
            } catch (e) { setMessage(persianError(e, "اتصال گوگل ناموفق بود")); } finally { setBusy(false); }
          }}>▶ اتصال یوتیوب با گوگل</button>
          <form className="connection-form" onSubmit={submit}>
            <h2>اتصال جدید</h2>

            <label>
              <span>کانال</span>
              <select
                value={channel}
                onChange={(event) => setChannel(event.target.value as Channel)}
              >
                {(Object.keys(channelMeta) as Channel[]).map((item) => (
                  <option key={item} value={item}>
                    {channelMeta[item].label}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>نام نمایشی</span>
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="مثلاً کانال اصلی هور+"
              />
            </label>

            <label>
              <span>شناسه حساب یا کانال مقصد</span>
              <input
                value={externalAccountId}
                onChange={(event) => setExternalAccountId(event.target.value)}
                placeholder={
                  channel === "telegram" || channel === "eitaa" || channel === "bale"
                    ? "نام کانال با @ یا شناسه گفت‌وگو"
                    : "شناسه مقصد"
                }
              />
            </label>

            {channel === "telegram" || channel === "eitaa" || channel === "bale" ? (
              <>
                <label>
                  <span>{channel === "eitaa" ? "توکن ایتایار" : channel === "bale" ? "توکن بازوی بله" : "توکن ربات تلگرام"}</span>
                  <input
                    type="password"
                    value={botToken}
                    onChange={(event) => setBotToken(event.target.value)}
                    required
                    autoComplete="new-password"
                  />
                </label>
                <label>
                  <span>شناسه گفت‌وگو یا کانال</span>
                  <input
                    value={chatId}
                    onChange={(event) => setChatId(event.target.value)}
                    placeholder="@channel"
                    required={channel === "eitaa"}
                  />
                </label>
              </>
            ) : null}

            {channel === "instagram" ? <>
              <p>حساب حرفه‌ای و توکن رسمی دارای مجوز انتشار لازم است؛ شناسه عددی حساب را در قسمت «شناسه مقصد» وارد کنید.</p>
              <label>توکن دسترسی رسمی<input type="password" required autoComplete="new-password" value={token} onChange={(e)=>setToken(e.target.value)} /></label>
              <label>نسخه API<input required dir="ltr" placeholder="v…" value={instagramVersion} onChange={(e)=>setInstagramVersion(e.target.value)} /></label>
              <label>نوع اتصال رسمی<select value={instagramLogin} onChange={(e)=>setInstagramLogin(e.target.value)}><option value="instagram">Instagram Login</option><option value="facebook">Facebook Login</option></select></label>
            </> : null}
            {channel === "website" ? (
              <>
                <label>
                  <span>آدرس اتصال وب‌سایت</span>
                  <input
                    type="url"
                    value={webhookUrl}
                    onChange={(event) => setWebhookUrl(event.target.value)}
                    required
                    placeholder="https://example.com/api/publish"
                  />
                </label>
                <label>
                  <span>توکن دسترسی (اختیاری)</span>
                  <input
                    type="password"
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    autoComplete="new-password"
                  />
                </label>
              </>
            ) : null}

            {!channelMeta[channel].native ? (
              <div className="connection-note">
                انتشار مستقیم این کانال هنوز فعال نشده است؛ در صورت داشتن سرویس انتشار مستقل، آدرس جایگزین آن را ثبت کنید.
              </div>
            ) : null}

            <label>
              <span>آدرس سرویس انتشار جایگزین (اختیاری)</span>
              <input
                type="url"
                value={fallbackWebhookUrl}
                onChange={(event) => setFallbackWebhookUrl(event.target.value)}
                placeholder="https://..."
              />
            </label>

            <button className="primary-button wide" disabled={busy}>
              ذخیره اتصال
            </button>
          </form>
        </aside>
      </section>
    </main>
  );
}
