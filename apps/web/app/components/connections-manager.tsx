"use client";

import { getWorkspaceId } from "../lib/session";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";

type Channel = "telegram" | "website" | "instagram" | "x" | "linkedin";

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
  telegram: {
    label: "Telegram",
    description: "انتشار مستقیم با Telegram Bot API",
    native: true,
  },
  website: {
    label: "Website",
    description: "انتشار از طریق Webhook سایت یا CMS",
    native: true,
  },
  instagram: {
    label: "Instagram",
    description: "ساختار اتصال آماده؛ Native adapter در مرحله بعد",
    native: false,
  },
  x: {
    label: "X",
    description: "ساختار اتصال آماده؛ Native adapter در مرحله بعد",
    native: false,
  },
  linkedin: {
    label: "LinkedIn",
    description: "ساختار اتصال آماده؛ Native adapter در مرحله بعد",
    native: false,
  },
};

export function ConnectionsManager() {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const workspaceId = process.env.NEXT_PUBLIC_WORKSPACE_ID ?? "";
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [channel, setChannel] = useState<Channel>("telegram");
  const [displayName, setDisplayName] = useState("");
  const [externalAccountId, setExternalAccountId] = useState("");
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [token, setToken] = useState("");
  const [fallbackWebhookUrl, setFallbackWebhookUrl] = useState("");
  const [message, setMessage] = useState("آماده اتصال");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    if (!workspaceId) {
      setMessage("NEXT_PUBLIC_WORKSPACE_ID تنظیم نشده");
      return;
    }

    const response = await fetch(
      `${apiUrl}/social-accounts?workspaceId=${workspaceId}`,
    );
    if (!response.ok) throw new Error("Could not load connections");
    setAccounts(await response.json());
  };

  useEffect(() => {
    void load().catch((error) =>
      setMessage(error instanceof Error ? error.message : "خطا در اتصال‌ها"),
    );
  }, [apiUrl, workspaceId]);

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

    if (channel === "telegram") {
      credentials.botToken = botToken;
      if (chatId) credentials.chatId = chatId;
    }

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
      const response = await fetch(`${apiUrl}/social-accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          channel,
          displayName: displayName || null,
          externalAccountId:
            externalAccountId ||
            (channel === "telegram" ? chatId : channel),
          credentials,
          isActive: true,
        }),
      });

      if (!response.ok) throw new Error(`Save failed (${response.status})`);

      await load();
      reset();
      setMessage("✓ اتصال ذخیره شد");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "ذخیره اتصال ناموفق بود");
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (account: Account) => {
    setBusy(true);
    try {
      const response = await fetch(
        `${apiUrl}/social-accounts/${account.id}`,
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
      setMessage(error instanceof Error ? error.message : "تغییر وضعیت ناموفق بود");
    } finally {
      setBusy(false);
    }
  };

  const test = async (account: Account) => {
    setBusy(true);
    setMessage(`در حال تست ${channelMeta[account.channel].label}...`);
    try {
      const response = await fetch(
        `${apiUrl}/social-accounts/${account.id}/test`,
        { method: "POST" },
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message ?? data.error ?? "Connection test failed");
      }
      setMessage(`✓ اتصال ${channelMeta[account.channel].label} سالم است`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "تست اتصال ناموفق بود");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (account: Account) => {
    setBusy(true);
    try {
      const response = await fetch(
        `${apiUrl}/social-accounts/${account.id}`,
        { method: "DELETE" },
      );
      if (!response.ok && response.status !== 204) {
        throw new Error("Delete failed");
      }
      await load();
      setMessage("اتصال حذف شد");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "حذف اتصال ناموفق بود");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="workflow-page">
      <header className="app-header">
        <div className="brand-lockup">
          <strong>SocialYar</strong>
          <span>Connections</span>
        </div>
        <div className="header-actions">
          <span className="save-status">{message}</span>
          <Link className="ghost-link" href="/calendar">
            Calendar / Publish
          </Link>
        </div>
      </header>

      <section className="connections-shell">
        <div className="connections-main">
          <div className="approval-heading">
            <span className="micro-label">اتصال کانال‌ها</span>
            <h1>اکانت‌ها و مقصدهای انتشار</h1>
            <p>
              Publisher فقط از اتصال‌های فعال استفاده می‌کند. اطلاعات محرمانه در لیست برگردانده نمی‌شوند.
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
                      : "○ Adapter آماده"}
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
                        Credentials: {account.credentialKeys.join(", ") || "none"}
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
                      disabled={busy}
                    >
                      {account.isActive ? "غیرفعال" : "فعال"}
                    </button>
                    <button
                      className="danger-button"
                      onClick={() => remove(account)}
                      disabled={busy}
                    >
                      حذف
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
        </div>

        <aside className="connection-form-panel">
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
                placeholder="مثلاً کانال اصلی SocialYar"
              />
            </label>

            <label>
              <span>External Account ID</span>
              <input
                value={externalAccountId}
                onChange={(event) => setExternalAccountId(event.target.value)}
                placeholder={
                  channel === "telegram"
                    ? "@channel یا chat id"
                    : "شناسه مقصد"
                }
              />
            </label>

            {channel === "telegram" ? (
              <>
                <label>
                  <span>Bot Token</span>
                  <input
                    type="password"
                    value={botToken}
                    onChange={(event) => setBotToken(event.target.value)}
                    required
                    autoComplete="new-password"
                  />
                </label>
                <label>
                  <span>Chat ID</span>
                  <input
                    value={chatId}
                    onChange={(event) => setChatId(event.target.value)}
                    placeholder="@channel"
                  />
                </label>
              </>
            ) : null}

            {channel === "website" ? (
              <>
                <label>
                  <span>Webhook URL</span>
                  <input
                    type="url"
                    value={webhookUrl}
                    onChange={(event) => setWebhookUrl(event.target.value)}
                    required
                    placeholder="https://example.com/api/publish"
                  />
                </label>
                <label>
                  <span>Bearer Token (اختیاری)</span>
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
                Native API این کانال هنوز فعال نشده؛ می‌توانی فعلاً Fallback Webhook ثبت کنی.
              </div>
            ) : null}

            <label>
              <span>Fallback Webhook (اختیاری)</span>
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
