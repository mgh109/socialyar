import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@socialyar/db/schema";
import { getDb } from "@socialyar/db";
import { analyticsRoutes } from "./routes/analytics";
import { enforceAccess } from "./access";
import { connection } from "./queue";
const engine = new PGlite(),
  db = drizzle(engine, { schema }),
  database = db as unknown as ReturnType<typeof getDb>,
  app = Fastify();
const userId = randomUUID(),
  workspaceId = randomUUID(),
  foreignWorkspace = randomUUID();
const workflowId = randomUUID(),
  versionId = randomUUID(),
  replyStepId = randomUUID(),
  accountId = randomUUID();
const otherWorkflow = randomUUID(),
  otherVersion = randomUUID(),
  otherStep = randomUUID(),
  otherAccount = randomUUID();
const foreignWorkflow = randomUUID(),
  foreignVersion = randomUUID(),
  foreignStep = randomUUID(),
  foreignAccount = randomUUID();
const date = (day: number) =>
  new Date(`2026-10-${String(day).padStart(2, "0")}T10:00:00Z`);
before(async () => {
  connection.disconnect();
  for (const name of [
    "0000_initial.sql",
    "0001_auth.sql",
    "0002_eitaa_automation.sql",
    "0006_youtube.sql",
    "0007_publishing_proxies.sql",
    "0008_publication_calendar.sql",
    "0011_execution_recovery.sql",
    "0012_tenant_access.sql",
    "0013_youtube_comments.sql",
    "0014_image_generation.sql",
  ])
    await engine.exec(
      await readFile(
        new URL(`../../../packages/db/migrations/${name}`, import.meta.url),
        "utf8",
      ),
    );
  await db
    .insert(schema.users)
    .values({ id: userId, email: "reports-test@example.com" });
  await db.insert(schema.workspaces).values([
    { id: workspaceId, name: "سازمان", slug: "reports", ownerId: userId },
    {
      id: foreignWorkspace,
      name: "دیگری",
      slug: "foreign-reports",
      ownerId: userId,
    },
  ]);
  for (const [id, version, step, account, workspace] of [
    [workflowId, versionId, replyStepId, accountId, workspaceId],
    [otherWorkflow, otherVersion, otherStep, otherAccount, workspaceId],
    [
      foreignWorkflow,
      foreignVersion,
      foreignStep,
      foreignAccount,
      foreignWorkspace,
    ],
  ]) {
    await db
      .insert(schema.socialAccounts)
      .values({
        id: account,
        workspaceId: workspace,
        channel: "youtube",
        externalAccountId: account,
        displayName: "مدرسه حفظ",
        credentials: { testSecret: "NEVER_EXPOSE_CREDENTIALS" },
      });
    await db
      .insert(schema.workflows)
      .values({
        id,
        workspaceId: workspace,
        name: "پاسخ یوتیوب",
        status: "active",
      });
    await db
      .insert(schema.workflowVersions)
      .values({ id: version, workflowId: id, version: 1 });
    await db
      .insert(schema.workflowSteps)
      .values({
        id: step,
        workflowVersionId: version,
        key: "reply",
        type: "youtube_reply",
        name: "پاسخ",
        config: { accountId: account },
      });
  }
  const [content] = await db
    .insert(schema.contentItems)
    .values({ workspaceId, title: "خبر ایتا", body: "خبر" })
    .returning();
  const [variant] = await db
    .insert(schema.contentVariants)
    .values({ contentItemId: content.id, channel: "eitaa", body: "خبر" })
    .returning();
  await db
    .insert(schema.publications)
    .values({
      workspaceId,
      contentVariantId: variant.id,
      status: "published",
      attempt: 2,
      createdAt: date(1),
      publishedAt: date(2),
    });
  for (const [index, status] of [
    "published",
    "processing",
    "failed",
    "queued",
    "waiting_approval",
  ].entries()) {
    await db
      .insert(schema.youtubeItems)
      .values({
        workspaceId,
        workflowId,
        accountId,
        channelName: "مدرسه حفظ",
        stepKey: "youtube",
        itemKey: status,
        title: `ویدئو ${status}`,
        status,
        createdAt: date(10 + index),
        updatedAt: date(15),
        videoId: index < 3 ? `video-${index}` : null,
        sessionEnc: "NEVER_EXPOSE_SESSION",
        settings: { privacy: "public", privateData: "NEVER_EXPOSE_SETTINGS" },
        actualPrivacy: "private",
        error: status === "failed" ? "کاور ناموفق بود" : null,
        logs:
          index === 0
            ? [
                { result: "upload_started" },
                { result: "published", time: date(11).toISOString() },
              ]
            : index === 2
              ? [{ result: "upload_started" }, { result: "upload_started" }]
              : [],
      });
  }
  await db
    .insert(schema.youtubeItems)
    .values({
      workspaceId: foreignWorkspace,
      workflowId: foreignWorkflow,
      accountId: foreignAccount,
      channelName: "محرمانه",
      stepKey: "youtube",
      itemKey: "foreign",
      title: "FOREIGN_VIDEO",
      status: "published",
    });
  for (const status of [
    "succeeded",
    "waiting_approval",
    "failed",
    "already_replied",
    "queued",
  ])
    await seedComment(status);
  await seedComment("succeeded", true);
  await seedComment("succeeded", false, true);
  app.decorate("authenticate", async (request: any) => {
    const scope = request.headers["x-scope"];
    request.auth = {
      userId,
      email: "reports-test@example.com",
      workspaceId,
      role: "viewer",
      channelIds:
        scope === "none"
          ? []
          : scope === "allowed"
            ? [accountId]
            : scope === "other"
              ? [otherAccount]
              : null,
      workflowIds:
        scope === "empty-workflows"
          ? []
          : scope === "allowed"
            ? [workflowId]
            : null,
    };
  });
  app.addHook("preHandler", (request, reply) =>
    enforceAccess(database, request, reply),
  );
  app.setErrorHandler((error, _request, reply) =>
    reply
      .code(error instanceof Error && error.name === "ZodError" ? 400 : 500)
      .send({ error: error instanceof Error ? error.message : "خطا" }),
  );
  await app.register(analyticsRoutes, { database });
});
after(async () => {
  await app.close();
  await engine.close();
});
async function seedComment(status: string, other = false, foreign = false) {
  const id = randomUUID(),
    wf = foreign ? foreignWorkflow : other ? otherWorkflow : workflowId;
  const input = {
    text: foreign
      ? "FOREIGN_COMMENT"
      : other
        ? "کامنت کانال دوم"
        : `کامنت ${status}`,
    commentId: `parent-${status}-${id}`,
    youtube: {
      accountId: foreign ? foreignAccount : other ? otherAccount : accountId,
      videoId: "video-example",
    },
  };
  const runStatus =
    status === "succeeded" || status === "already_replied"
      ? "completed"
      : status;
  await db
    .insert(schema.runs)
    .values({
      id,
      workflowId: wf,
      workflowVersionId: foreign
        ? foreignVersion
        : other
          ? otherVersion
          : versionId,
      trigger: "youtube_comments",
      status: runStatus as any,
      input,
      createdAt: date(15),
      output: status === "queued" ? { retryAt: date(18).toISOString() } : null,
    });
  if (status !== "queued")
    await db
      .insert(schema.runSteps)
      .values({
        runId: id,
        workflowStepId: foreign ? foreignStep : other ? otherStep : replyStepId,
        status: runStatus as any,
        output:
          status === "failed"
            ? null
            : {
                reply: "پاسخ ویرایش‌شده",
                sentiment: "positive",
                replyStatus: ["succeeded", "already_replied"].includes(status)
                  ? status
                  : undefined,
                externalUrl:
                  status === "succeeded"
                    ? "https://www.youtube.com/watch?v=video-example&lc=reply"
                    : undefined,
              },
        error:
          status === "failed" ? { message: "خطای پیش از تولید پاسخ" } : null,
        startedAt: date(15),
      });
  return id;
}
test("summary counts historical YouTube uploads together with normal publications and preserves processing failures", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/analytics/summary",
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().totals, {
    total: 5,
    published: 2,
    failed: 1,
    queued: 2,
    totalAttempts: 6,
    successRate: 40,
  });
  assert.equal(
    response.json().byChannel.find((row: any) => row.channel === "youtube")
      .total,
    4,
  );
});
test("history exposes safe video metadata and external links, applies date/status filters before returning", async () => {
  const response = await app.inject({ method: "GET", url: "/publications" });
  assert.equal(response.statusCode, 200, response.body);
  const rows = response.json();
  assert.equal(rows.length, 5);
  assert.equal(rows.filter((row: any) => row.kind === "youtube").length, 4);
  assert.equal(rows[0].publication.status, "queued");
  const failed = rows.find((row: any) => row.publication.status === "failed");
  assert.equal(failed.youtube.rawStatus, "failed");
  assert.match(failed.publication.externalUrl, /video-2/);
  assert.equal(failed.publication.error.message, "کاور ناموفق بود");
  assert.equal(failed.youtube.requestedPrivacy, "public");
  assert.equal(failed.youtube.actualPrivacy, "private");
  assert.doesNotMatch(
    response.body,
    /NEVER_EXPOSE|FOREIGN_VIDEO|waiting_approval/,
  );
  assert.equal(
    (
      await app.inject({ method: "GET", url: "/publications?status=published" })
    ).json().length,
    2,
  );
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: `/analytics/summary?from=${date(10).toISOString()}&to=${date(12).toISOString()}`,
      })
    ).json().totals.total,
    3,
  );
});
test("comment report includes sent, proposed, failed-before-AI and queued comments without fabricating missing replies", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/analytics/youtube-comments",
  });
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json();
  assert.deepEqual(result.totals, {
    total: 6,
    sent: 2,
    alreadyReplied: 1,
    waitingApproval: 1,
    failed: 1,
  });
  const failed = result.rows.find((row: any) => row.status === "failed");
  assert.equal(failed.text, "کامنت failed");
  assert.equal(failed.reply, null);
  assert.equal(failed.error, "خطای پیش از تولید پاسخ");
  const sent = result.rows.find((row: any) => row.status === "succeeded");
  assert.equal(sent.reply, "پاسخ ویرایش‌شده");
  assert.equal(sent.videoId, "video-example");
  const queued = result.rows.find((row: any) => row.status === "queued");
  assert.equal(queued.stepKey, null);
  assert.equal(queued.reply, null);
  assert.equal(queued.retryAt, date(18).toISOString());
  assert.doesNotMatch(response.body, /FOREIGN_COMMENT|NEVER_EXPOSE/);
});
test("comment filters, search and stable pagination include historical rows beyond the first page", async () => {
  const ids: string[] = [];
  for (const offset of [0, 2, 4]) {
    const result = (
      await app.inject({
        method: "GET",
        url: `/analytics/youtube-comments?limit=2&offset=${offset}`,
      })
    ).json();
    assert.equal(result.totals.total, 6);
    ids.push(...result.rows.map((row: any) => row.id));
    assert.equal(result.hasMore, offset < 4);
  }
  assert.equal(new Set(ids).size, 6);
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/analytics/youtube-comments?status=failed",
      })
    ).json().rows.length,
    1,
  );
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: `/analytics/youtube-comments?workflowId=${workflowId}&accountId=${accountId}`,
      })
    ).json().totals.total,
    5,
  );
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: `/analytics/youtube-comments?q=${encodeURIComponent("کامنت failed")}`,
      })
    ).json().totals.total,
    1,
  );
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/analytics/youtube-comments?q=%25",
      })
    ).json().totals.total,
    0,
  );
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/analytics/youtube-comments?limit=101",
      })
    ).statusCode,
    400,
  );
});
test("assigned-channel and workflow scopes constrain comment rows and counters; empty access cannot leak totals", async () => {
  for (const [scope, total] of [
    ["allowed", 5],
    ["other", 1],
    ["none", 0],
    ["empty-workflows", 0],
  ] as const) {
    const response = await app.inject({
      method: "GET",
      url: "/analytics/youtube-comments",
      headers: { "x-scope": scope },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().totals.total, total);
    assert.equal(response.json().rows.length, total);
  }
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: `/analytics/youtube-comments?workflowId=${foreignWorkflow}`,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/analytics/summary",
        headers: { "x-scope": "allowed" },
      })
    ).statusCode,
    403,
  );
});
