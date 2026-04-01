/**
 * Redis client singleton.
 *
 * Returns `null` when REDIS_URL is not set so the rest of the queue
 * layer can fall back to in-memory implementations for local dev.
 */

import Redis from "ioredis";

let client: Redis | null = null;

export function getRedisClient(): Redis | null {
  if (client) return client;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  client = new Redis(url, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 200, 5000),
    lazyConnect: true,
  });
  return client;
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
