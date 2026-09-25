import IORedis from "ioredis";

export const connection = new IORedis(
  process.env.REDIS_URL ?? "redis://localhost:6379",
  { maxRetriesPerRequest: null },
);

/** Reserve a send time across every worker sharing Redis, scoped to the destination account. */
export async function reservePublicationSlot(accountId: string, intervalSeconds: number): Promise<number> {
  const interval = Math.round(intervalSeconds * 1000);
  const script = `
    local time = redis.call('TIME')
    local now = time[1] * 1000 + math.floor(time[2] / 1000)
    local previous = tonumber(redis.call('GET', KEYS[1]) or '0')
    local reserved = math.max(now, previous + tonumber(ARGV[1]))
    redis.call('SET', KEYS[1], reserved, 'PX', reserved - now + 86400000)
    return reserved - now
  `;
  const waitMs = await connection.eval(script, 1, `publication:slot:${accountId}`, interval);
  if (typeof waitMs !== "number" || waitMs < 0) throw new Error("Unable to reserve publication slot");
  return waitMs;
}
