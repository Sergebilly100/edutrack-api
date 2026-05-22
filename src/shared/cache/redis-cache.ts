import { Redis } from 'ioredis';

/**
 * Fail-open Redis cache wrapper.
 *
 * Reads return `undefined` on any error (missing key, malformed JSON, Redis down) — the
 * caller falls back to the source of truth. Writes are best-effort and swallowed on error.
 * This is the correct mode for non-authoritative caches: a cache outage degrades latency,
 * never correctness. (Token revocation, which IS authoritative, must NOT use this — see
 * `token-version.ts` which fails-closed by design.)
 */

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

let _redis: Redis | null = null;

const getRedis = (): Redis => {
  if (!_redis) {
    _redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
  }
  return _redis;
};

export const cacheGet = async <T>(key: string): Promise<T | undefined> => {
  try {
    const raw = await getRedis().get(key);
    if (raw === null) return undefined;
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
};

export const cacheSet = async <T>(key: string, value: T, ttlSeconds: number): Promise<void> => {
  try {
    await getRedis().set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch {
    // swallow — cache write failure must not break the request path
  }
};

export const cacheDel = async (...keys: string[]): Promise<void> => {
  if (keys.length === 0) return;
  try {
    await getRedis().del(...keys);
  } catch {
    // swallow
  }
};

/**
 * Cache-or-compute wrapper. Looks up the key in Redis; on miss (or any error) runs
 * `fetcher` and stores the result with the given TTL.
 */
export const cached = async <T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>
): Promise<T> => {
  const hit = await cacheGet<T>(key);
  if (hit !== undefined) return hit;

  const value = await fetcher();
  await cacheSet(key, value, ttlSeconds);
  return value;
};
