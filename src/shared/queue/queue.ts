import { Queue } from 'bullmq';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

export const qrAlertQueue = new Queue('qr-alert', {
  connection: {
    url: redisUrl,
  },
});
