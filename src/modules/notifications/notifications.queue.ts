import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { sql } from 'drizzle-orm';

import { db, withTenantSchema } from '../../shared/database/db.js';
import type { NotificationType } from '../../shared/types/index.js';

import type { NotificationsRepository } from './notifications.repository.js';
import {
  buildTeacherDailySummaryEmailText,
  buildTeacherDailySummarySms,
} from './notifications.sms.js';

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

export type ValidationDailySummaryJobData = {
  type: 'validation-daily-summary-all';
  date?: string;
};

export type NotificationJobData =
  | NotificationSmsJobData
  | NotificationEmailJobData
  | TeacherDailySummaryJobData
  | ValidationDailySummaryJobData;

type NotificationsWorkerDeps = {
  repository: NotificationsRepository;
  smsSender: SmsSender;
  emailSender: EmailSender;
};

const currentBusinessDate = (): string => new Date().toISOString().slice(0, 10);

const buildQueueRef = (
  schemaName: string,
  notificationType: NotificationType,
  date: string,
  channel: 'sms' | 'email' = 'sms'
): string => {
  return `notif:${schemaName}:${notificationType}:${date}:daily-teacher-summary:${channel}`;
};

const listActiveTenantSchemas = async (): Promise<
  Array<{ id: string; schemaName: string; schoolName: string }>
> => {
  const result = await db.execute<{ id: string; schema_name: string; name: string }>(sql`
    SELECT id::text, schema_name, name
    FROM public.tenants
    WHERE status IN ('trial', 'active')
    ORDER BY created_at ASC
  `);

  return result.rows.map((row) => ({
    id: row.id,
    schemaName: row.schema_name,
    schoolName: row.name,
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
      if (context.totalCourses === 0 || (!context.directorPhone && !context.directorEmail)) {
        return;
      }

      const message = buildTeacherDailySummarySms({
        date,
        absentCount: context.absentCount,
        lateCount: context.lateCount,
        presentCount: context.presentCount,
        totalCourses: context.totalCourses,
      });
      const tasks: Array<Promise<void>> = [];

      if (context.directorPhone) {
        const queueRef = buildQueueRef(tenant.schemaName, 'teacher_absent_director', date, 'sms');

        await deps.repository.insertNotificationLog(tenantDb, {
          type: 'teacher_absent_director',
          channel: 'sms',
          recipientPhone: context.directorPhone,
          message,
          status: 'queued',
          providerRef: queueRef,
        });

        tasks.push(
          deps
            .smsSender({
              to: context.directorPhone,
              message,
              type: 'teacher_absent_director',
              schemaName: tenant.schemaName,
            })
            .then((smsResult) =>
              deps.repository.updateNotificationLogStatus(tenantDb, {
                queueRef,
                status: smsResult.status === 'sent' ? 'sent' : 'failed',
                providerRef: smsResult.providerRef,
                sentAt: smsResult.status === 'sent' ? new Date() : undefined,
              })
            )
            .catch(() =>
              deps.repository.updateNotificationLogStatus(tenantDb, {
                queueRef,
                status: 'failed',
              })
            )
        );
      }

      if (context.directorEmail) {
        const emailQueueRef = buildQueueRef(
          tenant.schemaName,
          'teacher_absent_director',
          date,
          'email'
        );
        const emailText = buildTeacherDailySummaryEmailText({
          schoolName: tenant.schoolName,
          date,
          absentCount: context.absentCount,
          lateCount: context.lateCount,
          presentCount: context.presentCount,
          totalCourses: context.totalCourses,
        });

        await deps.repository.insertNotificationLog(tenantDb, {
          type: 'teacher_absent_director',
          channel: 'email',
          recipientPhone: context.directorPhone ?? '',
          recipientEmail: context.directorEmail,
          message: emailText,
          status: 'queued',
          providerRef: emailQueueRef,
        });

        tasks.push(
          deps
            .emailSender({
              to: context.directorEmail,
              subject: `[EduTrack] Bilan présences du ${date} — ${tenant.schoolName}`,
              text: emailText,
              type: 'teacher_absent_director',
              schemaName: tenant.schemaName,
            })
            .then((emailResult) =>
              deps.repository.updateNotificationLogStatus(tenantDb, {
                queueRef: emailQueueRef,
                status: emailResult.status === 'sent' ? 'sent' : 'failed',
                providerRef: emailResult.providerRef,
                sentAt: emailResult.status === 'sent' ? new Date() : undefined,
              })
            )
            .catch(() =>
              deps.repository.updateNotificationLogStatus(tenantDb, {
                queueRef: emailQueueRef,
                status: 'failed',
              })
            )
        );
      }

      await Promise.all(tasks);
    });
  }
};

const processValidationDailySummaryJob = async (
  deps: NotificationsWorkerDeps
): Promise<void> => {
  const tenants = await listActiveTenantSchemas();

  for (const tenant of tenants) {
    await withTenantSchema(tenant.schemaName, async (tenantDb) => {
      const result = await tenantDb.execute<{
        director_phone: string | null;
        director_email: string | null;
        pending_count: number;
        pending_details: string | null;
      }>(sql`
        SELECT
          d.phone AS director_phone,
          d.email AS director_email,
          COUNT(at.id)::int AS pending_count,
          STRING_AGG(
            CONCAT(
              '- ',
              u.name,
              ' / ',
              s.subject,
              ' / ',
              at.date::text,
              ' / ',
              CASE
                WHEN at.geo_status = 'suspicious' THEN 'GPS suspect'
                WHEN at.actual_minutes IS NOT NULL THEN CONCAT('Heures courtes: ', at.actual_minutes::int, ' min')
                ELSE 'Validation requise'
              END
            ),
            E'\n'
            ORDER BY at.date DESC, u.name ASC
          ) AS pending_details
        FROM attendances_teacher at
        INNER JOIN teachers t ON t.id = at.teacher_id
        INNER JOIN users u ON u.id = t.user_id
        INNER JOIN schedules s ON s.id = at.schedule_id
        LEFT JOIN LATERAL (
          SELECT u.phone, u.email
          FROM users u
          WHERE u.role = 'director'
            AND u.is_active = true
            AND (u.phone IS NOT NULL OR u.email IS NOT NULL)
          ORDER BY u.created_at ASC
          LIMIT 1
        ) d ON true
        WHERE at.validation_status = 'pending'
        GROUP BY d.phone, d.email
      `);
      const row = result.rows[0];
      const pendingCount = Number(row?.pending_count ?? 0);
      if (pendingCount <= 0 || (!row?.director_phone && !row?.director_email)) {
        return;
      }

      const message = `[EduTrack] ${pendingCount} présence(s) en attente de validation. Consultez l'app.`;
      const tasks: Array<Promise<void>> = [];
      if (row.director_phone) {
        tasks.push(
          deps.smsSender({
            to: row.director_phone,
            message,
            type: 'custom',
            schemaName: tenant.schemaName,
          }).then(() => undefined)
        );
      }
      if (row.director_email) {
        const emailText = `${message}\n\nValidations pendantes :\n${row.pending_details ?? '- Aucun détail disponible'}`;
        tasks.push(
          deps.emailSender({
            to: row.director_email,
            subject: '[EduTrack] Validations horaires en attente',
            text: emailText,
            type: 'custom',
            schemaName: tenant.schemaName,
          }).then(() => undefined)
        );
      }
      await Promise.all(tasks);
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

  if (data.type === 'validation-daily-summary-all') {
    await processValidationDailySummaryJob(deps);
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
