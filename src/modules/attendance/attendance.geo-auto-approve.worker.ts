import { Worker } from 'bullmq';

import { runGeoAutoApproveForAllTenants } from './attendance.geo-auto-approve.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

// geoAutoApproveWorker est un worker qui exécute la fonction runGeoAutoApproveForAllTenants pour auto-approuver 
// les validations géo en attente depuis plus de 7 jours, et est configuré pour se connecter à Redis en utilisant l'URL spécifiée dans les variables d'environnement. 
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
    concurrency: Number(process.env.GEO_AUTO_APPROVE_WORKER_CONCURRENCY ?? 2),
  }
);

// Gestion des événements du worker pour le suivi de l'exécution des jobs
geoAutoApproveWorker.on('completed', (job) => {
  console.log(`[geo-auto-approve-worker] job ${job.id} completed`); // Log pour indiquer la complétion d'un job spécifique
});

geoAutoApproveWorker.on('failed', (job, error) => {
  console.error(`[geo-auto-approve-worker] job ${job?.id} failed:`, error); // Log pour indiquer l'échec d'un job spécifique
});

// Schedule job quotidien à 3h du matin
export const scheduleGeoAutoApprove = async () => {
  const { geoAutoApproveQueue } = await import('../../shared/queue/queue.js');

  // Ajout d'un job récurrent pour exécuter la fonction runGeoAutoApproveForAllTenants tous les jours à 3h 
  // du matin, avec des options pour gérer la répétition et le nettoyage des jobs complétés ou échoués. 
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
