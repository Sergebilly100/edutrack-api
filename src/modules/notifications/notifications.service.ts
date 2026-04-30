import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { db, withTenantSchema } from '../../shared/database/db.js';
import { off as defaultOff, on as defaultOn } from '../../shared/events/event-bus.js';
import type {
  EventMap,
  StudentAbsentPayload,
  SubscriptionExpiredPayload,
  TeacherLatePayload,
  TeacherQrAlertPayload,
} from '../../shared/events/events.types.js';
import type { NotificationType } from '../../shared/types/index.js';

import type {
  NotificationEmailJobData,
  NotificationJobData,
  NotificationSmsJobData,
  SmsSender,
  EmailSender,
} from './notifications.queue.js';
import {
  buildTeacherLateSms,
  buildTeacherQrAlertSms,
  renderSmsTemplate,
} from './notifications.sms.js';
import {
  defaultRepository,
  type NotificationsRepository,
  type TenantDbLike,
} from './notifications.repository.js';
import { SubscriptionsRepository } from '../subscriptions/subscriptions.repository.js';
import { SubscriptionsService } from '../subscriptions/subscriptions.service.js';

type NotificationsServiceDeps = {
  withTenantSchema: <T>(
    schemaName: string,
    callback: (tenantDb: TenantDbLike) => Promise<T>
  ) => Promise<T>;
  eventBus: {
    on: <K extends keyof Pick<EventMap, 'teacher.late' | 'teacher.qr_alert' | 'student.absent' | 'subscription.expired'>>(
      event: K,
      handler: (payload: EventMap[K]) => void
    ) => void;
    off: <K extends keyof Pick<EventMap, 'teacher.late' | 'teacher.qr_alert' | 'student.absent' | 'subscription.expired'>>(
      event: K,
      handler: (payload: EventMap[K]) => void
    ) => void;
  };
  repository: NotificationsRepository;
  smsQueue: Queue<NotificationJobData>;
};

const defaultDeps = {
  withTenantSchema,
  eventBus: {
    on: defaultOn,
    off: defaultOff,
  },
  repository: defaultRepository,
};

type SmsPlatformRuntimeConfig = {
  provider: 'mock' | 'infobip' | 'twilio' | 'orange_api' | 'custom';
  apiBaseUrl: string | null;
  apiKey: string | null;
  senderId: string;
  smsMaintenanceMode: boolean;
  smsMaintenanceMessage: string;
};

let smsConfigCache: { fetchedAt: number; value: SmsPlatformRuntimeConfig } | null = null;

const SMS_TEMPLATE_STUDENT_ABSENT_TYPE = 'student_absent_parent';
const SMS_TEMPLATE_PAYMENT_REMINDER_TYPE = 'payment_reminder';

const DEFAULT_STUDENT_ABSENT_TEMPLATE =
  'EduTrack: {studentFirstName} absent(e) en {subject} le {date}. Contact école: {schoolPhone}';
const DEFAULT_PAYMENT_REMINDER_TEMPLATE =
  'EduTrack: relance paiement {schoolName}. Échéance {dueDate}, période {periodLabel}, reste {remainingAmountFcfa} FCFA.';
const DEFAULT_STUDENT_ABSENT_EMAIL_SUBJECT = 'Absence élève — EduTrack';
const DEFAULT_STUDENT_ABSENT_EMAIL_TEMPLATE =
  '{studentFirstName} est absent(e) en {subject} le {date}. Contact école: {schoolPhone}.';

