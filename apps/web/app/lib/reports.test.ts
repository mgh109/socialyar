import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  publicationActionPath,
  type PublicationRow,
  type CommentReportRow,
} from "./reports";
import { PublicationReportRow } from "../components/publication-report-row";
import { CommentReportItem } from "../components/comment-report-row";
const require = createRequire(new URL("../../package.json", import.meta.url));
const React = require("react"),
  { renderToStaticMarkup } = require("react-dom/server");
Object.assign(globalThis, { React });
const video: PublicationRow = {
  kind: "youtube",
  publication: {
    id: "item",
    status: "failed",
    attempt: 2,
    externalUrl: "https://www.youtube.com/watch?v=video",
    error: { message: "تنظیم کاور ناموفق بود" },
    createdAt: "2026-10-17T10:00:00Z",
    publishedAt: null,
  },
  variant: { id: "item", channel: "youtube", title: "آموزش حفظ" },
  content: { id: "item", title: "آموزش حفظ", metadata: {} },
  youtube: {
    accountName: "مدرسه حفظ",
    workflowId: "workflow",
    workflowName: "آموزش قرآن",
    runId: null,
    videoId: "video",
    rawStatus: "failed",
    actualPrivacy: "private",
    requestedPrivacy: "public",
    scheduledAt: null,
  },
};
const comment: CommentReportRow = {
  id: "comment",
  runId: "run",
  runStatus: "completed",
  workflowId: "workflow",
  workflowName: "پاسخگویی",
  accountId: "account",
  accountName: "مدرسه حفظ",
  stepKey: "reply",
  stepName: "پاسخ هوشمند",
  status: "succeeded",
  commentId: "parent",
  videoId: "video",
  text: "ممنون از آموزش خوبتون",
  reply: "خوشحالیم که آموزش مفید بوده است.",
  sentiment: "positive",
  reason: "تشکر",
  externalUrl: "https://www.youtube.com/watch?v=video&lc=reply",
  error: null,
  retryAt: null,
  at: "2026-10-17T10:00:00Z",
};
test("publication actions use the owning publishing path, so retry never creates another video", () => {
  assert.equal(
    publicationActionPath(video, "retry"),
    "/youtube/items/item/retry",
  );
  assert.equal(
    publicationActionPath({ ...video, kind: "standard" }, "cancel"),
    "/publications/item/cancel",
  );
  const html = renderToStaticMarkup(
    React.createElement(PublicationReportRow, {
      row: video,
      busy: false,
      act: () => {},
    }),
  );
  assert.match(html, /ارسال شد؛ نیازمند تکمیل/);
  assert.match(html, /تکمیل همین ویدئو/);
  assert.match(html, /تنظیم کاور ناموفق بود/);
  assert.match(html, /وضعیت واقعی:.*خصوصی/);
  assert.match(html, /درخواستی: عمومی/);
  assert.match(html, /workflows\/new\?id=workflow/);
});
test("report shows original comment and actual sent reply with separate destination links", () => {
  const html = renderToStaticMarkup(
    React.createElement(CommentReportItem, { row: comment }),
  );
  assert.match(html, /ممنون از آموزش خوبتون/);
  assert.match(html, /خوشحالیم که آموزش مفید بوده است/);
  assert.match(html, /پاسخ ارسال‌شده/);
  assert.match(html, /lc=parent/);
  assert.match(html, /lc=reply/);
  assert.doesNotMatch(html, /پاسخ پیشنهادی/);
});
test("existing reply and failed proposed reply are never labelled as newly sent", () => {
  const html = renderToStaticMarkup(
    React.createElement(CommentReportItem, {
      row: { ...comment, status: "already_replied" },
    }),
  );
  assert.match(html, /پیشنهاد این اجرا ارسال نشد/);
  assert.doesNotMatch(html, /پاسخ ارسال‌شده|پاسخ در یوتیوب/);
  const failed = renderToStaticMarkup(
    React.createElement(CommentReportItem, {
      row: {
        ...comment,
        status: "failed",
        reply: null,
        error: "مجوز پاسخ موجود نیست",
      },
    }),
  );
  assert.match(failed, /هنوز پاسخی آماده نشده است/);
  assert.match(failed, /مجوز پاسخ موجود نیست/);
  assert.doesNotMatch(failed, /پاسخ ارسال‌شده/);
});
