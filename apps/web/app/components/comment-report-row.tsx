import Link from "next/link";
import {
  commentStates,
  reportDate,
  youtubeCommentUrl,
  type CommentReportRow,
} from "../lib/reports";
import { persianError } from "../lib/persian";
export function CommentReportItem({ row }: { row: CommentReportRow }) {
  const commentUrl = youtubeCommentUrl(row),
    sent = row.status === "succeeded";
  return (
    <article className="comment-report-item">
      <header>
        <div>
          <strong>{row.accountName}</strong>
          <span>
            {row.workflowName}
            {row.stepName ? ` · ${row.stepName}` : ""}
          </span>
        </div>
        <span
          className={`publication-state ${sent ? "published" : row.status}`}
        >
          {commentStates[row.status] ?? "در حال بررسی"}
        </span>
      </header>
      <div className="comment-conversation">
        <section>
          <small>کامنت</small>
          <p dir="auto">{row.text || "متن کامنت در این اجرا ثبت نشده است."}</p>
        </section>
        <section className={sent ? "comment-reply sent" : "comment-reply"}>
          <small>{sent ? "پاسخ ارسال‌شده" : "پاسخ پیشنهادی"}</small>
          <p dir="auto">
            {row.reply ||
              (row.status === "skipped"
                ? "پاسخی ارسال نشده است."
                : "هنوز پاسخی آماده نشده است.")}
          </p>
          {row.status === "already_replied" ? (
            <small>
              این کامنت قبلاً پاسخ گرفته است؛ پیشنهاد این اجرا ارسال نشد.
            </small>
          ) : null}
        </section>
      </div>
      <footer>
        <time dateTime={row.at}>{reportDate(row.at)}</time>
        {row.sentiment ? (
          <span>
            احساس:{" "}
            {(
              { positive: "مثبت", negative: "منفی", neutral: "خنثی" } as Record<
                string,
                string
              >
            )[row.sentiment] ?? "نامشخص"}
          </span>
        ) : null}
        {row.videoId ? (
          <span>
            ویدئو: <bdi>{row.videoId}</bdi>
          </span>
        ) : null}
      </footer>
      {row.error ? (
        <p role="alert" className="report-error">
          {persianError(row.error)}
        </p>
      ) : null}
      {row.retryAt ? (
        <p className="report-note">زمان ادامه: {reportDate(row.retryAt)}</p>
      ) : null}
      <div className="report-row-actions">
        {commentUrl ? (
          <a
            className="ghost-link"
            href={commentUrl}
            target="_blank"
            rel="noreferrer"
          >
            کامنت در یوتیوب
          </a>
        ) : null}
        {sent && row.externalUrl ? (
          <a
            className="ghost-link"
            href={row.externalUrl}
            target="_blank"
            rel="noreferrer"
          >
            پاسخ در یوتیوب
          </a>
        ) : null}
        <Link className="ghost-link" href={`/runs/${row.runId}`}>
          جزئیات اجرا
        </Link>
        <Link
          className="ghost-link"
          href={`/workflows/new?id=${row.workflowId}`}
        >
          جریان
        </Link>
        {row.status === "waiting_approval" ? (
          <Link className="ghost-link" href="/approvals">
            بررسی و تأیید پاسخ
          </Link>
        ) : null}
        {row.reason ? (
          <details>
            <summary>دلیل پیشنهاد</summary>
            <p>{row.reason}</p>
          </details>
        ) : null}
      </div>
    </article>
  );
}
