import Link from "next/link";
import { persianError } from "../lib/persian";
import {
  privacyNames,
  publicationStates,
  reportChannels,
  reportDate,
  type PublicationRow,
} from "../lib/reports";
export function PublicationReportRow({
  row,
  busy,
  act,
}: {
  row: PublicationRow;
  busy: boolean;
  act: (row: PublicationRow, action: "retry" | "cancel") => void;
}) {
  const p = row.publication,
    video = row.youtube;
  const partial = Boolean(video?.videoId && p.status === "failed");
  return (
    <article className="history-row">
      <div className="history-status">
        <span className={`publication-state ${p.status}`}>
          {partial
            ? "ارسال شد؛ نیازمند تکمیل"
            : (publicationStates[p.status] ?? "در حال بررسی")}
        </span>
      </div>
      <div className="history-main">
        <strong>
          {row.variant.title || row.content.title || "بدون عنوان"}
        </strong>
        <span>
          {reportChannels[row.variant.channel] ?? row.variant.channel}
          {video
            ? ` · ${video.accountName} · ${video.workflowName}`
            : ""} · {p.attempt.toLocaleString("fa-IR")} تلاش
        </span>
        {video?.actualPrivacy ? (
          <span>
            وضعیت واقعی: {privacyNames[video.actualPrivacy] ?? "نامشخص"}
            {video.actualPrivacy !== video.requestedPrivacy
              ? ` · درخواستی: ${privacyNames[video.requestedPrivacy] ?? "نامشخص"}`
              : ""}
          </span>
        ) : null}
        {p.error?.message ? (
          <p className="history-error">{persianError(p.error.message)}</p>
        ) : null}
        {video?.scheduledAt && p.status === "queued" ? (
          <small>زمان انتشار: {reportDate(video.scheduledAt)}</small>
        ) : null}
        {Array.isArray(row.content.metadata?.routePath) ? (
          <details>
            <summary>مسیر محتوا</summary>
            <span>
              {row.content.metadata.routePath
                .filter((part): part is string => typeof part === "string")
                .join(" ← ")}
            </span>
            {typeof row.content.metadata.sourceUrl === "string" ? (
              <a href={row.content.metadata.sourceUrl} target="_blank" rel="noreferrer">مشاهدهٔ منبع</a>
            ) : null}
          </details>
        ) : null}
      </div>
      <time className="history-time" dateTime={p.publishedAt || p.createdAt}>
        {reportDate(p.publishedAt || p.createdAt)}
      </time>
      <div className="history-action">
        {p.status === "failed" ? (
          <button
            className="ghost-button"
            disabled={busy}
            onClick={() => act(row, "retry")}
          >
            {partial ? "تکمیل همین ویدئو" : "تلاش دوباره"}
          </button>
        ) : null}
        {p.status === "queued" ? (
          <button
            className="ghost-button"
            disabled={busy}
            onClick={() => act(row, "cancel")}
          >
            لغو انتشار
          </button>
        ) : null}
        {p.externalUrl ? (
          <a
            className="ghost-link"
            href={p.externalUrl}
            target="_blank"
            rel="noreferrer"
          >
            {video ? "مشاهده در یوتیوب" : "مشاهده خروجی"}
          </a>
        ) : null}
        {video ? (
          <Link
            className="ghost-link"
            href={`/workflows/new?id=${video.workflowId}`}
          >
            جریان
          </Link>
        ) : null}
        {video?.runId ? (
          <Link className="ghost-link" href={`/runs/${video.runId}`}>
            جزئیات اجرا
          </Link>
        ) : null}
      </div>
    </article>
  );
}
