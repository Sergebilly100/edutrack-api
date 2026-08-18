import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { sql } from 'drizzle-orm';

import { db, withTenantSchema } from '../../shared/database/db.js';
import type { NotificationType } from '../../shared/types/index.js';
import { processInBatches } from '../../shared/utils/batch-process.js';

const TENANT_BATCH_SIZE = Number(process.env.NOTIF_TENANT_BATCH_SIZE ?? 10);

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
  parentAccessSentUpdate?: {
    parentId: string;
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

/** Job différé : émis par attendance.service après l'appel élèves, déclenche l'event student.absent après le délai */
export type DeferredStudentAbsentJobData = {
  type: 'deferred-student-absent';
  schemaName: string;
  tenantId: string;
  studentId: string;
  scheduleId: string;
  studentFirstName: string;
  parentPhone: string;
  parentEmail?: string | null;
  subject: string;
  date: string;
  schoolPhone: string;
};

export type NotificationJobData =
  | NotificationSmsJobData
  | NotificationEmailJobData
  | TeacherDailySummaryJobData
  | ValidationDailySummaryJobData
  | DeferredStudentAbsentJobData;

/** ID déterministe pour les jobs d'absence différée - permet l'annulation/mise à jour */
// IMPORTANT : un jobId custom BullMQ NE PEUT PAS contenir ':' (BullMQ lève
// « Custom Id cannot contain : »). On utilise donc '__' comme séparateur. Avec
// ':', notifQueue.add(...) échouait silencieusement (avalé par Promise.allSettled)
// → aucun job différé créé → aucune notification d'absence envoyée.
export const buildDeferredAbsentJobId = (
  schemaName: string,
  scheduleId: string,
  studentId: string,
  date: string
): string => `deferred-absent__${schemaName}__${scheduleId}__${studentId}__${date}`;

export type NotificationsWorkerDeps = {
  repository: NotificationsRepository;
  smsSender: SmsSender;
  emailSender: EmailSender;
  /** Appelé quand un job deferred-student-absent arrive à maturité */
  onDeferredStudentAbsent?: (payload: DeferredStudentAbsentJobData) => void;
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

  await processInBatches(
    tenants,
    TENANT_BATCH_SIZE,
    async (tenant) => {
      await withTenantSchema(tenant.schemaName, async (tenantDb) => {
      const context = await deps.repository.getTeacherDailySummaryContext(tenantDb, { date });
      if (context.totalCourses === 0 || (!context.directorPhone && !context.directorEmail)) {
        return;
      }

      // 'message' (texte SMS) calculé en référence pour les commentaires SMS désactivés.
      void buildTeacherDailySummarySms({
        date,
        absentCount: context.absentCount,
        lateCount: context.lateCount,
        presentCount: context.presentCount,
        totalCourses: context.totalCourses,
      });
      const tasks: Array<Promise<void>> = [];

      // SMS bilan journalier directeur désactivé (décision produit 2026-05) - email + in-app uniquement.
      // Conservé en commentaire pour rétablissement rapide.
      // if (context.directorPhone) {
      //   const queueRef = buildQueueRef(tenant.schemaName, 'teacher_absent_director', date, 'sms');
      //
      //   await deps.repository.insertNotificationLog(tenantDb, {
      //     type: 'teacher_absent_director',
      //     channel: 'sms',
      //     recipientPhone: context.directorPhone,
      //     message,
      //     status: 'queued',
      //     providerRef: queueRef,
      //   });
      //
      //   tasks.push(
      //     deps
      //       .smsSender({
      //         to: context.directorPhone,
      //         message,
      //         type: 'teacher_absent_director',
      //         schemaName: tenant.schemaName,
      //       })
      //       .then((smsResult) =>
      //         deps.repository.updateNotificationLogStatus(tenantDb, {
      //           queueRef,
      //           status: smsResult.status === 'sent' ? 'sent' : 'failed',
      //           providerRef: smsResult.providerRef,
      //           sentAt: smsResult.status === 'sent' ? new Date() : undefined,
      //         })
      //       )
      //       .catch(() =>
      //         deps.repository.updateNotificationLogStatus(tenantDb, {
      //           queueRef,
      //           status: 'failed',
      //         })
      //       )
      //   );
      // }

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
              subject: `[IvoirEdu] Bilan présences du ${date} - ${tenant.schoolName}`,
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
    },
    (tenant, error) => {
      console.error(
        `[notifications] teacher daily summary failed for tenant ${tenant.schemaName}:`,
        error
      );
    }
  );
};

const processValidationDailySummaryJob = async (
  data: ValidationDailySummaryJobData,
  deps: NotificationsWorkerDeps
): Promise<void> => {
  const date = data.date ?? currentBusinessDate();
  const tenants = await listActiveTenantSchemas();

  await processInBatches(
    tenants,
    TENANT_BATCH_SIZE,
    async (tenant) => {
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

      const message = `[IvoirEdu] ${pendingCount} présence(s) en attente de validation. Consultez l'app.`;
      const tasks: Array<Promise<void>> = [];
      // SMS validations horaires en attente désactivé (décision produit 2026-05) - email + in-app uniquement.
      // if (row.director_phone) {
      //   const queueRef = buildQueueRef(tenant.schemaName, 'custom', date, 'sms');
      //
      //   await deps.repository.insertNotificationLog(tenantDb, {
      //     type: 'custom',
      //     channel: 'sms',
      //     recipientPhone: row.director_phone,
      //     message,
      //     status: 'queued',
      //     providerRef: queueRef,
      //   });
      //
      //   tasks.push(
      //     deps
      //       .smsSender({
      //         to: row.director_phone,
      //         message,
      //         type: 'custom',
      //         schemaName: tenant.schemaName,
      //       })
      //       .then((smsResult) =>
      //         deps.repository.updateNotificationLogStatus(tenantDb, {
      //           queueRef,
      //           status: smsResult.status === 'sent' ? 'sent' : 'failed',
      //           providerRef: smsResult.providerRef,
      //           sentAt: smsResult.status === 'sent' ? new Date() : undefined,
      //         })
      //       )
      //       .catch(() =>
      //         deps.repository.updateNotificationLogStatus(tenantDb, {
      //           queueRef,
      //           status: 'failed',
      //         })
      //       )
      //   );
      // }
      void message; // gardé en référence pour le canal in-app
      if (row.director_email) {
        const emailQueueRef = buildQueueRef(tenant.schemaName, 'custom', date, 'email');
        const emailText = `${message}\n\nValidations pendantes :\n${row.pending_details ?? '- Aucun détail disponible'}`;

        await deps.repository.insertNotificationLog(tenantDb, {
          type: 'custom',
          channel: 'email',
          recipientPhone: row.director_phone ?? '',
          recipientEmail: row.director_email,
          message: emailText,
          status: 'queued',
          providerRef: emailQueueRef,
        });

        tasks.push(
          deps
            .emailSender({
              to: row.director_email,
              subject: '[IvoirEdu] Validations horaires en attente',
              text: emailText,
              type: 'custom',
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
    },
    (tenant, error) => {
      console.error(
        `[notifications] validation daily summary failed for tenant ${tenant.schemaName}:`,
        error
      );
    }
  );
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
    await processValidationDailySummaryJob(data, deps);
    return;
  }

  if (data.type === 'deferred-student-absent') {
    deps.onDeferredStudentAbsent?.(data);
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
        if (data.parentAccessSentUpdate) {
          await tenantDb.execute(sql`
            UPDATE parents
            SET access_sent_at = NOW()
            WHERE id = ${data.parentAccessSentUpdate.parentId}::uuid
          `);
          // Le SMS doit contenir le secret le temps de son traitement/retry,
          // mais il n'a plus à rester en clair dans l'historique après succès.
          await tenantDb.execute(sql`
            UPDATE notifications_log
            SET message = '[Identifiants parent envoyes]'
            WHERE provider_ref = ${smsResult.providerRef ?? data.queueRef}
              AND related_id = ${data.parentAccessSentUpdate.parentId}::uuid
              AND type = 'parent_access_credentials'
          `);
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
  const concurrency = Number(process.env.NOTIF_WORKER_CONCURRENCY ?? 10);
  const limiterMax = Number(process.env.NOTIF_WORKER_LIMITER_MAX ?? 10);
  const limiterDuration = Number(process.env.NOTIF_WORKER_LIMITER_DURATION_MS ?? 1_000);
  return new Worker<NotificationJobData>(
    NOTIFICATIONS_QUEUE_NAME,
    async (job: Job<NotificationJobData>) => {
      await processNotificationJob(job.data, deps);
    },
    {
      connection,
      concurrency,
      limiter: { max: limiterMax, duration: limiterDuration },
    }
  );
};
