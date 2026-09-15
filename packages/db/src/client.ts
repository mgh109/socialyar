import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

let pool: Pool | undefined;

export function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
  });

  return pool;
}

export function getDb() {
  return drizzle(getPool(), { schema });
}

export async function closeDb() {
  if (!pool) return;
  await pool.end();
  pool = undefined;
}
