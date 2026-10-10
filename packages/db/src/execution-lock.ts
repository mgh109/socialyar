import { getPool } from "./client";

export class ExecutionOwnershipError extends Error {}

/** Session-scoped ownership: a crashed process releases its lock on disconnect.
 * No expiry may permit a second sender while the first is still alive. */
export async function withExecutionLock<T>(key: string, operation: (assertOwned: () => Promise<void>) => Promise<T>, pool = getPool()): Promise<T> {
  const client = await pool.connect();
  let locked = false;
  let lost = false;
  const onError = () => { lost = true; };
  client.on("error", onError);
  try {
    const result = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1, 72816402)) AS locked", [key]);
    locked = result.rows[0]?.locked === true;
    if (!locked) throw new Error("این کار هم‌اکنون توسط اجراکننده دیگری در حال پردازش است.");
    const assertOwned = async () => {
      if (lost) throw new ExecutionOwnershipError("ارتباط مالک اجرا قطع شده است؛ اجرای کار متوقف شد.");
      try { await client.query("SELECT 1"); }
      catch { lost = true; throw new ExecutionOwnershipError("ارتباط مالک اجرا قطع شده است؛ اجرای کار متوقف شد."); }
      if (lost) throw new ExecutionOwnershipError("مالکیت اجرا از دست رفته است.");
    };
    return await operation(assertOwned);
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 72816402))", [key]).catch(() => { lost = true; });
    client.off("error", onError);
    client.release(lost);
  }
}
