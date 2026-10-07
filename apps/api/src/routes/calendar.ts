import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { calendarStatus, assertCalendarAction, type CalendarItem } from "@socialyar/shared";
import { getDb, contentVariants, contentItems, publications, schedules, socialAccounts, workflows, runs, approvals, youtubeItems,
  calendarActions, validateConnectionPolicy, readYoutubeMedia, fetchYoutubeMedia, storeYoutubeMedia } from "@socialyar/db";
import { publicationQueue } from "../queue";
import { policySchema } from "./proxies";

const settingsSchema = z.object({ imageUrl: z.string().url().nullable().optional(), videoUrl: z.string().url().nullable().optional(),
  coverUrl: z.string().url().nullable().optional(), privacy: z.enum(["public", "private", "unlisted"]).optional(),
  tags: z.array(z.string().max(100)).max(50).optional(), madeForKids: z.boolean().optional(), connection: policySchema.optional() });
const mutationSchema = z.object({ action: z.enum(["edit", "schedule", "unschedule", "stop", "approve", "reject", "retry"]),
  version: z.number().int().min(0), publicationId: z.string().uuid().nullable().optional(), title: z.string().trim().min(1).max(300).optional(),
  updatedAt: z.string().datetime().optional(),
  body: z.string().max(20000).optional(), settings: settingsSchema.optional(), accountId: z.string().uuid().nullable().optional(),
  scheduledAt: z.string().datetime().optional(), timezone: z.string().default("Asia/Tehran"), destinationChecked: z.boolean().optional() }).superRefine((value, context) => {
    if (value.action !== "edit" && (value.title !== undefined || value.body !== undefined || value.settings !== undefined)) context.addIssue({ code: "custom", message: "تغییر محتوا و تنظیمات فقط از مسیر ویرایش مجاز است." });
  });
const string = (value: unknown) => typeof value === "string" && value ? value : null;
function validTimezone(zone: string) { try { new Intl.DateTimeFormat("fa-IR", { timeZone: zone }); return true; } catch { return false; } }
class CalendarConflict extends Error {}

