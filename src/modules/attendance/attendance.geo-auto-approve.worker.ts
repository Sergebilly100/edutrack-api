import { Worker } from 'bullmq';

import { runGeoAutoApproveForAllTenants } from './attendance.geo-auto-approve.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

export const geoAutoApproveWorker = new Worker(
  'geo-auto-approve',
  async () => {
    console.log('[geo-auto-approve-worker] starting auto-approve job');
    await runGeoAutoApproveForAllTenants();
    console.log('[geo-auto-approve-worker] auto-approve job completed');
  },
  {
    connection: {
      url: redisUrl,
      maxRetriesPerRequest: null,
    },
  }
);

geoAutoApproveWorker.on('completed', (job) => {
  console.log(`[geo-auto-approve-worker] job ${job.id} completed`);
});

geoAutoApproveWorker.on('failed', (job, error) => {
  console.error(`[geo-auto-approve-worker] job ${job?.id} failed:`, error);
});

// Schedule job quotidien à 3h du matin
export const scheduleGeoAutoApprove = async () => {
  const { geoAutoApproveQueue } = await import('../../shared/queue/queue.js');

  await geoAutoApproveQueue.add(
    'daily-auto-approve',
    {},
    {
      repeat: {
        pattern: '0 3 * * *', // Cron: tous les jours à 3h du matin
      },
      removeOnComplete: 10, // Garder les 10 derniers jobs
      removeOnFail: 50, // Garder les 50 derniers échecs
    }
  );

  console.log('[geo-auto-approve] scheduled daily job at 3:00 AM');
};
