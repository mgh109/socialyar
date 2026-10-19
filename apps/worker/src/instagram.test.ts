import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "@socialyar/db/schema";
import {
  getDb,
  instagramConnection,
  instagramClient,
  readInstagramComments,
  readInstagramInbox,
  readInstagramAnalysis,
  readInstagramTrends,
  assertInstagramMessageWindow,
  sendInstagramAction,
  encryptSecret,
} from "@socialyar/db";
import {
  compareInstagramSamples,
  parseInstagramConfig,
  validateInstagramCreative,
  instagramCards,
  instagramSources,
  instagramProblems,
} from "@socialyar/shared";
import { graphProblem } from "@socialyar/workflow/graph";
import {
  generateInstagramCreative,
  generateInstagramSupport,
  generateWorkflowBlueprint,
} from "../../../packages/ai/src/index";
import { executeInstagram } from "../../../packages/workflow/src/instagram";
import { publishToChannel } from "../../../packages/channels/src/index";
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status });
const c = {
  id: randomUUID(),
  externalId: "100",
  token: "private-test-token",
  version: "v23.0",
  loginType: "instagram",
};
const now = new Date("2026-10-19T12:00:00Z");
test("nine cards preserve order, valid chains and source constraints", () => {
  assert.equal(instagramCards.length, 9);
  assert.equal(instagramCards[0].type, "instagram_publish");
  assert.equal(instagramCards[8].type, "instagram_content");
  for (const type of instagramSources) {
    assert.equal(
      graphProblem(
        [
          { key: "s", type },
          { key: "d", type: "draft" },
        ],
        [{ sourceKey: "s", targetKey: "d" }],
        true,
      ),
      null,
    );
    assert.equal(
      graphProblem(
        [
          { key: "m", type: "manual_input" },
          { key: "s", type },
        ],
        [{ sourceKey: "m", targetKey: "s" }],
        false,
      ),
      "graph_invalid_connection",
    );
  }
  const types = [
    "instagram_trends",
    "instagram_ideas",
    "instagram_script",
    "instagram_content",
    "draft",
  ];
  assert.equal(
    graphProblem(
      types.map((type, i) => ({ key: String(i), type })),
      types
        .slice(1)
        .map((_, i) => ({ sourceKey: String(i), targetKey: String(i + 1) })),
      true,
    ),
    null,
  );
});
test("growth requires measured snapshots, missing data and short intervals stay unclassified", () => {
  const item = {
      id: "1",
      url: "",
      caption: "موضوع",
      timestamp: now.toISOString(),
      likes: 15,
      comments: 5,
      source: "page",
    },
    old = { ...item, likes: 10, comments: 2 };
  assert.equal(
    compareInstagramSamples([item], [old], "2026-10-19T10:00:00Z", now)[0]
      .growthPerHour,
    4,
  );
  assert.equal(
    compareInstagramSamples([item], [old], "2026-10-19T11:30:00Z", now)[0]
      .interactionGrowth,
    null,
  );
  assert.equal(
    compareInstagramSamples(
      [item],
      [{ ...old, likes: null }],
      "2026-10-19T10:00:00Z",
      now,
    )[0].label,
    "سوژه پیشنهادی",
  );
  assert.equal(
    compareInstagramSamples([item], [], undefined, now)[0].interactionGrowth,
    null,
  );
});
test("config blocks injected discovery usernames, unzoned dates and invalid counts", () => {
  assert.throws(() =>
    parseInstagramConfig("instagram_trends", { usernames: ["bad){id}"] }),
  );
  assert.throws(() => parseInstagramConfig("instagram_ideas", { count: 999 }));
  assert.throws(() =>
    parseInstagramConfig("instagram_comments", {
      accountId: c.id,
      after: "2026-10-19T12:00:00",
    }),
  );
  assert.equal(
    parseInstagramConfig("instagram_action", { accountId: c.id })
      .requireApproval,
    true,
  );
});
test("comments paginate via safe cursors, skip own/old comments and check media ownership", async () => {
  let pages = 0;
  const request = (async (url: any, options: any) => {
    assert.equal(options.headers.Authorization, `Bearer ${c.token}`);
    assert.ok(!String(url).includes(c.token));
    const u = new URL(url);
    if (u.pathname.endsWith("/media"))
      return json({
        data: [{ id: "200", permalink: "https://www.instagram.com/p/a/" }],
      });
    if (u.pathname.endsWith("/200"))
      return json({ id: "200", owner: { id: "other" } });
    pages++;
    return pages === 1
      ? json({
          data: [
            { id: "1", text: "خود", from: { id: "100" } },
            { id: "2", text: "قدیمی", timestamp: "2025-01-01T00:00:00Z" },
          ],
          paging: { next: "https://evil.example", cursors: { after: "safe" } },
        })
      : json({
          data: [
            {
              id: "3",
              text: "سؤال",
              from: { id: "300" },
              timestamp: now.toISOString(),
            },
          ],
        });
  }) as typeof fetch;
  assert.deepEqual(
    (
      await readInstagramComments(
        c,
        { batchLimit: 3, after: "2026-01-01T00:00:00Z" },
        request,
      )
    ).items.map((i) => i.id),
    ["3"],
  );
  assert.equal(pages, 2);
  await assert.rejects(
    () => readInstagramComments(c, { mediaId: "200", batchLimit: 3 }, request),
    /متعلق/,
  );
});
test("inbox excludes conversations already answered and checks login support", async () => {
  const request = (async (url: any) =>
    String(url).includes("/conversations?")
      ? json({ data: [{ id: "c1" }, { id: "c2" }] })
      : json({
          data: String(url).includes("/c1/")
            ? [
                {
                  id: "in",
                  message: "سلام",
                  from: { id: "300" },
                  created_time: "2026-10-19T10:00:00Z",
                },
                {
                  id: "own",
                  message: "پاسخ",
                  from: { id: "100" },
                  created_time: "2026-10-19T11:00:00Z",
                },
              ]
            : [
                {
                  id: "last",
                  message: "قیمت؟",
                  from: { id: "300" },
                  created_time: now.toISOString(),
                },
              ],
        })) as typeof fetch;
  assert.deepEqual(
    (await readInstagramInbox(c, 20, request)).map((i) => i.id),
    ["last"],
  );
  await assert.rejects(
    () => readInstagramInbox({ ...c, loginType: "facebook" }, 20, request),
    /Instagram Login/,
  );
});
test("analysis labels missing Insights and never leaks provider errors or invents metrics", async () => {
  const request = (async (url: any) =>
    String(url).includes("/insights?")
      ? json({ error: { code: 200, message: c.token } }, 403)
      : String(url).includes("/media?")
        ? json({ data: [{ id: "1", like_count: 7 }] })
        : json({
            id: "100",
            username: "page",
            followers_count: 10,
          })) as typeof fetch;
  const report = await readInstagramAnalysis(
    c,
    { days: 28, batchLimit: 20 },
    request,
  );
  assert.equal(report.insights, null);
  assert.equal(report.items[0].comments, null);
  assert.ok(report.warnings.length >= 2);
  await assert.rejects(
    () => instagramClient(c, request)("100/insights"),
    (e) => e instanceof Error && !e.message.includes(c.token),
  );
  await assert.rejects(
    () => readInstagramTrends(c, ["page"], 20),
    /Facebook Login/,
  );
});
test("reply window and script scene timing enforce real chronology", () => {
  assert.doesNotThrow(() =>
    assertInstagramMessageWindow("2026-10-19T11:00:00Z", now),
  );
  for (const at of ["2026-10-18T12:00:00Z", "2026-10-20T00:00:00Z", "bad"])
    assert.throws(() => assertInstagramMessageWindow(at, now));
  const scene = {
      start: 0,
      end: 30,
      visual: "نما",
      voice: "گوینده",
      overlay: "متن",
    },
    script = {
      title: "عنوان",
      hook: "شروع",
      scenes: [scene],
      cta: "ذخیره کن",
      requirements: [],
    };
  assert.doesNotThrow(() =>
    validateInstagramCreative("instagram_script", script, { seconds: 30 }),
  );
  for (const scenes of [
    [{ ...scene, start: 1 }],
    [{ ...scene, end: 31 }],
    [
      { ...scene, end: 10 },
      { ...scene, start: 9 },
    ],
  ])
    assert.throws(() =>
      validateInstagramCreative(
        "instagram_script",
        { ...script, scenes },
        { seconds: 30 },
      ),
    );
});
test("AI returns validated packages, may hand off unknown answers, and knows all eight new runtime types", async () => {
  const original = globalThis.fetch;
  let raw = JSON.stringify({
      title: "پست",
      caption: "کپشن",
      coverPrompt: "تصویر",
      slides: [],
      checklist: [],
    }),
    seen = "";
  globalThis.fetch = (async (_url: any, opts: any) => {
    seen = opts.body;
    return json({ choices: [{ message: { content: raw } }] });
  }) as typeof fetch;
  try {
    const conn = { provider: "gapgpt", model: "test", token: "test" } as const;
    assert.equal(
      (
        (await generateInstagramCreative(
          conn,
          "instagram_content",
          { text: "نمونه" },
          { format: "image" },
        )) as any
      ).caption,
      "کپشن",
    );
    raw = JSON.stringify({ reply: "", reason: "اطلاعات کافی نیست" });
    assert.equal((await generateInstagramSupport(conn, "قیمت؟", {})).reply, "");
    raw = "{}";
    await generateWorkflowBlueprint(conn, "ایده و سناریو اینستاگرام بساز", {
      accounts: [],
      apiConnections: [],
    });
    for (const card of instagramCards.filter(
      (i) => i.type !== "instagram_publish",
    ))
      assert.ok(seen.includes(card.type));
  } finally {
    globalThis.fetch = original;
  }
});
const engine = new PGlite(),
  db = drizzle(engine, { schema }),
  database = db as unknown as ReturnType<typeof getDb>;
