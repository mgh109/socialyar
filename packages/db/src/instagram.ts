import { and, eq, sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { getDb } from "./client";
import { socialAccounts, workflows, instagramActions as actions } from "./schema";
import { decryptSecret } from "./secrets";
import { withExecutionLock } from "./execution-lock";
import { assertWorkspaceOperational } from "./tenant-policy";
import type { TrendSample } from "@socialyar/shared";

export async function ensureInstagramStorage(db = getDb()) {
  await db.execute(
    sql`CREATE TABLE IF NOT EXISTS instagram_actions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,account_id uuid NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,run_id uuid REFERENCES runs(id) ON DELETE SET NULL,kind text NOT NULL,target_id text NOT NULL,status text NOT NULL,external_id text,day text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),CONSTRAINT instagram_actions_once UNIQUE(account_id,kind,target_id))`,
  );
}
export type InstagramConnection = {
  id: string;
  externalId: string;
  token: string;
  version: string;
  loginType: string;
};
export async function instagramConnection(
  workspaceId: string,
  accountId: string,
  db = getDb(),
): Promise<InstagramConnection> {
  const [account] = await db
    .select()
    .from(socialAccounts)
    .where(
      and(
        eq(socialAccounts.id, accountId),
        eq(socialAccounts.workspaceId, workspaceId),
        eq(socialAccounts.channel, "instagram"),
        eq(socialAccounts.isActive, true),
      ),
    );
  if (!account || typeof account.credentials.accessTokenEnc !== "string")
    throw new Error("اتصال فعال اینستاگرام در این فضای کاری پیدا نشد.");
  const version = String(account.credentials.apiVersion);
  if (!/^v\d+\.\d+$/.test(version) || !/^\d+$/.test(account.externalAccountId))
    throw new Error("شناسه یا نسخه اتصال اینستاگرام معتبر نیست.");
  return {
    id: account.id,
    externalId: account.externalAccountId,
    token: decryptSecret(account.credentials.accessTokenEnc),
    version,
    loginType:
      account.credentials.loginType === "facebook" ? "facebook" : "instagram",
  };
}
export function instagramClient(
  connection: InstagramConnection,
  request: typeof fetch = fetch,
) {
  const origin =
    connection.loginType === "facebook"
      ? "https://graph.facebook.com"
      : "https://graph.instagram.com";
  return async (
    path: string,
    params: Record<string, string> = {},
    body?: Record<string, unknown>,
  ): Promise<any> => {
    if (
      path.length > 2048 ||
      path.split("/").some((p) => !p || !/^[A-Za-z0-9_+=:-]+$/.test(p))
    )
      throw new Error("مسیر اینستاگرام معتبر نیست.");
    let response: Response;
    try {
      response = await request(
        `${origin}/${connection.version}/${path.split("/").map(encodeURIComponent).join("/")}?${new URLSearchParams(params)}`,
        {
          method: body ? "POST" : "GET",
          headers: {
            Authorization: `Bearer ${connection.token}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(20000),
        },
      );
    } catch {
      throw new Error(
        body
          ? "نتیجه ارسال اینستاگرام نامشخص است؛ مقصد را بررسی کنید."
          : "ارتباط با اینستاگرام برقرار نشد؛ اتصال را بررسی کنید.",
      );
    }
    let data: any;
    try {
      data = await response.json();
    } catch {
      throw new Error(
        "پاسخ اینستاگرام قابل خواندن نیست؛ گزارش مقصد را بررسی کنید.",
      );
    }
    if (!response.ok || data?.error)
      throw new Error(
        `درخواست اینستاگرام ناموفق بود (کد ${response.status}، خطای ${Number(data?.error?.code) || 0})؛ مجوز حساب و نسخه API را بررسی کنید.`,
      );
    if (!data || typeof data !== "object")
      throw new Error("پاسخ اینستاگرام معتبر نیست.");
    return data;
  };
}
const fieldList =
  "id,caption,media_type,permalink,timestamp,like_count,comments_count";
const sample = (m: any, source: string): TrendSample => ({
  id: String(m.id),
  url: typeof m.permalink === "string" ? m.permalink : "",
  caption: String(m.caption ?? "").slice(0, 2500),
  timestamp: String(m.timestamp ?? ""),
  likes: typeof m.like_count === "number" ? m.like_count : null,
  comments: typeof m.comments_count === "number" ? m.comments_count : null,
  source,
});
export async function readInstagramComments(
  c: InstagramConnection,
  config: Record<string, unknown>,
  request: typeof fetch = fetch,
) {
  const api = instagramClient(c, request),
    limit = Number(config.batchLimit ?? 20);
  const media = config.mediaId
    ? [await api(String(config.mediaId), { fields: "id,owner,permalink" })]
    : ((
        await api(`${c.externalId}/media`, {
          fields: "id,permalink",
          limit: "10",
        })
      ).data ?? []);
  const items: Array<{
    id: string;
    text: string;
    mediaId: string;
    url: string;
    timestamp: string;
  }> = [];
  let scanned = 0;
  for (const m of media) {
    if (config.mediaId && String(m.owner?.id ?? m.owner) !== c.externalId)
      throw new Error("پست متعلق به حساب انتخاب‌شده نیست.");
    let after = "";
    for (let page = 0; page < 3 && items.length < limit; page++) {
      const response = await api(`${m.id}/comments`, {
        fields: "id,text,timestamp,from,username",
        limit: String(Math.min(50, limit - items.length)),
        ...(after ? { after } : {}),
      });
      for (const item of response.data ?? []) {
        scanned++;
        if (
          !item.id ||
          !item.text ||
          String(item.from?.id) === c.externalId ||
          (config.after &&
            Date.parse(item.timestamp) < Date.parse(String(config.after)))
        )
          continue;
        items.push({
          id: String(item.id),
          text: String(item.text).slice(0, 5000),
          mediaId: String(m.id),
          url: String(m.permalink ?? ""),
          timestamp: String(item.timestamp ?? ""),
        });
        if (items.length >= limit) break;
      }
      after = response.paging?.cursors?.after ?? "";
      if (!response.paging?.next || !after) break;
    }
    if (items.length >= limit) break;
  }
  return { items, scanned, sampledMedia: media.length };
}
export async function readInstagramInbox(
  c: InstagramConnection,
  limit: number,
  request: typeof fetch = fetch,
) {
  if (c.loginType !== "instagram")
    throw new Error("دایرکت در این نسخه به اتصال Instagram Login نیاز دارد.");
  const api = instagramClient(c, request),
    result = await api(`${c.externalId}/conversations`, {
      platform: "instagram",
      fields: "id",
      limit: String(Math.min(limit, 20)),
    });
  const items: Array<{
    id: string;
    text: string;
    conversationId: string;
    senderId: string;
    timestamp: string;
  }> = [];
  for (const conversation of result.data ?? []) {
    const data = await api(`${conversation.id}/messages`, {
      fields: "id,message,from,created_time",
      limit: "20",
    });
    const messages = (data.data ?? []).sort(
      (a: any, b: any) =>
        Date.parse(b.created_time) - Date.parse(a.created_time),
    );
    const latest = messages[0];
    if (
      !latest?.message ||
      !latest.from?.id ||
      String(latest.from.id) === c.externalId
    )
      continue;
    items.push({
      id: String(latest.id),
      text: String(latest.message).slice(0, 5000),
      conversationId: String(conversation.id),
      senderId: String(latest.from.id),
      timestamp: String(latest.created_time),
    });
    if (items.length >= limit) break;
  }
  return items;
}
export async function readInstagramAnalysis(
  c: InstagramConnection,
  config: Record<string, unknown>,
  request: typeof fetch = fetch,
) {
  const api = instagramClient(c, request),
    now = new Date(),
    since = Math.floor(
      (now.getTime() - Number(config.days ?? 28) * 86400000) / 1000,
    ),
    until = Math.floor(now.getTime() / 1000),
    warnings: string[] = [];
  const profile = await api(c.externalId, {
    fields: "id,username,followers_count,media_count",
  });
  const media = await api(`${c.externalId}/media`, {
    fields: fieldList,
    limit: String(config.batchLimit ?? 20),
  });
  let insights: any = null;
  try {
    insights = (
      await api(`${c.externalId}/insights`, {
        metric: "reach",
        period: "day",
        since: String(since),
        until: String(until),
      })
    ).data;
  } catch {
    warnings.push(
      "آمار دسترسی بازه دریافت نشد؛ مجوز Insights و نسخه API را بررسی کنید.",
    );
  }
  const mediaInsights = await Promise.all((media.data ?? []).slice(0, 10).map(async (m: {id:string}) => {
    try {
      const result = await api(`${m.id}/insights`, {metric:"views,reach,saved,shares,total_interactions"});
      return {mediaId:m.id,metrics:result.data ?? null};
    } catch {
      return {mediaId:m.id,metrics:null};
    }
  }));
  if (mediaInsights.some(item => item.metrics === null)) warnings.push("بخشی از آمار بازدید، ذخیره و اشتراک‌گذاری در دسترس نیست؛ داده ناموجود صفر در نظر گرفته نمی‌شود.");
  warnings.push(
    "آمار پست‌ها تجمعی و مربوط به نمونه آخرین محتواهاست؛ رشد بازه، کل پیج یا بهترین زمان انتشار از این نمونه اثبات نمی‌شود.",
  );
  return {
    generatedAt: now.toISOString(),
    days: config.days,
    profile,
    insights,
    mediaInsights,
    items: (media.data ?? []).map((m: any) =>
      sample(m, profile.username ?? c.externalId),
    ),
    warnings,
  };
}
export async function readInstagramTrends(
  c: InstagramConnection,
  usernames: string[],
  limit: number,
  request: typeof fetch = fetch,
) {
  if (c.loginType !== "facebook")
    throw new Error(
      "رصد حساب‌های منتخب به اتصال Facebook Login و مجوز Business Discovery نیاز دارد؛ یا نمونه‌ها را دستی وارد کنید.",
    );
  const api = instagramClient(c, request);
  const items: TrendSample[] = [];
  for (const username of usernames) {
    if (!/^[A-Za-z0-9_.]{1,30}$/.test(username))
      throw new Error("نام حساب رصد معتبر نیست.");
    const result = await api(c.externalId, {
      fields: `business_discovery.username(${username}){username,media.limit(${Math.min(limit, 20)}){${fieldList}}}`,
    });
    for (const media of result.business_discovery?.media?.data ?? [])
      items.push(sample(media, username));
  }
  return items;
}
export function assertInstagramMessageWindow(
  timestamp: string,
  now = new Date(),
) {
  const age = now.getTime() - Date.parse(timestamp);
  if (!Number.isFinite(age) || age < 0 || age >= 86400000)
    throw new Error(
      "مهلت پاسخ خودکار این پیام گذشته است؛ مکالمه را دستی بررسی کنید.",
    );
}
export async function sendInstagramAction(
  input: {
    workspaceId: string;
    workflowId: string;
    runId: string;
    accountId: string;
    kind: "reply" | "hide" | "message";
    targetId: string;
    mediaId?: string;
    conversationId?: string;
    senderId?: string;
    timestamp?: string;
    reply?: string;
    dailyLimit: number;
  },
  assertOwned: () => Promise<void>,
  db = getDb(),
  request: typeof fetch = fetch,
  lock: typeof withExecutionLock = withExecutionLock,
) {
  await ensureInstagramStorage(db);
  return lock(
    `instagram-send:${input.accountId}`,
    async (assertActionOwned) => {
      const allowed = async () => {
        await assertOwned();
        await assertActionOwned();
        await assertWorkspaceOperational(db, input.workspaceId);
        const [workflow] = await db
          .select()
          .from(workflows)
          .where(
            and(
              eq(workflows.id, input.workflowId),
              eq(workflows.workspaceId, input.workspaceId),
            ),
          );
        if (workflow?.status !== "active")
          throw new Error("جریان متوقف است؛ ارسال انجام نشد.");
      };
      await allowed();
      const c = await instagramConnection(
          input.workspaceId,
          input.accountId,
          db,
        ),
        api = instagramClient(c, request);
      const [previous] = await db
        .select()
        .from(actions)
        .where(
          and(
            eq(actions.accountId, input.accountId),
            eq(actions.kind, input.kind),
            eq(actions.targetId, input.targetId),
          ),
        );
      if (previous) {
        if (previous.status === "succeeded")
          return {
            actionStatus: "duplicate_skipped",
            externalId: previous.externalId,
          };
        throw new Error(
          "نتیجه اقدام قبلی نامشخص است؛ پیش از ارسال دوباره مقصد را بررسی کنید.",
        );
      }
      if (input.kind === "message") {
        if (
          c.loginType !== "instagram" ||
          !input.conversationId ||
          !input.senderId
        )
          throw new Error("زمینه مکالمه اینستاگرام کامل نیست.");
        const conversation = await api(`${input.conversationId}/messages`, {
          fields: "id,from,created_time",
          limit: "20",
        });
        const messages = conversation.data ?? [],
          message = messages.find(
            (m: any) =>
              String(m.id) === input.targetId &&
              String(m.from?.id) === input.senderId,
          );
        if (
          !message ||
          !messages.some((m: any) => String(m.from?.id) === c.externalId)
        ) {
          const participants = await api(input.conversationId, {
            fields: "participants",
          });
          if (
            !message ||
            !participants.participants?.data?.some(
              (p: any) => String(p.id) === c.externalId,
            )
          )
            throw new Error("مالکیت مکالمه یا پیام تأیید نشد.");
        }
        const latest = messages.sort(
          (a: any, b: any) =>
            Date.parse(b.created_time) - Date.parse(a.created_time),
        )[0];
        if (String(latest?.id) !== input.targetId)
          throw new Error(
            "مکالمه پیام جدیدتری دارد؛ پاسخ پیشنهادی را دوباره بررسی کنید.",
          );
        assertInstagramMessageWindow(message.created_time);
      } else {
        if (!input.mediaId) throw new Error("شناسه پست کامنت موجود نیست.");
        const media = await api(input.mediaId, { fields: "owner" });
        if (String(media.owner?.id ?? media.owner) !== c.externalId)
          throw new Error("پست متعلق به حساب انتخاب‌شده نیست.");
        const comment = await api(input.targetId, { fields: "id,media" });
        if (String(comment.media?.id ?? comment.media) !== input.mediaId)
          throw new Error("کامنت متعلق به پست انتخاب‌شده نیست.");
      }
      if (
        input.kind !== "hide" &&
        (!input.reply?.trim() ||
          new TextEncoder().encode(input.reply).length > 1000)
      )
        throw new Error("پاسخ باید کوتاه، غیرخالی و حداکثر ۱۰۰۰ بایت باشد.");
      const day = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Tehran",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
      const sent = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(actions)
        .where(
          and(eq(actions.accountId, input.accountId), eq(actions.day, day)),
        );
      if (Number(sent[0]?.count) >= input.dailyLimit)
        throw new Error("سقف اقدام روزانه این حساب پر شده است.");
      await allowed();
      const [claim] = await db
        .insert(actions)
        .values({ ...input, day, status: "pending" })
        .onConflictDoNothing()
        .returning();
      if (!claim) throw new Error("این اقدام قبلاً ثبت شده است.");
      try {
        await allowed();
        const data =
          input.kind === "hide"
            ? await api(input.targetId, {}, { hide: true })
            : input.kind === "reply"
              ? await api(
                  `${input.targetId}/replies`,
                  {},
                  { message: input.reply },
                )
              : await api(
                  `${c.externalId}/messages`,
                  {},
                  {
                    recipient: { id: input.senderId },
                    message: { text: input.reply },
                  },
                );
        const externalId = data.id ?? data.message_id;
        if (input.kind === "hide" ? data.success !== true : !externalId)
          throw new Error("نتیجه اقدام تأیید نشد؛ مقصد را بررسی کنید.");
        await db
          .update(actions)
          .set({
            status: "succeeded",
            externalId: externalId ? String(externalId) : null,
            updatedAt: new Date(),
          })
          .where(eq(actions.id, claim.id));
        return { actionStatus: "succeeded", externalId };
      } catch (e) {
        await db
          .update(actions)
          .set({ status: "uncertain", updatedAt: new Date() })
          .where(eq(actions.id, claim.id));
        throw e;
      }
    },
  );
}
