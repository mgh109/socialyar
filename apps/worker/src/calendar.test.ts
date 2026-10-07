import { test, after } from "node:test";
import assert from "node:assert/strict";
import { calendarStatus, assertCalendarAction, canMoveCalendarItem } from "../../../packages/shared/src/calendar";
import { dayInZone, dayKey, persianParts, persianToDay, monthGrid, monthStart, nextMonth, weekStart, wallTimeToUTC, faDigits } from "../../web/app/lib/persian-calendar";
import { executePublication } from "./publisher";
import { executeYoutube } from "./youtube";
import { connection } from "./queue";
after(() => connection.disconnect());

test("Nowruz, Persian leap-day validation and year transitions", () => {
  assert.deepEqual(persianParts(new Date("2024-03-20T12:00:00Z")), { year: 1403, month: 1, day: 1 });
  assert.equal(dayKey(persianToDay(1403,12,30)), "2025-03-20");
  assert.throws(() => persianToDay(1404,12,30));
  assert.deepEqual(persianParts(nextMonth(persianToDay(1403,12,30),1)), { year: 1404, month: 1, day: 1 });
  assert.deepEqual(persianParts(nextMonth(persianToDay(1404,1,1),-1)), { year: 1403, month: 12, day: 1 });
});
test("month grids start Saturday and include all Persian month days", () => {
  for (let month = 1; month <= 12; month++) {
    const date = persianToDay(1405,month,15); const grid = monthGrid(date);
    assert.equal(grid.length, 42); assert.equal(grid[0].getUTCDay(), 6); assert.equal(weekStart(grid[6]).getUTCDay(), 6);
    assert.equal(grid.filter((d) => persianParts(d).month === month).length, (nextMonth(date,1).getTime() - monthStart(date).getTime())/86400000);
  }
  assert.equal(faDigits("1405/07/16 09:30"), "۱۴۰۵/۰۷/۱۶ ۰۹:۳۰");
});
test("Tehran day grouping and wall-clock conversion ignore host timezone", () => {
  assert.equal(dayKey(dayInZone(new Date("2026-10-07T21:00:00Z"), "Asia/Tehran")), "2026-10-08");
  assert.equal(wallTimeToUTC(new Date("2026-10-08T12:00:00Z"),9,15,"Asia/Tehran").toISOString(), "2026-10-08T05:45:00.000Z");
  assert.equal(wallTimeToUTC(new Date("2026-06-07T12:00:00Z"),9,0,"America/New_York").toISOString(), "2026-06-07T13:00:00.000Z");
  assert.throws(() => wallTimeToUTC(new Date("2026-03-08T12:00:00Z"),2,30,"America/New_York"));
});
test("scheduled unapproved content remains pending even after its due time", () => {
  const before = new Date("2026-10-07T09:00:00Z");
  assert.equal(calendarStatus({ rawStatus: "waiting_approval", scheduledAt: before, approved: false, now: Date.parse("2026-10-08T00:00:00Z") }), "waiting_approval");
  assert.equal(calendarStatus({ rawStatus: "queued", contentStatus: "waiting_approval", scheduledAt: before }), "waiting_approval");
  assert.throws(() => assertCalendarAction({ action: "approve", status: "waiting_approval", remoteConfirmed: false, uploadStarted: false, deliveryUnknown: false, scheduledAt: before,
    now: Date.parse("2026-10-08T00:00:00Z") }), /زمان انتشار گذشته/);
});
test("queued future content is scheduled, active uploads and final results have distinct states", () => {
  const scheduledAt = new Date("2027-01-01T00:00:00Z");
  assert.equal(calendarStatus({ rawStatus: "queued", scheduledAt, now: Date.parse("2026-10-07T00:00:00Z") }), "scheduled");
  assert.equal(calendarStatus({ rawStatus: "queued", scheduledAt, now: Date.parse("2027-01-02T00:00:00Z") }), "queued");
  assert.equal(calendarStatus({ rawStatus: "processing" }), "sending"); assert.equal(calendarStatus({ rawStatus: "published" }), "published");
  assert.equal(calendarStatus({ rawStatus: "cancelled" }), "stopped"); assert.equal(calendarStatus({ rawStatus: "failed" }), "failed");
});
test("active, published and already-started uploads cannot be moved or edited", () => {
  for (const status of ["sending", "published"] as const) {
    assert.equal(canMoveCalendarItem({ status, remoteConfirmed: false, uploadStarted: false }), false);
    assert.throws(() => assertCalendarAction({ action: "schedule", status, remoteConfirmed: false, uploadStarted: false, deliveryUnknown: false }));
  }
  assert.equal(canMoveCalendarItem({ status: "failed", remoteConfirmed: false, uploadStarted: true }), false);
  assert.throws(() => assertCalendarAction({ action: "edit", status: "failed", remoteConfirmed: false, uploadStarted: true, deliveryUnknown: false }));
});
test("unknown deliveries require destination review and confirmed sends cannot be replayed", () => {
  const item = { action: "retry", status: "failed" as const, remoteConfirmed: false, uploadStarted: false, deliveryUnknown: true };
  assert.throws(() => assertCalendarAction(item), /مقصد را بررسی/);
  assert.doesNotThrow(() => assertCalendarAction({ ...item, destinationChecked: true }));
  assert.throws(() => assertCalendarAction({ ...item, action: "schedule" }));
  assert.throws(() => assertCalendarAction({ ...item, action: "approve" }));
  assert.throws(() => assertCalendarAction({ ...item, destinationChecked: true, remoteConfirmed: true }));
});
test("stale queue jobs cannot claim a rescheduled publication or YouTube item", async () => {
  let writes = 0;
  const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ status: "queued", queueVersion: 3 }] }) }) }),
    update: () => { writes++; throw new Error("Should not claim"); } };
  await executePublication({ publicationId: "test", attempt: 1, maxAttempts: 3, queueVersion: 2 }, db as any);
  const youtubeDb = { select: () => ({ from: () => ({ where: async () => [{ status: "queued", approvedAt: new Date(), queueVersion: 3 }] }) }),
    update: () => { writes++; throw new Error("Should not claim"); } };
  await executeYoutube("test", youtubeDb as any, 2); assert.equal(writes, 0);
});
test("a matching job still cannot upload unapproved content", async () => {
  let read = 0; let writes = 0;
  const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => ++read === 1 ? [{ status: "queued", queueVersion: 1 }] : [{ status: "waiting_approval" }] }) }) }),
    update: () => { writes++; throw new Error("Should not claim"); } };
  await executePublication({ publicationId: "test", attempt: 1, maxAttempts: 3, queueVersion: 1 }, db as any); assert.equal(writes, 0);
});
