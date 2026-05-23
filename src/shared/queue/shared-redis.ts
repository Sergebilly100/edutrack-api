import { Redis } from 'ioredis';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

let _sharedRedis: Redis | null = null;

export const getSharedRedis = (): Redis => {
  if (!_sharedRedis) {
    _sharedRedis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  }
  return _sharedRedis;
};

export const closeSharedRedis = async (): Promise<void> => {
  if (_sharedRedis) {
    await _sharedRedis.quit();
    _sharedRedis = null;
  }
};
