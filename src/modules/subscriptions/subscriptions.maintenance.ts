import type { Queue, Worker } from 'bullmq';
import { Queue as BullQueue, Worker as BullWorker } from 'bullmq';
import { Redis } from 'ioredis';

import { withTenantSchema } from '../../shared/database/db.js';
import { SubscriptionsRepository } from './subscriptions.repository.js';
import { SubscriptionsService } from './subscriptions.service.js';

export const SUBSCRIPTION_MAINTENANCE_QUEUE = 'subscription-maintenance';

type MaintenanceJobData = {
  schemaName: string;
};

export const createSubscriptionMaintenanceQueue = (connection: Redis): Queue<MaintenanceJobData> =>
  new BullQueue<MaintenanceJobData>(SUBSCRIPTION_MAINTENANCE_QUEUE, { connection });

export const createSubscriptionMaintenanceWorker = (
  connection: Redis
): Worker<MaintenanceJobData> =>
  new BullWorker<MaintenanceJobData>(
    SUBSCRIPTION_MAINTENANCE_QUEUE,
    async (job) => {
      await withTenantSchema(job.data.schemaName, async (tenantDb) => {
        const service = new SubscriptionsService(new SubscriptionsRepository(tenantDb));
        await service.runDailyMaintenance();
      });
    },
    { connection }
  );
