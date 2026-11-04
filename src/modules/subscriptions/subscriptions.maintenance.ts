import type { Queue, Worker } from 'bullmq';
import { Queue as BullQueue, Worker as BullWorker } from 'bullmq';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';

import { db, withTenantSchema } from '../../shared/database/db.js';
import type { NotificationJobData } from '../notifications/notifications.queue.js';
import { SubscriptionsRepository } from './subscriptions.repository.js';
import { SubscriptionsService } from './subscriptions.service.js';

export const SUBSCRIPTION_MAINTENANCE_QUEUE = 'subscription-maintenance';

type MaintenanceJobData = {
  schemaName?: string;
};

export const createSubscriptionMaintenanceQueue = (connection: Redis): Queue<MaintenanceJobData> =>
  new BullQueue<MaintenanceJobData>(SUBSCRIPTION_MAINTENANCE_QUEUE, { connection });

export const createSubscriptionMaintenanceWorker = (
  connection: Redis,
  notificationsQueue: Queue<NotificationJobData>
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

      const tenants = await db.execute<{ schema_name: string }>(sql`
        SELECT schema_name
        FROM public.tenants
        WHERE schema_name IS NOT NULL
        ORDER BY schema_name
      `);
      for (const { schema_name: schemaName } of tenants.rows) {
        const maintenance = await withTenantSchema(schemaName, async (tenantDb) =>
          new SubscriptionsService(new SubscriptionsRepository(tenantDb)).runDailyMaintenance()
        );
        for (const reminder of maintenance.reminders) {
          await notificationsQueue.add('send-sms', {
            type: 'send-sms',
            to: reminder.parentPhone,
            recipientPhone: reminder.parentPhone,
            message: `La souscription Alertes Parents de ${reminder.studentName} expire le ${reminder.endsAt}. Vous pouvez la renouveler volontairement depuis le service Alertes Parents.`,
            notificationType: 'subscription_expiry_alert',
            schemaName,
            relatedId: reminder.subscriptionId,
            queueRef: `subscription-expiry-${reminder.subscriptionId}`,
          }, {
            jobId: `subscription-expiry-${schemaName}-${reminder.subscriptionId}`,
            removeOnComplete: 100,
            removeOnFail: 100,
          });
        }
      }
    },
    { connection }
  );