const loadSmsPlatformConfig = async (): Promise<SmsPlatformRuntimeConfig> => {
  const now = Date.now();
  if (smsConfigCache && now - smsConfigCache.fetchedAt < 15_000) {
    return smsConfigCache.value;
  }

  const result = await db.execute<{
    sms_provider: SmsPlatformRuntimeConfig['provider'] | null;
    sms_api_base_url: string | null;
    sms_api_key: string | null;
    sms_sender_id: string | null;
    sms_maintenance_mode: boolean | null;
    sms_maintenance_message: string | null;
  }>(sql.raw(`
    SELECT
      sms_provider,
      sms_api_base_url,
      sms_api_key,
      sms_sender_id,
      sms_maintenance_mode,
      sms_maintenance_message
    FROM public.app_settings
    ORDER BY updated_at DESC
    LIMIT 1
  `));

  const row = result.rows?.[0];
  const value: SmsPlatformRuntimeConfig = {
    provider: row?.sms_provider ?? 'mock',
    apiBaseUrl: row?.sms_api_base_url ?? null,
    apiKey: row?.sms_api_key ?? null,
    senderId: row?.sms_sender_id ?? 'EduTrack',
    smsMaintenanceMode: row?.sms_maintenance_mode ?? false,
    smsMaintenanceMessage: row?.sms_maintenance_message ?? 'Service SMS en maintenance',
  };
  smsConfigCache = { fetchedAt: now, value };
  return value;
};

const resolveSmsTemplateMessage = async (
  schemaName: string,
  type: typeof SMS_TEMPLATE_STUDENT_ABSENT_TYPE | typeof SMS_TEMPLATE_PAYMENT_REMINDER_TYPE,
  fallbackTemplate: string
): Promise<string> => {
  try {
    const tenantResult = await db.execute<{ id: string }>(sql`
      SELECT id::text
      FROM public.tenants
      WHERE schema_name = ${schemaName}
      LIMIT 1
    `);
    const tenantId = tenantResult.rows?.[0]?.id;
    if (!tenantId) {
      return fallbackTemplate;
    }

    const templateResult = await db.execute<{ message_template: string }>(sql`
      SELECT message_template
      FROM public.sms_templates
      WHERE type = ${type}
        AND (tenant_id = ${tenantId}::uuid OR tenant_id IS NULL)
      ORDER BY
        CASE WHEN tenant_id = ${tenantId}::uuid THEN 0 ELSE 1 END,
        updated_at DESC
      LIMIT 1
    `);

    return templateResult.rows?.[0]?.message_template ?? fallbackTemplate;
  } catch {
    return fallbackTemplate;
  }
};

