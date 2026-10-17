export type PublicationRow = {
  kind: "standard" | "youtube";
  publication: {
    id: string;
    status: string;
    attempt: number;
    externalUrl: string | null;
    error: { message?: unknown } | null;
    createdAt: string;
    publishedAt: string | null;
  };
  variant: { id: string; channel: string; title: string | null };
  content: {
    id: string;
    title: string | null;
    metadata: { sourceUrl?: unknown; routePath?: unknown };
  };
  youtube?: {
    accountName: string;
    workflowId: string;
    workflowName: string;
    runId: string | null;
    videoId: string | null;
    rawStatus: string;
    actualPrivacy: string | null;
    requestedPrivacy: string;
    scheduledAt: string | null;
  };
};
export const reportChannels: Record<string, string> = {
  youtube: "یوتیوب",
  instagram: "اینستاگرام",
  telegram: "تلگرام",
  eitaa: "ایتا",
  bale: "بله",
  website: "وب‌سایت",
  x: "ایکس",
  linkedin: "لینکدین",
};
export const publicationStates: Record<string, string> = {
  queued: "در صف",
  publishing: "در حال انتشار",
  published: "منتشرشده",
  failed: "ناموفق",
  cancelled: "لغوشده",
};
export const privacyNames: Record<string, string> = {
  public: "عمومی",
  private: "خصوصی",
  unlisted: "فهرست‌نشده",
};
export function publicationActionPath(
  row: PublicationRow,
  action: "retry" | "cancel",
) {
  return `${row.kind === "youtube" ? "/youtube/items" : "/publications"}/${row.publication.id}/${action}`;
}
export const reportDate = (value: string) =>
  new Date(value).toLocaleString("fa-IR", {
    timeZone: "Asia/Tehran",
    dateStyle: "medium",
    timeStyle: "short",
  });
export type CommentReportRow = {
  id: string;
  runId: string;
  runStatus: string;
  workflowId: string;
  workflowName: string;
  accountId: string | null;
  accountName: string;
  stepKey: string | null;
  stepName: string | null;
  status: string;
  commentId: string | null;
  videoId: string | null;
  text: string | null;
  reply: string | null;
  sentiment: string | null;
  reason: string | null;
  externalUrl: string | null;
  error: string | null;
  retryAt: string | null;
  at: string;
};
export type CommentReport = {
  rows: CommentReportRow[];
  totals: {
    total: number;
    sent: number;
    alreadyReplied: number;
    waitingApproval: number;
    failed: number;
  };
  limit: number;
  offset: number;
  hasMore: boolean;
};
export const commentStates: Record<string, string> = {
  succeeded: "پاسخ ارسال شد",
  already_replied: "قبلاً پاسخ داده شده",
  waiting_approval: "منتظر تأیید",
  failed: "ناموفق",
  running: "در حال بررسی",
  queued: "در صف",
  retrying: "در انتظار ادامه",
  completed: "پردازش شد",
  skipped: "بدون پاسخ",
  rejected: "رد شد",
};
export function youtubeCommentUrl(row: CommentReportRow) {
  return row.videoId && row.commentId
    ? `https://www.youtube.com/watch?v=${encodeURIComponent(row.videoId)}&lc=${encodeURIComponent(row.commentId)}`
    : null;
}
