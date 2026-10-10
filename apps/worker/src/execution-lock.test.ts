import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { withExecutionLock, getPool } from "@socialyar/db";
function poolFixture() {
  let owner = false;
  const destroyed: boolean[] = [];
  const clients: EventEmitter[] = [];
  const pool = { connect: async () => {
    const client = new EventEmitter(); clients.push(client);
    return Object.assign(client, {
      query: async (query: string) => {
        if (query.includes("pg_try_advisory_lock")) { const locked = !owner; if (locked) owner = true; return { rows: [{ locked }] }; }
        if (query.includes("pg_advisory_unlock")) owner = false;
        return { rows: [] };
      },
      release: (destroy: boolean) => { destroyed.push(destroy); },
    });
  } } as unknown as ReturnType<typeof getPool>;
  return { pool, clients, destroyed };
}
test("a live session excludes overlapping executions and releases for the next owner", async () => {
  const f = poolFixture(); let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const first = withExecutionLock("same-run", async (assertOwned) => { await assertOwned(); entered(); await blocked; }, f.pool);
  await ready;
  await assert.rejects(withExecutionLock("same-run", async () => assert.fail("second owner entered"), f.pool), /اجراکننده دیگری/);
  release(); await first;
  await withExecutionLock("same-run", async (assertOwned) => assertOwned(), f.pool);
});
test("lost lock connection prevents a remote action and is destroyed instead of reused", async () => {
  const f = poolFixture(); let sent = false;
  await assert.rejects(withExecutionLock("publication", async (assertOwned) => {
    f.clients[0].emit("error", new Error("connection lost"));
    await assertOwned(); sent = true;
  }, f.pool), /مالک اجرا/);
  assert.equal(sent, false); assert.equal(f.destroyed.at(-1), true);
});