const workspaceId = randomUUID(),
  other = randomUUID(),
  accountId = randomUUID(),
  workflowId = randomUUID(),
  versionId = randomUUID(),
  runId = randomUUID();
before(async () => {
  process.env.HOOR_SECRET_KEY = Buffer.alloc(32, 1).toString("base64");
  for (const f of [
    "0000_initial.sql",
    "0001_auth.sql",
    "0002_eitaa_automation.sql",
    "0011_execution_recovery.sql",
    "0012_tenant_access.sql",
    "0014_image_generation.sql",
    "0015_instagram_actions.sql",
  ])
    await engine.exec(
      await readFile(
        new URL(`../../../packages/db/migrations/${f}`, import.meta.url),
        "utf8",
      ),
    );
  const userId = randomUUID();
  await db
    .insert(schema.users)
    .values({ id: userId, email: "instagram@example.com" });
  await db.insert(schema.workspaces).values([
    { id: workspaceId, ownerId: userId, name: "تست", slug: "instagram-test" },
    { id: other, ownerId: userId, name: "دیگر", slug: "instagram-other" },
  ]);
  await db.insert(schema.workspaceSubscriptions).values({ workspaceId });
  await db
    .insert(schema.socialAccounts)
    .values({
      id: accountId,
      workspaceId,
      channel: "instagram",
      externalAccountId: "100",
      credentials: {
        apiVersion: "v23.0",
        loginType: "instagram",
        accessTokenEnc: encryptSecret(c.token),
      },
    });
  await db
    .insert(schema.workflows)
    .values({ id: workflowId, workspaceId, name: "تست", status: "active" });
  await db
    .insert(schema.workflowVersions)
    .values({ id: versionId, workflowId, version: 1 });
  await db
    .insert(schema.runs)
    .values({ id: runId, workflowId, workflowVersionId: versionId });
});
after(async () => {
  await engine.close();
});
const lock = (async (_key: string, op: any) => op(async () => {})) as any;
const input = {
  workspaceId,
  workflowId,
  runId,
  accountId,
  kind: "reply" as const,
  targetId: "501",
  mediaId: "200",
  reply: "پاسخ",
  dailyLimit: 20,
};
function requestMock(post: () => Response) {
  return (async (url: any, options: any) => {
    if (options.method === "POST") return post();
    if (String(url).includes("/200?")) return json({ owner: { id: "100" } });
    return json({ id: "501", media: { id: "200" } });
  }) as typeof fetch;
}
test("persisted replies are tenant scoped and once-only across executions", async () => {
  await assert.rejects(
    () => instagramConnection(other, accountId, database),
    /فضای کاری/,
  );
  let posts = 0;
  const req = requestMock(() => {
    posts++;
    return json({ id: "sent" });
  });
  assert.equal(
    (await sendInstagramAction(input, async () => {}, database, req, lock))
      .actionStatus,
    "succeeded",
  );
  assert.equal(
    (await sendInstagramAction(input, async () => {}, database, req, lock))
      .actionStatus,
    "duplicate_skipped",
  );
  assert.equal(posts, 1);
});
test("uncertain delivery counts toward quota and cannot resend", async () => {
  let posts = 0;
  const req = requestMock(() => {
    posts++;
    throw new Error("timeout " + c.token);
  });
  const uncertain = { ...input, targetId: "502" };
  await assert.rejects(
    () => sendInstagramAction(uncertain, async () => {}, database, req, lock),
    (e) => e instanceof Error && !e.message.includes(c.token),
  );
  await assert.rejects(
    () => sendInstagramAction(uncertain, async () => {}, database, req, lock),
    /نامشخص/,
  );
  assert.equal(posts, 1);
  await assert.rejects(
    () =>
      sendInstagramAction(
        { ...input, targetId: "503", dailyLimit: 2 },
        async () => {},
        database,
        requestMock(() => json({ id: "new" })),
        lock,
      ),
    /سقف/,
  );
});
test("pause and foreign media block POST; approval keeps proposed response", async () => {
  await db
    .update(schema.workflows)
    .set({ status: "paused" })
    .where(eq(schema.workflows.id, workflowId));
  await assert.rejects(
    () =>
      sendInstagramAction(
        { ...input, targetId: "504" },
        async () => {},
        database,
        requestMock(() => {
          throw Error("must not POST");
        }),
        lock,
      ),
    /متوقف/,
  );
  await db
    .update(schema.workflows)
    .set({ status: "active" })
    .where(eq(schema.workflows.id, workflowId));
  await assert.rejects(
    () =>
      sendInstagramAction(
        { ...input, targetId: "504" },
        async () => {},
        database,
        (async () => json({ owner: { id: "other" } })) as typeof fetch,
        lock,
      ),
    /متعلق/,
  );
  const item = {
    text: "سؤال",
    commentId: "501",
    instagram: { accountId, mediaId: "200" },
  };
  const result = await executeInstagram(
    {
      type: "instagram_action",
      config: { accountId },
      workspaceId,
      workflowId,
      runId,
      stepKey: "reply",
      recordId: randomUUID(),
      item,
      prior: { ...item, reply: "پاسخ پیشنهادی", approved: false },
      usage: async () => {},
      assertOwned: async () => {},
    },
    database,
  );
  assert.equal(result.hold, true);
  assert.equal(result.output.reply, "پاسخ پیشنهادی");
});
test("native story uses STORIES and omits unsupported caption", async () => {
  assert.deepEqual(
    instagramProblems(
      { instagramType: "story", imageUrl: "https://example.com/image.jpg" },
      "",
    ),
    [],
  );
  let body: URLSearchParams | undefined;
  const request = (async (url: any, options: any) => {
    if (String(url).endsWith("/media")) {
      body = options.body;
      return json({ id: "container" });
    }
    if (String(url).includes("status_code"))
      return json({ status_code: "FINISHED" });
    if (String(url).endsWith("/media_publish"))
      return json({ id: "published" });
    return json({ permalink: "https://www.instagram.com/p/story/" });
  }) as typeof fetch;
  assert.equal(
    (
      await publishToChannel({
        channel: "instagram",
        content: "کپشن",
        instagramType: "story",
        imageUrl: "https://example.com/image.jpg",
        credentials: { accessToken: "test", apiVersion: "v23.0" },
        externalAccountId: "100",
        saveProviderState: async () => {},
        fetch: request,
      })
    ).externalId,
    "published",
  );
  assert.equal(body?.get("media_type"), "STORIES");
  assert.equal(body?.has("caption"), false);
});
