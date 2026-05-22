import { Redis } from 'ioredis';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

let _redis: Redis | null = null;

const getRedis = (): Redis => {
  if (!_redis) {
    _redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
  }
  return _redis;
};

/**
 * Thrown when the Redis-backed revocation check cannot complete.
 * Callers (the auth middleware) translate this into a 503 to fail closed —
 * we'd rather lock users out briefly than honor a token that may have been revoked.
 */
export class TokenRevocationUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('Token revocation check unavailable');
    this.name = 'TokenRevocationUnavailableError';
    if (cause instanceof Error) {
      this.cause = cause;
    }
  }
}

/**
 * Redis key that stores the Unix timestamp (seconds) of the last password reset
 * for this user. Any JWT issued before this timestamp is considered invalid.
 */
const revokeAtKey = (schemaName: string, userId: string): string =>
  `revoke_at:${schemaName}:${userId}`;

/**
 * Returns the revocation timestamp for this user (0 if none recorded).
 * JWT tokens with iat < this value must be rejected.
 *
 * Throws TokenRevocationUnavailableError if Redis is unreachable — the caller
 * must convert that into a 503 so a stolen token cannot survive a Redis outage.
 */
export const getRevokeAt = async (schemaName: string, userId: string): Promise<number> => {
  try {
    const value = await getRedis().get(revokeAtKey(schemaName, userId));
    if (value === null) {
      return 0;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch (error) {
    throw new TokenRevocationUnavailableError(error);
  }
};

/**
 * Records the current time as the revocation timestamp for this user.
 * All previously issued access tokens (iat < now) will be rejected by the middleware.
 * TTL: 90 days (maximum refresh token lifetime).
 */
export const recordPasswordReset = async (schemaName: string, userId: string): Promise<void> => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const key = revokeAtKey(schemaName, userId);
  await getRedis().set(key, String(nowSeconds), 'EX', 90 * 24 * 60 * 60);
};
