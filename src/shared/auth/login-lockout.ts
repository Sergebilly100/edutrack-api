import { Redis } from 'ioredis';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

let _redis: Redis | null = null;

const getRedis = (): Redis => {
  if (!_redis) {
    _redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
  }
  return _redis;
};

const FAIL_TTL_SECONDS = 60 * 60; // 1 heure pour compter les échecs de connexion
const SOFT_LOCK_SECONDS = 5 * 60; // 5 minutes de lock après 5 échecs, pour ralentir les attaques par force brute
const HARD_LOCK_SECONDS = 60 * 60; // 1 heure de lock après 10 échecs, pour bloquer les attaques persistantes
const SOFT_LOCK_THRESHOLD = 5; // seuil de 5 échecs pour le soft lock
const HARD_LOCK_THRESHOLD = 10; // seuil de 10 échecs pour le hard lock

const failKey = (schema: string, identifier: string): string =>
  `login_fail:${schema}:${identifier.toLowerCase()}`;

const lockKey = (schema: string, identifier: string): string =>
  `login_lock:${schema}:${identifier.toLowerCase()}`;

export type LockoutState = {
  locked: boolean;
  remainingSeconds: number;
};

export const isLoginLocked = async (
  schema: string,
  identifier: string
): Promise<LockoutState> => {
  try {
    const redis = getRedis();
    const key = lockKey(schema, identifier);
    const ttl = await redis.ttl(key);
    if (ttl > 0) {
      return { locked: true, remainingSeconds: ttl };
    }
    return { locked: false, remainingSeconds: 0 };
  } catch {
    return { locked: false, remainingSeconds: 0 };
  }
};

export const recordFailedLogin = async (
  schema: string,
  identifier: string
): Promise<{ count: number; lockedSeconds: number }> => {
  try {
    const redis = getRedis();
    const fKey = failKey(schema, identifier);
    const count = await redis.incr(fKey);
    if (count === 1) {
      await redis.expire(fKey, FAIL_TTL_SECONDS);
    }

    let lockedSeconds = 0;
    if (count >= HARD_LOCK_THRESHOLD) {
      lockedSeconds = HARD_LOCK_SECONDS;
      await redis.set(lockKey(schema, identifier), '1', 'EX', HARD_LOCK_SECONDS);
    } else if (count >= SOFT_LOCK_THRESHOLD) {
      lockedSeconds = SOFT_LOCK_SECONDS;
      await redis.set(lockKey(schema, identifier), '1', 'EX', SOFT_LOCK_SECONDS);
    }

    return { count, lockedSeconds };
  } catch {
    return { count: 0, lockedSeconds: 0 };
  }
};

export const clearFailedLogins = async (
  schema: string,
  identifier: string
): Promise<void> => {
  try {
    const redis = getRedis();
    await redis.del(failKey(schema, identifier), lockKey(schema, identifier));
  } catch {
    // best-effort cleanup
  }
};