export async function calendarRoutes(app: FastifyInstance) {
  const db = getDb(); app.addHook("onRequest", app.authenticate);
  app.get("/calendar/items", async (request) => {
    const [rows, videos, confirmedApprovals] = await Promise.all([
      db.select({ variant: contentVariants, content: contentItems, publication: publications, schedule: schedules, workflow: workflows, run: runs, account: socialAccounts })
        .from(contentVariants).innerJoin(contentItems, eq(contentVariants.contentItemId, contentItems.id))
        .leftJoin(publications, eq(publications.contentVariantId, contentVariants.id)).leftJoin(schedules, eq(publications.scheduleId, schedules.id))
        .leftJoin(runs, eq(contentItems.runId, runs.id)).leftJoin(workflows, eq(runs.workflowId, workflows.id))
        .leftJoin(socialAccounts, eq(publications.socialAccountId, socialAccounts.id)).where(eq(contentItems.workspaceId, request.auth.workspaceId)),
      db.select({ item: youtubeItems, workflow: workflows }).from(youtubeItems).innerJoin(workflows, eq(youtubeItems.workflowId, workflows.id))
        .where(eq(youtubeItems.workspaceId, request.auth.workspaceId)),
      db.select({ id: approvals.contentVariantId }).from(approvals).where(and(eq(approvals.workspaceId, request.auth.workspaceId), eq(approvals.status, "approved"))),
    ]);
    const approvedIds = new Set(confirmedApprovals.map((row) => row.id));
    const items: CalendarItem[] = rows.filter((r) => r.variant.channel !== "youtube").map(({ variant, content, publication, schedule, workflow, run, account }) => {
      const scheduledAt = variant.settings.calendarUnscheduled === true ? null : schedule?.scheduledAt ?? (publication && variant.settings.calendarHold !== true ? publication.publishedAt ?? publication.createdAt : null);
      const approved = ["approved", "scheduled", "published"].includes(variant.status) || variant.status === "failed" &&
        (approvedIds.has(variant.id) || variant.generatedBy === "ai" && variant.settings.calendarHold !== true);
      const held = publication?.status === "cancelled" && variant.settings.calendarHold === true;
      const rawStatus = variant.settings.calendarPaused === true ? "cancelled" : held ? variant.status : publication?.status ?? variant.status;
      const status = calendarStatus({ rawStatus, contentStatus: variant.status, scheduledAt, approved });
      return { id: `variant-${variant.id}-${publication?.id ?? "new"}`, kind: "variant", sourceId: variant.id, publicationId: publication?.id ?? null,
        version: variant.calendarVersion, updatedAt: variant.updatedAt.toISOString(), title: variant.title ?? content.title ?? "بدون عنوان", body: variant.body,
        channel: variant.channel, accountId: publication?.socialAccountId ?? string(variant.settings.accountId), accountName: account?.displayName ?? account?.externalAccountId ?? string(variant.settings.accountName),
        workflowId: workflow?.id ?? null, workflowName: workflow?.name ?? "محتوای مستقل", stepKey: string(content.metadata.publishStepKey), runId: run?.id ?? null,
        status, approved, scheduledAt: scheduledAt?.toISOString() ?? null, timezone: schedule?.timezone ?? "Asia/Tehran",
        overdue: status === "waiting_approval" && Boolean(scheduledAt && scheduledAt.getTime() <= Date.now()), settings: variant.settings,
        imageUrl: string(variant.settings.imageUrl) ?? string(content.metadata.imageUrl), videoUrl: string(variant.settings.videoUrl) ?? string(content.metadata.videoUrl),
        coverMediaId: null, videoMediaId: null, externalUrl: publication?.externalUrl ?? null, error: string(publication?.error?.message),
        deliveryUnknown: publication?.error?.deliveryUnknown === true, remoteConfirmed: Boolean(publication?.externalId), uploadStarted: false };
    });
    for (const { item, workflow } of videos) {
      // A failed media fetch / waiting-video placeholder is not a generated video output.
      if (!item.settings.videoMediaId && !item.videoId) continue;
      const effectiveDate = item.scheduledAt ?? (["queued", "uploading", "processing", "published", "failed", "cancelled"].includes(item.status) ? item.approvedAt : null);
      const status = calendarStatus({ rawStatus: item.status, scheduledAt: effectiveDate, approved: Boolean(item.approvedAt) });
      items.push({ id: `youtube-${item.id}`, kind: "youtube", sourceId: item.id, publicationId: null, version: item.queueVersion, updatedAt: item.updatedAt.toISOString(),
        title: item.title, body: item.description, channel: "youtube", accountId: item.accountId, accountName: item.channelName,
        workflowId: workflow.id, workflowName: workflow.name, stepKey: item.stepKey, runId: item.runId, status, approved: Boolean(item.approvedAt),
        scheduledAt: effectiveDate?.toISOString() ?? null, timezone: string(item.settings.timezone) ?? "Asia/Tehran",
        overdue: status === "waiting_approval" && Boolean(item.scheduledAt && item.scheduledAt.getTime() <= Date.now()), settings: item.settings,
        imageUrl: string(item.settings.coverUrl), videoUrl: string(item.settings.videoUrl), coverMediaId: string(item.settings.coverMediaId), videoMediaId: string(item.settings.videoMediaId),
        externalUrl: item.videoId ? `https://www.youtube.com/watch?v=${item.videoId}` : null, error: item.error, deliveryUnknown: false,
        remoteConfirmed: Boolean(item.videoId), uploadStarted: Boolean(item.sessionEnc || item.videoId) });
    }
    return items;
  });
  app.get("/calendar/items/:kind/:id/events", async (request) => {
    const params = z.object({ kind: z.enum(["variant", "youtube"]), id: z.string().uuid() }).parse(request.params);
    return db.select().from(calendarActions).where(and(eq(calendarActions.workspaceId, request.auth.workspaceId), eq(calendarActions.sourceId, params.id), eq(calendarActions.kind, params.kind))).orderBy(desc(calendarActions.createdAt));
  });
  app.post("/calendar/items/:kind/:id", async (request, reply) => {
    const params = z.object({ kind: z.enum(["variant", "youtube"]), id: z.string().uuid() }).parse(request.params);
    const result = await mutateCalendarItem(db, request.auth, params, request.body);
    return reply.code(result.status).send(result.body);
  });
}

