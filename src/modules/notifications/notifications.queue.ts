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

export type EmailResult = {
  status: 'sent' | 'failed';
  providerRef?: string;
  errorMessage?: string;
};

export type EmailSender = (params: {
  to: string;
  subject: string;
  text: string;
  type: NotificationType;
  schemaName: string;
}) => Promise<EmailResult>;

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

export type NotificationEmailJobData = {
  type: 'send-email';
  to: string;
  subject: string;
  text: string;
  notificationType: NotificationType;
  schemaName: string;
  relatedId?: string;
  recipientPhone: string;
  recipientEmail: string;
  queueRef: string;
};

export type NotificationJobData = NotificationSmsJobData | NotificationEmailJobData;

type NotificationsWorkerDeps = {
  repository: NotificationsRepository;
  smsSender: SmsSender;
  emailSender: EmailSender;
};

export const processNotificationJob = async (
  data: NotificationJobData,
  deps: NotificationsWorkerDeps
): Promise<void> => {
  await withTenantSchema(data.schemaName, async (tenantDb) => {
    try {
      if (data.type === 'send-sms') {
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
        return;
      }

      const emailResult = await deps.emailSender({
        to: data.to,
        subject: data.subject,
        text: data.text,
        type: data.notificationType,
        schemaName: data.schemaName,
      });
      if (emailResult.status !== 'sent') {
        await deps.repository.updateNotificationLogStatus(tenantDb, {
          queueRef: data.queueRef,
          status: 'failed',
        });
        return;
      }

      await deps.repository.updateNotificationLogStatus(tenantDb, {
        queueRef: data.queueRef,
        status: 'sent',
        providerRef: emailResult.providerRef,
        sentAt: new Date(),
      });
    } catch (error) {
      await deps.repository.updateNotificationLogStatus(tenantDb, {
        queueRef: data.queueRef,
        status: 'failed',
      });
      throw error;
    }
  });
};

export const createNotificationsQueue = (connection: Redis): Queue<NotificationJobData> => {
  return new Queue<NotificationJobData>(NOTIFICATIONS_QUEUE_NAME, {
    connection,
  });
};

export const createNotificationsWorker = (
  connection: Redis,
  deps: NotificationsWorkerDeps
): Worker<NotificationJobData> => {
  return new Worker<NotificationJobData>(
    NOTIFICATIONS_QUEUE_NAME,
    async (job: Job<NotificationJobData>) => {
      await processNotificationJob(job.data, deps);
    },
    {
      connection,
    }
  );
};