const sendInfobipSms = async (params: {
  to: string;
  message: string;
  config: SmsPlatformRuntimeConfig;
}): Promise<{ status: 'sent' | 'failed'; providerRef?: string; errorMessage?: string }> => {
  const apiBaseUrl = params.config.apiBaseUrl?.trim();
  const apiKey = params.config.apiKey?.trim();
  if (!apiBaseUrl || !apiKey) {
    return { status: 'failed', errorMessage: 'Missing Infobip API base URL or API key' };
  }

  const endpoint = `${apiBaseUrl.replace(/\/+$/, '')}/sms/2/text/advanced`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `App ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      messages: [
        {
          from: params.config.senderId,
          destinations: [{ to: params.to }],
          text: params.message,
        },
      ],
    }),
  });

  const payload = await response.json().catch(() => ({} as Record<string, unknown>));
  if (!response.ok) {
    return { status: 'failed', errorMessage: `Infobip error (${response.status})` };
  }

  const providerRef =
    (payload as { messages?: Array<{ messageId?: string }> }).messages?.[0]?.messageId ??
    randomUUID();

  return { status: 'sent', providerRef };
};

export const defaultSmsSender: SmsSender = async ({ to, message, type, schemaName }) => {
  const config = await loadSmsPlatformConfig();

  if (config.smsMaintenanceMode) {
    return {
      status: 'failed',
      errorMessage: config.smsMaintenanceMessage,
    };
  }

  const isMock = config.provider === 'mock' || (process.env.SMS_MOCK ?? 'false').toLowerCase() === 'true';

  if (isMock) {
    console.info(`[sms][mock] schema=${schemaName} type=${type} ref=mock`);
    return {
      status: 'sent',
      providerRef: 'mock',
    };
  }

  if (config.provider === 'infobip') {
    return sendInfobipSms({
      to,
      message,
      config,
    });
  }

  console.error(`[notifications] SMS provider not implemented: ${config.provider}`);
  return { status: 'failed', errorMessage: `SMS provider not implemented: ${config.provider}` };
};

const sendResendEmail = async (params: {
  to: string;
  subject: string;
  text: string;
}): Promise<{ status: 'sent' | 'failed'; providerRef?: string; errorMessage?: string }> => {
  const apiKey = process.env.EMAIL_RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim();
  if (!apiKey || !from) {
    return { status: 'failed', errorMessage: 'Missing EMAIL_RESEND_API_KEY or EMAIL_FROM' };
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [params.to],
      subject: params.subject,
      text: params.text,
    }),
  });
  const payload = (await response.json().catch(() => ({} as Record<string, unknown>))) as {
    id?: string;
  };
  if (!response.ok) {
    return { status: 'failed', errorMessage: `Resend error (${response.status})` };
  }
  return { status: 'sent', providerRef: payload.id ?? randomUUID() };
};

export const defaultEmailSender: EmailSender = async ({ to, subject, text }) => {
  const provider = (process.env.EMAIL_PROVIDER ?? 'mock').trim().toLowerCase();
  const mockEnabled = (process.env.EMAIL_MOCK ?? 'true').toLowerCase() === 'true';
  if (provider === 'mock' || mockEnabled) {
    console.info(`[email][mock] to=${to}`);
    return { status: 'sent', providerRef: 'mock-email' };
  }
  if (provider === 'resend') {
    return sendResendEmail({ to, subject, text });
  }
  return { status: 'failed', errorMessage: `Email provider not implemented: ${provider}` };
};

const buildQueueRef = (schemaName: string, notificationType: NotificationType): string => {
  return `notif:${schemaName}:${notificationType}:${randomUUID()}`;
};

const toSmsJobData = (params: {
  queueRef: string;
  to: string;
  message: string;
  notificationType: NotificationType;
  schemaName: string;
  relatedId?: string;
  qrAlertSentUpdate?: {
    teacherId: string;
    scheduleId: string;
    date: string;
  };
}): NotificationSmsJobData => {
  return {
    type: 'send-sms',
    to: params.to,
    message: params.message,
    notificationType: params.notificationType,
    schemaName: params.schemaName,
    relatedId: params.relatedId,
    recipientPhone: params.to,
    queueRef: params.queueRef,
    qrAlertSentUpdate: params.qrAlertSentUpdate,
  };
};

const toEmailJobData = (params: {
  queueRef: string;
  to: string;
  subject: string;
  text: string;
  recipientPhone: string;
  notificationType: NotificationType;
  schemaName: string;
  relatedId?: string;
}): NotificationEmailJobData => {
  return {
    type: 'send-email',
    to: params.to,
    subject: params.subject,
    text: params.text,
    notificationType: params.notificationType,
    schemaName: params.schemaName,
    relatedId: params.relatedId,
    recipientPhone: params.recipientPhone,
    recipientEmail: params.to,
    queueRef: params.queueRef,
  };
};

const toQrNotificationType = (alertType: TeacherQrAlertPayload['alertType']): NotificationType => {
  if (alertType === 'teacher_qr_mismatch') return 'teacher_qr_mismatch';
  if (alertType === 'teacher_qr_missing_scan') return 'teacher_qr_missing_scan';
  if (alertType === 'teacher_qr_scan_out_of_time') return 'teacher_qr_scan_out_of_time';
  // alertType exhaustif selon le type union — ce cas ne devrait jamais arriver.
  console.warn(`[notifications] alertType inattendu: ${String(alertType)}`);
  return 'teacher_qr_scan_out_of_time';
};

export class NotificationsService {
  private readonly deps: Omit<NotificationsServiceDeps, 'smsQueue'> & {
    smsQueue: Queue<NotificationJobData>;
    emailSender: EmailSender;
  };

  constructor(deps: Partial<Omit<NotificationsServiceDeps, 'smsQueue'>> & {
    smsQueue: Queue<NotificationJobData>;
    emailSender?: EmailSender;
  }) {
    this.deps = {
      ...defaultDeps,
      ...deps,
      eventBus: {
        ...defaultDeps.eventBus,
        ...(deps.eventBus ?? {}),
      },
      emailSender: deps.emailSender ?? defaultEmailSender,
    };
  }

  private readonly teacherLateListener = (payload: EventMap['teacher.late']): void => {
    void this.handleTeacherLate(payload).catch((error) => {
      console.error('[notifications] failed to process teacher.late', error);
    });
  };

  private readonly teacherQrAlertListener = (payload: EventMap['teacher.qr_alert']): void => {
    void this.handleTeacherQrAlert(payload).catch((error) => {
      console.error('[notifications] failed to process teacher.qr_alert', error);
    });
  };

  private readonly studentAbsentListener = (payload: EventMap['student.absent']): void => {
    void this.handleStudentAbsent(payload).catch((error) => {
      console.error('[notifications] failed to process student.absent', error);
    });
  };

  private readonly subscriptionExpiredListener = (
    payload: EventMap['subscription.expired']
  ): void => {
    void this.handleSubscriptionExpired(payload).catch((error) => {
      console.error('[notifications] failed to process subscription.expired', error);
    });
  };

  start(): void {
    this.deps.eventBus.on('teacher.late', this.teacherLateListener);
    this.deps.eventBus.on('teacher.qr_alert', this.teacherQrAlertListener);
    this.deps.eventBus.on('student.absent', this.studentAbsentListener);
    this.deps.eventBus.on('subscription.expired', this.subscriptionExpiredListener);
  }

  stop(): void {
    this.deps.eventBus.off('teacher.late', this.teacherLateListener);
    this.deps.eventBus.off('teacher.qr_alert', this.teacherQrAlertListener);
    this.deps.eventBus.off('student.absent', this.studentAbsentListener);
    this.deps.eventBus.off('subscription.expired', this.subscriptionExpiredListener);
  }

  async handleTeacherLate(payload: TeacherLatePayload): Promise<void> {
    await this.deps.withTenantSchema(payload.schemaName, async (tenantDb) => {
      const context = await this.deps.repository.getLateAlertContext(tenantDb, payload);
      if (!context?.directorPhone) {
        return;
      }

      const message = buildTeacherLateSms({
        teacherName: context.teacherName,
        lateMinutes: payload.lateMinutes,
        subject: context.subject,
        className: context.className,
        slotLabel: context.slotLabel,
        date: payload.date,
      });

      const queueRef = buildQueueRef(payload.schemaName, 'teacher_late_director');

      await this.deps.smsQueue.add(
        'send-sms',
        toSmsJobData({
          queueRef,
          to: context.directorPhone,
          message,
          notificationType: 'teacher_late_director',
          schemaName: payload.schemaName,
          relatedId: payload.scheduleId,
        }),
        {
          jobId: queueRef,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: true,
          removeOnFail: true,
        }
      );

      await this.deps.repository.insertNotificationLog(tenantDb, {
        type: 'teacher_late_director',
        recipientPhone: context.directorPhone,
        message,
        status: 'queued',
        providerRef: queueRef,
        relatedId: payload.scheduleId,
      });
    });
  }

  async handleTeacherQrAlert(payload: TeacherQrAlertPayload): Promise<void> {
    await this.deps.withTenantSchema(payload.schemaName, async (tenantDb) => {
      const context = await this.deps.repository.getQrAlertContext(tenantDb, payload);
      if (!context?.directorPhone) {
        return;
      }

      const notificationType = toQrNotificationType(payload.alertType);

      const message = buildTeacherQrAlertSms(payload.alertType, {
        teacherName: context.teacherName,
        scannedRoom: context.scannedRoom,
        expectedRoom: context.expectedRoom,
        subject: context.subject,
        className: context.className,
        date: payload.date,
        slotLabel: context.slotLabel,
      });

      const queueRef = buildQueueRef(payload.schemaName, notificationType);

      await this.deps.smsQueue.add(
        'send-sms',
        toSmsJobData({
          queueRef,
          to: context.directorPhone,
          message,
          notificationType,
          schemaName: payload.schemaName,
          relatedId: payload.scheduleId,
          qrAlertSentUpdate: {
            teacherId: payload.teacherId,
            scheduleId: payload.scheduleId,
            date: payload.date,
          },
        }),
        {
          jobId: queueRef,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: true,
          removeOnFail: true,
        }
      );

      await this.deps.repository.insertNotificationLog(tenantDb, {
        type: notificationType,
        recipientPhone: context.directorPhone,
        message,
        status: 'queued',
        providerRef: queueRef,
        relatedId: payload.scheduleId,
      });
    });
  }

  async handleStudentAbsent(payload: StudentAbsentPayload): Promise<void> {
    await this.deps.withTenantSchema(payload.schemaName, async (tenantDb) => {
      const subscriptionsService = new SubscriptionsService(
        new SubscriptionsRepository(tenantDb as NodePgDatabase<Record<string, unknown>>)
      );
      const canSend = await subscriptionsService
        .canSendNotification({
          studentId: payload.studentId,
          tenantId: payload.tenantId,
          schemaName: payload.schemaName,
          type: 'sms',
        })
        .catch(() => ({
          allowed: true as const,
          subscriptionId: '',
          parentPhone: payload.parentPhone,
          parentEmail: null,
        }));
      if (!canSend.allowed) {
        await this.deps.repository.insertNotificationLog(tenantDb, {
          type: 'student_absent_parent',
          channel: 'sms',
          recipientPhone: payload.parentPhone,
          message: '',
          status:
            canSend.reason === 'feature_disabled'
              ? 'skipped_feature_disabled'
              : canSend.reason === 'cap_reached'
                ? 'skipped_cap_reached'
                : canSend.reason === 'subscription_expired'
                  ? 'skipped_subscription_expired'
                  : 'skipped_no_active_subscription',
          relatedId: payload.scheduleId,
        });
        await this.deps.repository.insertNotificationLog(tenantDb, {
          type: 'student_absent_parent',
          channel: 'email',
          recipientPhone: payload.parentPhone,
          message: '',
          status:
            canSend.reason === 'feature_disabled'
              ? 'skipped_feature_disabled'
              : canSend.reason === 'subscription_expired'
                ? 'skipped_subscription_expired'
                : 'skipped_no_active_subscription',
          relatedId: payload.scheduleId,
        });
        return;
      }

      const template = await resolveSmsTemplateMessage(
        payload.schemaName,
        SMS_TEMPLATE_STUDENT_ABSENT_TYPE,
        DEFAULT_STUDENT_ABSENT_TEMPLATE
      );
      const message = renderSmsTemplate(template, {
        studentFirstName: payload.studentFirstName,
        subject: payload.subject,
        date: payload.date,
        schoolPhone: payload.schoolPhone,
      });

      const queueRef = buildQueueRef(payload.schemaName, 'student_absent_parent');

      await this.deps.smsQueue.add(
        'send-sms',
        toSmsJobData({
          queueRef,
          to: payload.parentPhone,
          message,
          notificationType: 'student_absent_parent',
          schemaName: payload.schemaName,
          relatedId: payload.scheduleId,
        }),
        {
          jobId: queueRef,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: true,
          removeOnFail: true,
        }
      );

      await this.deps.repository.insertNotificationLog(tenantDb, {
        type: 'student_absent_parent',
        channel: 'sms',
        recipientPhone: canSend.parentPhone ?? payload.parentPhone,
        message,
        status: 'queued',
        providerRef: queueRef,
        relatedId: payload.scheduleId,
      });
      if (canSend.subscriptionId) {
        await subscriptionsService.incrementUsage({
          studentId: payload.studentId,
          subscriptionId: canSend.subscriptionId,
          type: 'sms',
        });
      }

      const emailAddress = canSend.parentEmail;
      if (!emailAddress) {
        await this.deps.repository.insertNotificationLog(tenantDb, {
          type: 'student_absent_parent',
          channel: 'email',
          recipientPhone: canSend.parentPhone ?? payload.parentPhone,
          message: '',
          status: 'skipped_unknown',
          relatedId: payload.scheduleId,
        });
        return;
      }

      const canSendEmail = await subscriptionsService
        .canSendNotification({
          studentId: payload.studentId,
          tenantId: payload.tenantId,
          schemaName: payload.schemaName,
          type: 'email',
        })
        .catch(() => ({
          allowed: true as const,
          subscriptionId: canSend.subscriptionId,
          parentPhone: canSend.parentPhone,
          parentEmail: emailAddress,
        }));

      if (!canSendEmail.allowed) {
        await this.deps.repository.insertNotificationLog(tenantDb, {
          type: 'student_absent_parent',
          channel: 'email',
          recipientPhone: canSend.parentPhone ?? payload.parentPhone,
          recipientEmail: emailAddress,
          message: '',
          status:
            canSendEmail.reason === 'feature_disabled'
              ? 'skipped_feature_disabled'
              : canSendEmail.reason === 'subscription_expired'
                ? 'skipped_subscription_expired'
                : 'skipped_no_active_subscription',
          relatedId: payload.scheduleId,
        });
        return;
      }

      const emailText = renderSmsTemplate(DEFAULT_STUDENT_ABSENT_EMAIL_TEMPLATE, {
        studentFirstName: payload.studentFirstName,
        subject: payload.subject,
        date: payload.date,
        schoolPhone: payload.schoolPhone,
      });
      const emailQueueRef = buildQueueRef(payload.schemaName, 'student_absent_parent');

      await this.deps.smsQueue.add(
        'send-email',
        toEmailJobData({
          queueRef: emailQueueRef,
          to: emailAddress,
          subject: DEFAULT_STUDENT_ABSENT_EMAIL_SUBJECT,
          text: emailText,
          recipientPhone: canSend.parentPhone ?? payload.parentPhone,
          notificationType: 'student_absent_parent',
          schemaName: payload.schemaName,
          relatedId: payload.scheduleId,
        }),
        {
          jobId: emailQueueRef,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: true,
          removeOnFail: true,
        }
      );

      await this.deps.repository.insertNotificationLog(tenantDb, {
        type: 'student_absent_parent',
        channel: 'email',
        recipientPhone: canSend.parentPhone ?? payload.parentPhone,
        recipientEmail: emailAddress,
        message: emailText,
        status: 'queued',
        providerRef: emailQueueRef,
        relatedId: payload.scheduleId,
      });
      if (canSendEmail.subscriptionId) {
        await subscriptionsService.incrementUsage({
          studentId: payload.studentId,
          subscriptionId: canSendEmail.subscriptionId,
          type: 'email',
        });
      }
    });
  }

  async handleSubscriptionExpired(payload: SubscriptionExpiredPayload): Promise<void> {
    await this.deps.withTenantSchema(payload.schemaName, async (tenantDb) => {
      const template = await resolveSmsTemplateMessage(
        payload.schemaName,
        SMS_TEMPLATE_PAYMENT_REMINDER_TYPE,
        DEFAULT_PAYMENT_REMINDER_TEMPLATE
      );
      const formattedAmount = new Intl.NumberFormat('fr-FR', {
        maximumFractionDigits: 0,
      }).format(Math.max(0, payload.remainingAmountFcfa));
      const message = renderSmsTemplate(template, {
        schoolName: payload.schoolName,
        periodLabel: payload.periodLabel,
        dueDate: payload.dueDate,
        remainingAmountFcfa: formattedAmount,
      });

      const queueRef = buildQueueRef(payload.schemaName, 'payment_reminder');

      await this.deps.smsQueue.add(
        'send-sms',
        toSmsJobData({
          queueRef,
          to: payload.directorPhone,
          message,
          notificationType: 'payment_reminder',
          schemaName: payload.schemaName,
        }),
        {
          jobId: queueRef,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: true,
          removeOnFail: true,
        }
      );

      await this.deps.repository.insertNotificationLog(tenantDb, {
        type: 'payment_reminder',
        recipientPhone: payload.directorPhone,
        message,
        status: 'queued',
        providerRef: queueRef,
      });
    });
  }
}