export async function mutateCalendarItem(db: ReturnType<typeof getDb>, auth: import("../auth").AuthContext,
  params: { kind: "variant" | "youtube"; id: string }, rawInput: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const input = mutationSchema.parse(rawInput);
    if (!validTimezone(input.timezone)) return { status: 400, body: { error: "منطقه زمانی معتبر نیست." } };
    if (input.action === "schedule" && (!input.scheduledAt || new Date(input.scheduledAt).getTime() <= Date.now())) return { status: 400, body: { error: "تاریخ و ساعت آینده را انتخاب کنید." } };
    try {
      const result = await db.transaction(async (tx) => {
        let task: { kind: "variant" | "youtube"; id: string; version: number; scheduledAt: Date } | null = null;
        let previousTask: { kind: "variant" | "youtube"; id: string; version: number } | null = null;
        if (params.kind === "youtube") {
          const [item] = await tx.select().from(youtubeItems).where(and(eq(youtubeItems.id, params.id), eq(youtubeItems.workspaceId, auth.workspaceId))).for("update");
          if (!item) throw new CalendarConflict("آیتم پیدا نشد.");
          if (item.queueVersion !== input.version || input.updatedAt && input.updatedAt !== item.updatedAt.toISOString()) throw new CalendarConflict("آیتم تغییر کرده است؛ اطلاعات تازه را دریافت کنید.");
          previousTask = { kind: "youtube", id: item.id, version: item.queueVersion };
          const status = calendarStatus({ rawStatus: item.status, scheduledAt: item.scheduledAt, approved: Boolean(item.approvedAt) });
          assertCalendarAction({ action: input.action, status, remoteConfirmed: Boolean(item.videoId) && input.action !== "retry", uploadStarted: Boolean(item.sessionEnc || item.videoId),
            deliveryUnknown: false, scheduledAt: item.scheduledAt });
          if (input.action === "retry" && (item.status !== "failed" || !item.approvedAt)) throw new CalendarConflict("فقط ارسال ناموفقِ تأییدشده قابل تلاش مجدد است.");
          if (["approve", "reject"].includes(input.action) && item.status !== "waiting_approval") throw new CalendarConflict("آیتم منتظر تأیید نیست.");
          let settings: Record<string, unknown> = { ...item.settings, timezone: input.timezone };
          let accountId = item.accountId; let channelName = item.channelName;
          if (input.action === "edit") {
            if ((input.title?.length ?? item.title.length) > 100 || (input.body?.length ?? item.description.length) > 5000) throw new CalendarConflict("عنوان یوتیوب حداکثر ۱۰۰ و توضیحات حداکثر ۵۰۰۰ نویسه است.");
            if (input.settings?.connection) await validateConnectionPolicy(auth.workspaceId, input.settings.connection);
            settings = { ...settings, ...input.settings };
            if (input.settings?.coverUrl && input.settings.coverUrl !== item.settings.coverUrl) {
              const cover = await fetchYoutubeMedia(input.settings.coverUrl, 2_000_000, "image"); settings.coverMediaId = (await storeYoutubeMedia(item.workspaceId, cover.bytes)).mediaId;
            }
            if (input.settings?.coverUrl === null) { delete settings.coverMediaId; delete settings.coverUrl; }
            if (input.accountId && input.accountId !== item.accountId) {
              const [account] = await tx.select().from(socialAccounts).where(and(eq(socialAccounts.id, input.accountId), eq(socialAccounts.workspaceId, auth.workspaceId), eq(socialAccounts.channel, "youtube"), eq(socialAccounts.isActive, true)));
              if (!account) throw new CalendarConflict("اتصال کانال مقصد معتبر نیست."); accountId = account.id; channelName = account.displayName ?? account.externalAccountId;
            }
          }
          if (input.action === "approve") await readYoutubeMedia(item.workspaceId, String(settings.videoMediaId), "video");
          const date = input.action === "schedule" ? new Date(input.scheduledAt!) : input.action === "unschedule" ? null : input.action === "retry" ? new Date(Math.max(Date.now(), item.scheduledAt?.getTime() ?? 0)) : item.scheduledAt;
          const approved = input.action === "approve" ? true : input.action === "edit" || input.action === "reject" ? false : Boolean(item.approvedAt);
          const nextStatus = input.action === "stop" ? "cancelled" : input.action === "reject" ? "rejected" : !approved ? "waiting_approval" : date ? "queued" : "approved";
          const version = item.queueVersion + 1;
          await tx.update(youtubeItems).set({ settings, accountId, channelName, title: input.title ?? item.title, description: input.body ?? item.description,
            queueVersion: version, status: nextStatus, scheduledAt: date, updatedAt: new Date(), error: null,
            approvedAt: approved ? item.approvedAt ?? new Date() : null, approvedBy: approved ? item.approvedBy ?? auth.userId : null,
            logs: [...item.logs, { channel: channelName, time: new Date().toISOString(), result: `calendar_${input.action}` }] }).where(eq(youtubeItems.id, item.id));
          if (nextStatus === "queued" && date) task = { kind: "youtube", id: item.id, version, scheduledAt: date };
        } else {
          const [owned] = await tx.select({ variant: contentVariants }).from(contentVariants).innerJoin(contentItems, eq(contentVariants.contentItemId, contentItems.id))
            .where(and(eq(contentVariants.id, params.id), eq(contentItems.workspaceId, auth.workspaceId)));
          if (!owned) throw new CalendarConflict("آیتم پیدا نشد.");
          let [publication] = await tx.select().from(publications).where(and(eq(publications.contentVariantId, params.id), input.publicationId ? eq(publications.id, input.publicationId) : undefined)).orderBy(desc(publications.createdAt)).limit(1).for("update");
          if (input.publicationId && !publication) throw new CalendarConflict("آیتم صف پیدا نشد؛ اطلاعات تازه را دریافت کنید.");
          const [variant] = await tx.select().from(contentVariants).where(eq(contentVariants.id, params.id)).for("update");
          if (variant.calendarVersion !== input.version || input.updatedAt && input.updatedAt !== variant.updatedAt.toISOString()) throw new CalendarConflict("آیتم تغییر کرده است؛ اطلاعات تازه را دریافت کنید.");
          let [schedule] = publication?.scheduleId ? await tx.select().from(schedules).where(eq(schedules.id, publication.scheduleId)).for("update") : [];
          const dateBefore = variant.settings.calendarUnscheduled ? null : schedule?.scheduledAt ?? null;
          const held = publication?.status === "cancelled" && variant.settings.calendarHold === true;
          const rawStatus = variant.settings.calendarPaused ? "cancelled" : held ? variant.status : publication?.status ?? variant.status;
          assertCalendarAction({ action: input.action, status: calendarStatus({ rawStatus, contentStatus: variant.status, scheduledAt: dateBefore }),
            remoteConfirmed: Boolean(publication?.externalId), uploadStarted: false, deliveryUnknown: publication?.error?.deliveryUnknown === true,
            destinationChecked: input.destinationChecked, scheduledAt: dateBefore });
          if (input.action === "retry" && publication?.status !== "failed") throw new CalendarConflict("فقط ارسال ناموفق قابل تلاش مجدد است.");
          const pending = await tx.select().from(approvals).where(and(eq(approvals.contentVariantId, variant.id), eq(approvals.status, "pending"))).for("update");
          if (["approve", "reject"].includes(input.action) && variant.status !== "waiting_approval") throw new CalendarConflict("آیتم منتظر تأیید نیست.");
          let approved = ["approved", "scheduled", "published"].includes(variant.status);
          if (input.action === "approve") approved = true;
          if (input.action === "edit" || input.action === "reject") approved = false;
          if (["retry", "schedule", "stop", "unschedule"].includes(input.action) && !approved && variant.status === "failed") {
            const [confirmation] = await tx.select().from(approvals).where(and(eq(approvals.contentVariantId, variant.id), eq(approvals.status, "approved"))).limit(1);
            approved = Boolean(confirmation) || variant.generatedBy === "ai" && variant.settings.calendarHold !== true;
          }
          if (input.action === "retry" && !approved) throw new CalendarConflict("محتوا پیش از ارسال نیازمند تأیید است.");
          const settings: Record<string, unknown> = { ...variant.settings, ...(input.action === "edit" ? input.settings : {}), calendarPaused: input.action === "stop" || input.action === "reject",
            calendarUnscheduled: input.action === "unschedule", calendarHold: !approved || input.action === "unschedule" };
          if (input.action === "edit" && input.settings?.connection) await validateConnectionPolicy(auth.workspaceId, input.settings.connection);
          const accountId = input.accountId ?? publication?.socialAccountId ?? string(variant.settings.accountId);
          if (accountId && !["stop", "reject", "unschedule"].includes(input.action)) {
            const [account] = await tx.select().from(socialAccounts).where(and(eq(socialAccounts.id, accountId), eq(socialAccounts.workspaceId, auth.workspaceId), eq(socialAccounts.channel, variant.channel), eq(socialAccounts.isActive, true)));
            if (!account) throw new CalendarConflict("حساب مقصد فعال و معتبر نیست.");
            settings.accountId = account.id; settings.accountName = account.displayName ?? account.externalAccountId;
          }
          const date = input.action === "schedule" ? new Date(input.scheduledAt!) : input.action === "unschedule" ? null : input.action === "retry" ? new Date(Math.max(Date.now(), dateBefore?.getTime() ?? 0)) : dateBefore;
          const stopped = input.action === "stop" || input.action === "reject";
          const nextContent = input.action === "reject" ? "rejected" : approved ? date && !stopped ? "scheduled" : "approved" : "waiting_approval";
          const queued = Boolean(approved && date && !stopped);
          settings.calendarHold = !queued && !stopped;
          settings.calendarUnscheduled = date === null;
          if (queued && !accountId) throw new CalendarConflict("حساب مقصد را انتخاب کنید.");
          if (date && !schedule) [schedule] = await tx.insert(schedules).values({ workspaceId: auth.workspaceId, contentVariantId: variant.id, socialAccountId: accountId,
            scheduledAt: date, timezone: input.timezone, status: stopped ? "cancelled" : "scheduled" }).returning();
          else if (schedule) await tx.update(schedules).set({ ...(date ? { scheduledAt: date } : {}), socialAccountId: accountId, timezone: input.timezone,
            status: date && !stopped ? "scheduled" : "cancelled", updatedAt: new Date() }).where(eq(schedules.id, schedule.id));
          if (!publication && (date || stopped)) [publication] = await tx.insert(publications).values({ workspaceId: auth.workspaceId, contentVariantId: variant.id,
            scheduleId: schedule?.id, socialAccountId: accountId, status: "cancelled" }).returning();
          if (publication) {
            previousTask = { kind: "variant", id: publication.id, version: publication.queueVersion };
            const version = publication.queueVersion + 1;
            await tx.update(publications).set({ queueVersion: version, scheduleId: schedule?.id ?? null, socialAccountId: accountId, status: queued ? "queued" : "cancelled",
              error: publication.error?.deliveryUnknown === true && !input.destinationChecked ? publication.error : null, updatedAt: new Date() }).where(eq(publications.id, publication.id));
            if (queued && date) task = { kind: "variant", id: publication.id, version, scheduledAt: date };
          }
          await tx.update(contentVariants).set({ title: input.title ?? variant.title, body: input.body ?? variant.body, settings, status: nextContent,
            calendarVersion: variant.calendarVersion + 1, updatedAt: new Date() }).where(eq(contentVariants.id, variant.id));
          if (input.action === "approve" || input.action === "reject") {
            await tx.update(approvals).set({ status: input.action === "approve" ? "approved" : "rejected", resolvedBy: auth.userId, resolvedAt: new Date() })
              .where(and(eq(approvals.contentVariantId, variant.id), eq(approvals.status, "pending")));
            if (input.action === "approve" && !pending.length) await tx.insert(approvals).values({ workspaceId: auth.workspaceId, contentVariantId: variant.id,
              status: "approved", resolvedBy: auth.userId, resolvedAt: new Date(), requestedBy: "calendar" });
          } else if (!approved && !pending.length && !stopped) await tx.insert(approvals).values({ workspaceId: auth.workspaceId, contentVariantId: variant.id, requestedBy: "calendar" });
        }
        await tx.insert(calendarActions).values({ workspaceId: auth.workspaceId, kind: params.kind, sourceId: params.id, action: input.action, userId: auth.userId,
          detail: { scheduledAt: input.scheduledAt ?? null, timezone: input.timezone, destinationChecked: input.destinationChecked ?? false } });
        return { task, previousTask };
      });
      if (result.previousTask) {
        const previous = result.previousTask;
        const prefix = previous.kind === "youtube" ? "youtube" : "publication";
        for (const id of [`${prefix}-${previous.id}`, `${prefix}-${previous.id}-v${previous.version}`]) {
          try {
            const old = await publicationQueue.getJob(id);
            if (old && (old.data.queueVersion ?? 0) === previous.version && await old.getState() !== "active") await old.remove();
          } catch { /* The durable queue version also invalidates an old job when Redis is temporarily unavailable. */ }
        }
      }
      if (result.task) {
        const task = result.task; const youtube = task.kind === "youtube";
        try { await publicationQueue.add(youtube ? "youtube-publish" : "publish-content", youtube ? { youtubeItemId: task.id, queueVersion: task.version } : { publicationId: task.id, queueVersion: task.version },
          { jobId: `${youtube ? "youtube" : "publication"}-${task.id}-v${task.version}`, delay: Math.max(0, task.scheduledAt.getTime() - Date.now()), attempts: youtube ? 1 : 3,
            backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 1000, removeOnFail: 1000 }); }
        catch {
          if (youtube) await db.update(youtubeItems).set({ status: "failed", error: "صف انتشار در دسترس نیست.", updatedAt: new Date() }).where(and(eq(youtubeItems.id, task.id), eq(youtubeItems.queueVersion, task.version), eq(youtubeItems.status, "queued")));
          else await db.update(publications).set({ status: "failed", error: { message: "صف انتشار در دسترس نیست." }, updatedAt: new Date() }).where(and(eq(publications.id, task.id), eq(publications.queueVersion, task.version), eq(publications.status, "queued")));
          return { status: 503, body: { error: "تغییر ذخیره شد، اما صف انتشار در دسترس نیست؛ تلاش مجدد کنید." } };
        }
      }
      return { status: 200, body: { ok: true } };
    } catch (error) { return { status: error instanceof CalendarConflict ? 409 : 400, body: { error: error instanceof Error ? error.message : "ثبت تغییر ناموفق بود." } }; }
}
