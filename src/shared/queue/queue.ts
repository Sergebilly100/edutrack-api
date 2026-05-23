import { Queue } from 'bullmq';

import { getSharedRedis } from './shared-redis.js';

export const qrAlertQueue = new Queue('qr-alert', {
  connection: getSharedRedis(),
});

export const geoAutoApproveQueue = new Queue('geo-auto-approve', {
  connection: getSharedRedis(),
});
