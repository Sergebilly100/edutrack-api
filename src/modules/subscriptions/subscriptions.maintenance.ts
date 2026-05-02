import type { Queue, Worker } from 'bullmq';
import { Queue as BullQueue, Worker as BullWorker } from 'bullmq';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';

import { db } from '../../shared/database/db.js';

export const SUBSCRIPTION_MAINTENANCE_QUEUE = 'subscription-maintenance';

type MaintenanceJobData = {
  schemaName?: string;
};

export const createSubscriptionMaintenanceQueue = (connection: Redis): Queue<MaintenanceJobData> =>
  new BullQueue<MaintenanceJobData>(SUBSCRIPTION_MAINTENANCE_QUEUE, { connection });

export const createSubscriptionMaintenanceWorker = (
  connection: Redis
): Worker<MaintenanceJobData> =>
  new BullWorker<MaintenanceJobData>(
    SUBSCRIPTION_MAINTENANCE_QUEUE,
    async () => {
      await db.execute(sql`
        WITH expired_trials AS (
          UPDATE public.tenants
          SET
            status = 'active',
            updated_at = NOW()
          WHERE status = 'trial'
            AND trial_ends_at <= NOW()
          RETURNING id, trial_ends_at
        )
        UPDATE public.subscriptions s
        SET
          current_period_start = CASE
            WHEN s.current_period_start < expired_trials.trial_ends_at
              THEN expired_trials.trial_ends_at
            ELSE s.current_period_start
          END,
          current_period_end = CASE
            WHEN s.current_period_end <= expired_trials.trial_ends_at
              THEN expired_trials.trial_ends_at + INTERVAL '1 month'
            ELSE s.current_period_end
          END
        FROM expired_trials
        WHERE s.tenant_id = expired_trials.id
      `);
    },
    { connection }
  );
