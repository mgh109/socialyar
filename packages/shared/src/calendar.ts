export type CalendarStatus = "draft" | "preparing" | "waiting_approval" | "scheduled" | "queued" | "sending" | "published" | "failed" | "stopped";
export type CalendarItem = {
  id: string; kind: "variant" | "youtube"; sourceId: string; publicationId: string | null; version: number; updatedAt: string;
  title: string; body: string; channel: string; accountId: string | null; accountName: string | null;
  workflowId: string | null; workflowName: string; stepKey: string | null; runId: string | null;
  status: CalendarStatus; approved: boolean; scheduledAt: string | null; timezone: string; overdue: boolean;
  settings: Record<string, unknown>; imageUrl: string | null; videoUrl: string | null; coverMediaId: string | null; videoMediaId: string | null;
  externalUrl: string | null; error: string | null; deliveryUnknown: boolean; remoteConfirmed: boolean; uploadStarted: boolean;
};
export function calendarStatus(input: { rawStatus: string; contentStatus?: string; scheduledAt?: Date | null; approved?: boolean; now?: number }): CalendarStatus {
  const { rawStatus, contentStatus, scheduledAt, approved } = input;
  if (["waiting_video", "preparing"].includes(rawStatus)) return "preparing";
  if (rawStatus === "published") return "published";
  if (["publishing", "uploading", "processing"].includes(rawStatus)) return "sending";
  if (rawStatus === "failed") return "failed";
  if (["cancelled", "rejected"].includes(rawStatus)) return "stopped";
  if (contentStatus === "waiting_approval" || rawStatus === "waiting_approval" || approved === false && scheduledAt) return "waiting_approval";
  if (rawStatus === "queued") return scheduledAt && scheduledAt.getTime() > (input.now ?? Date.now()) ? "scheduled" : "queued";
  if (scheduledAt) return "scheduled";
  return "draft";
}
export function canMoveCalendarItem(item: Pick<CalendarItem, "status" | "remoteConfirmed" | "uploadStarted">) {
  return !["preparing", "sending", "published"].includes(item.status) && !item.remoteConfirmed && !item.uploadStarted;
}
export function assertCalendarAction(input: { action: string; status: CalendarStatus; remoteConfirmed: boolean; uploadStarted: boolean; deliveryUnknown: boolean; destinationChecked?: boolean; approved?: boolean; scheduledAt?: Date | null; now?: number }) {
  if (["preparing", "sending", "published"].includes(input.status)) throw new Error("این آیتم در حال ارسال یا منتشرشده است و قابل تغییر نیست.");
  if (["schedule", "edit", "unschedule"].includes(input.action) && !canMoveCalendarItem(input)) throw new Error("آپلود آغاز شده است؛ تغییر محتوا یا زمان مجاز نیست.");
  if (["schedule", "retry", "approve"].includes(input.action) && input.remoteConfirmed) throw new Error("ارسال قبلاً در مقصد تأیید شده است؛ انتشار دوباره مجاز نیست.");
  if (["retry", "schedule", "approve"].includes(input.action) && input.deliveryUnknown && !input.destinationChecked) throw new Error("پیش از تلاش مجدد، مقصد را بررسی و نبودِ انتشار قبلی را تأیید کنید.");
  if (input.action === "approve" && input.scheduledAt && input.scheduledAt.getTime() <= (input.now ?? Date.now())) throw new Error("زمان انتشار گذشته؛ نیازمند تعیین تکلیف. زمان جدید تعیین کنید یا برنامه قبلی را حذف کنید.");
}
