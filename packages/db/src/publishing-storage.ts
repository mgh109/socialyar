import { readFile } from "node:fs/promises";
import { getPool } from "./client";

let pending: Promise<void> | undefined;
// API and worker may roll out together. Apply additive migrations once under a
// database advisory lock before either process reads the new columns/tables.
export async function ensurePublishingStorage() {
  if (process.env.HOOR_AUTO_MIGRATE === "false") return;
  pending ??= (async () => {
    const client = await getPool().connect();
    try {
      await client.query("SELECT pg_advisory_lock(72816401)");
      await client.query("BEGIN");
      for (const name of ["0006_youtube.sql", "0007_publishing_proxies.sql", "0008_publication_calendar.sql", "0009_content_collections.sql", "0010_shared_collections.sql"]) {
        await client.query((await readFile(new URL(`../migrations/${name}`, import.meta.url))).toString("utf8"));
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { await client.query("SELECT pg_advisory_unlock(72816401)").catch(() => {}); client.release(); }
  })();
  try { await pending; } catch (error) { pending = undefined; throw error; }
}
