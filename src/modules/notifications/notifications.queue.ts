import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { sql } from 'drizzle-orm';

import { db, withTenantSchema } from '../../shared/database/db.js';
import type { NotificationType } from '../../shared/types/index.js';

import type { NotificationsRepository } from './notifications.repository.js';
import { buildTeacherDailySummarySms } from './notifications.sms.js';

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

export type TeacherDailySummaryJobData = {
  type: 'teacher-daily-summary-all';
  date?: string;
};

export type NotificationJobData =
  | NotificationSmsJobData
  | NotificationEmailJobData
  | TeacherDailySummaryJobData;

type NotificationsWorkerDeps = {
  repository: NotificationsRepository;
  smsSender: SmsSender;
  emailSender: EmailSender;
};

const currentBusinessDate = (): string => new Date().toISOString().slice(0, 10);

const buildQueueRef = (schemaName: string, notificationType: NotificationType, date: string): string => {
  return `notif:${schemaName}:${notificationType}:${date}:daily-teacher-summary`;
};

const listActiveTenantSchemas = async (): Promise<Array<{ id: string; schemaName: string }>> => {
  const result = await db.execute<{ id: string; schema_name: string }>(sql`
    SELECT id::text, schema_name
    FROM public.tenants
    WHERE status IN ('trial', 'active')
    ORDER BY created_at ASC
  `);

  return result.rows.map((row) => ({
    id: row.id,
    schemaName: row.schema_name,
  }));
};

const processTeacherDailySummaryJob = async (
  data: TeacherDailySummaryJobData,
  deps: NotificationsWorkerDeps
): Promise<void> => {
  const date = data.date ?? currentBusinessDate();
  const tenants = await listActiveTenantSchemas();

  for (const tenant of tenants) {
    await withTenantSchema(tenant.schemaName, async (tenantDb) => {
      const context = await deps.repository.getTeacherDailySummaryContext(tenantDb, { date });
      if (!context.directorPhone || context.totalCourses === 0) {
        return;
      }

      const message = buildTeacherDailySummarySms({
        date,
        absentCount: context.absentCount,
        lateCount: context.lateCount,
        presentCount: context.presentCount,
        totalCourses: context.totalCourses,
      });
      const queueRef = buildQueueRef(tenant.schemaName, 'teacher_absent_director', date);

      await deps.repository.insertNotificationLog(tenantDb, {
        type: 'teacher_absent_director',
        recipientPhone: context.directorPhone,
        message,
        status: 'queued',
        providerRef: queueRef,
      });

      const smsResult = await deps.smsSender({
        to: context.directorPhone,
        message,
        type: 'teacher_absent_director',
        schemaName: tenant.schemaName,
      });

      await deps.repository.updateNotificationLogStatus(tenantDb, {
        queueRef,
        status: smsResult.status === 'sent' ? 'sent' : 'failed',
        providerRef: smsResult.providerRef,
        sentAt: smsResult.status === 'sent' ? new Date() : undefined,
      });
    });
  }
};

export const processNotificationJob = async (
  data: NotificationJobData,
  deps: NotificationsWorkerDeps
): Promise<void> => {
  if (data.type === 'teacher-daily-summary-all') {
    await processTeacherDailySummaryJob(data, deps);
    return;
  }

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
