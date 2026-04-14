import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';

import { withTenantSchema } from '../../shared/database/db.js';
import type { NotificationType } from '../../shared/types/index.js';

import type { NotificationsRepository } from './notifications.repository.js';

export const NOTIFICATIONS_QUEUE_NAME = 'notifications-sms';

export type SmsResult = {
  status: 'sent' | 'failed';
  providerRef?: string;
  errorMessage?: string;
};

export type SmsSender = (params: {
  to: string;
  message: string;
  type: NotificationType;
  schemaName: string;
}) => Promise<SmsResult>;

export type NotificationSmsJobData = {
  type: 'send-sms';
  to: string;
  message: string;
  notificationType: NotificationType;
  schemaName: string;
  relatedId?: string;
  recipientPhone: string;
  queueRef: string;
  qrAlertSentUpdate?: {
    teacherId: string;
    scheduleId: string;
    date: string;
  };
};

type NotificationsWorkerDeps = {
  repository: NotificationsRepository;
  smsSender: SmsSender;
};

export const processSendSmsJob = async (
  data: NotificationSmsJobData,
  deps: NotificationsWorkerDeps
): Promise<void> => {
  await withTenantSchema(data.schemaName, async (tenantDb) => {
    try {
      const smsResult = await deps.smsSender({
        to: data.to,
        message: data.message,
        type: data.notificationType,
        schemaName: data.schemaName,
      });

      if (smsResult.status !== 'sent') {
        await deps.repository.updateNotificationLogStatus(tenantDb, {
          queueRef: data.queueRef,
          status: 'failed',
        });
        return;
      }

      await deps.repository.updateNotificationLogStatus(tenantDb, {
        queueRef: data.queueRef,
        status: 'sent',
        providerRef: smsResult.providerRef,
        sentAt: new Date(),
      });

      if (data.qrAlertSentUpdate) {
        await deps.repository.markQrAlertSent(tenantDb, data.qrAlertSentUpdate);
      }
    } catch (error) {
      await deps.repository.updateNotificationLogStatus(tenantDb, {
        queueRef: data.queueRef,
        status: 'failed',
      });
      throw error;
    }
  });
};

export const createNotificationsQueue = (connection: Redis): Queue<NotificationSmsJobData> => {
  return new Queue<NotificationSmsJobData>(NOTIFICATIONS_QUEUE_NAME, {
    connection,
  });
};

export const createNotificationsWorker = (
  connection: Redis,
  deps: NotificationsWorkerDeps
): Worker<NotificationSmsJobData> => {
  return new Worker<NotificationSmsJobData>(
    NOTIFICATIONS_QUEUE_NAME,
    async (job: Job<NotificationSmsJobData>) => {
      await processSendSmsJob(job.data, deps);
    },
    {
      connection,
    }
  );
};
