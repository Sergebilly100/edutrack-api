import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { db, withTenantSchema } from '../../shared/database/db.js';
import { off as defaultOff, on as defaultOn } from '../../shared/events/event-bus.js';
import {
  monthKeyInBusinessTimezone,
  todayInBusinessTimezone,
} from '../../shared/utils/business-time.js';
import type {
  EventMap,
  StudentAbsentPayload,
  SubscriptionExpiredPayload,
  TeacherAttendanceApprovedPayload,
  TeacherAttendanceRejectedPayload,
  TeacherEndScanActionPayload,
  TeacherEndScanWarningPayload,
  TeacherLatePayload,
  TeacherQrAlertPayload,
  TeacherQrInvalidPayload,
  TeacherSanctionCancelledPayload,
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
  buildPaymentReminderEmailText,
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
    on: <K extends keyof Pick<EventMap, 'teacher.late' | 'teacher.qr_alert' | 'teacher.qr_invalid' | 'teacher.attendance_rejected' | 'teacher.attendance_approved' | 'teacher.end_scan_action' | 'teacher.sanction_cancelled' | 'teacher.end_scan_warning' | 'student.absent' | 'subscription.expired'>>(
      event: K,
      handler: (payload: EventMap[K]) => void
    ) => void;
    off: <K extends keyof Pick<EventMap, 'teacher.late' | 'teacher.qr_alert' | 'teacher.qr_invalid' | 'teacher.attendance_rejected' | 'teacher.attendance_approved' | 'teacher.end_scan_action' | 'teacher.sanction_cancelled' | 'teacher.end_scan_warning' | 'student.absent' | 'subscription.expired'>>(
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
  provider: 'mock' | 'infobip' | 'africas_talking' | 'twilio' | 'smsmode' | 'custom';
  apiBaseUrl: string | null;
  apiKey: string | null;
  senderId: string;
  fallbackSenderId: string | null;
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
    sms_fallback_sender_id: string | null;
    sms_maintenance_mode: boolean | null;
    sms_maintenance_message: string | null;
  }>(sql`
    SELECT
      sms_provider,
      sms_api_base_url,
      sms_api_key,
      sms_sender_id,
      sms_fallback_sender_id,
      sms_maintenance_mode,
      sms_maintenance_message
    FROM public.app_settings
    ORDER BY updated_at DESC
    LIMIT 1
  `);

  const row = result.rows?.[0];
  const value: SmsPlatformRuntimeConfig = {
    provider: row?.sms_provider ?? 'mock',
    apiBaseUrl: row?.sms_api_base_url ?? null,
    apiKey: row?.sms_api_key ?? null,
    senderId: row?.sms_sender_id ?? 'EduTrack',
    fallbackSenderId: row?.sms_fallback_sender_id ?? null,
    smsMaintenanceMode: row?.sms_maintenance_mode ?? false,
    smsMaintenanceMessage: row?.sms_maintenance_message ?? 'Service SMS en maintenance',
  };
  if (value.provider === 'mock' && process.env.NODE_ENV === 'production') {
    console.warn('[notifications] SMS provider is mock in production — vérifier app_settings.sms_provider');
  }
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

const normalizeSmsRecipient = (phone: string): string => {
  const digits = phone.replace(/\D/g, '');
  if (!digits) {
    return phone;
  }

  if (digits.startsWith('225')) {
    return `+${digits}`;
  }

  if (digits.startsWith('0') && digits.length === 10) {
    return `+225${digits}`;
  }

  if (digits.length === 8 || digits.length === 10) {
    return `+225${digits}`;
  }

  return phone.trim().startsWith('+') ? phone.trim() : `+${digits}`;
};

const sendAfricasTalkingSms = async (params: {
  to: string;
  message: string;
  config: SmsPlatformRuntimeConfig;
}): Promise<{ status: 'sent' | 'failed'; providerRef?: string; errorMessage?: string }> => {
  const apiKey = params.config.apiKey?.trim() || process.env.AFRICASTALKING_API_KEY?.trim();
  const username = process.env.AFRICASTALKING_USERNAME?.trim();
  if (!apiKey || !username) {
    return { status: 'failed', errorMessage: 'Missing Africa’s Talking API key or username' };
  }

  const endpoint =
    params.config.apiBaseUrl?.trim() ||
    process.env.AFRICASTALKING_BASE_URL?.trim() ||
    'https://api.africastalking.com/version1/messaging';
  const recipient = normalizeSmsRecipient(params.to);
  const senderId = params.config.senderId.trim();
  const isBulkEndpoint = /\/messaging\/bulk\/?$/.test(endpoint);
  const headers: Record<string, string> = {
    apiKey,
    Accept: 'application/json',
    'Content-Type': isBulkEndpoint ? 'application/json' : 'application/x-www-form-urlencoded',
  };
  let body: BodyInit;

  if (isBulkEndpoint) {
    body = JSON.stringify({
      username,
      message: params.message,
      phoneNumbers: [recipient],
      ...(senderId ? { senderId } : {}),
    });
  } else {
    const formBody = new URLSearchParams({
      username,
      to: recipient,
      message: params.message,
      enqueue: '1',
    });
    if (senderId) {
      formBody.set('from', senderId);
    }
    body = formBody;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body,
  });

  const payload = (await response.json().catch(() => ({} as Record<string, unknown>))) as {
    SMSMessageData?: {
      Message?: string;
      Recipients?: Array<{
        messageId?: string;
        number?: string;
        status?: string;
        statusCode?: number;
      }>;
    };
  };
  if (!response.ok) {
    return { status: 'failed', errorMessage: `Africa's Talking error (${response.status})` };
  }

  const recipients = payload.SMSMessageData?.Recipients ?? [];
  const failedRecipient = recipients.find((recipient) => recipient.status !== 'Success');
  if (failedRecipient) {
    return {
      status: 'failed',
      providerRef: failedRecipient.messageId,
      errorMessage: `Africa's Talking recipient failed: ${failedRecipient.status ?? 'unknown'}`,
    };
  }

  const providerRef = recipients[0]?.messageId ?? payload.SMSMessageData?.Message ?? randomUUID();
  return { status: 'sent', providerRef };
};

const resolveSmsmodeCredentials = (
  config: SmsPlatformRuntimeConfig
): {
  apiKey: string;
  sender: string;
  baseUrl: string;
} | null => {
  const apiKey = (config.apiKey?.trim() || process.env.SMSMODE_API_KEY?.trim()) ?? '';
  if (!apiKey) {
    return null;
  }
  const baseUrl =
    config.apiBaseUrl?.trim() ||
    process.env.SMSMODE_BASE_URL?.trim() ||
    'https://rest.smsmode.com/sms/v1';
  const configuredSender = config.senderId.trim();
  const sender =
    configuredSender && configuredSender !== 'EduTrack'
      ? configuredSender
      : process.env.SMSMODE_SENDER?.trim() || configuredSender || 'EduTrack';
  return { apiKey, sender, baseUrl };
};

const sendSmsmodeSms = async (params: {
  to: string;
  message: string;
  config: SmsPlatformRuntimeConfig;
}): Promise<{ status: 'sent' | 'failed'; providerRef?: string; errorMessage?: string }> => {
  const credentials = resolveSmsmodeCredentials(params.config);
  if (!credentials) {
    return { status: 'failed', errorMessage: 'Missing smsmode API key' };
  }

  const recipient = normalizeSmsRecipient(params.to);
  if (!recipient) {
    return { status: 'failed', errorMessage: 'Missing smsmode recipient' };
  }

  const endpoint = `${credentials.baseUrl.replace(/\/+$/, '')}/messages`;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'X-Api-Key': credentials.apiKey,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        recipient: { to: recipient },
        body: { text: params.message },
        from: credentials.sender,
      }),
    });

    const payloadText = await response.text().catch(() => '');
    let payload: {
      messageId?: string;
      id?: string;
      message?: string;
    } = {};
    if (payloadText) {
      try {
        payload = JSON.parse(payloadText) as typeof payload;
      } catch {
        payload = {};
      }
    }

    if (!response.ok) {
      return {
        status: 'failed',
        errorMessage: `smsmode error (${response.status})${payloadText ? `: ${payloadText}` : ''}`,
      };
    }

    return {
      status: 'sent',
      providerRef: payload.messageId ?? payload.id ?? randomUUID(),
    };
  } catch (error) {
    return {
      status: 'failed',
      errorMessage: error instanceof Error ? error.message : 'smsmode error',
    };
  }
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

  if (config.provider === 'africas_talking') {
    return sendAfricasTalkingSms({
      to,
      message,
      config,
    });
  }

  if (config.provider === 'smsmode') {
    return sendSmsmodeSms({
      to,
      message,
      config,
    });
  }

  console.error(`[notifications] SMS provider not implemented: ${config.provider}`);
  return { status: 'failed', errorMessage: `SMS provider not implemented: ${config.provider}` };
};

const sendBrevoEmail = async (params: {
  to: string;
  subject: string;
  text: string;
}): Promise<{ status: 'sent' | 'failed'; providerRef?: string; errorMessage?: string }> => {
  const apiKey = process.env.BREVO_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim();
  if (!apiKey || !from) {
    return { status: 'failed', errorMessage: 'Missing BREVO_API_KEY or EMAIL_FROM' };
  }

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sender: { name: 'EduTrack', email: from },
      to: [{ email: params.to }],
      subject: params.subject,
      textContent: params.text,
    }),
  });
  const payload = (await response.json().catch(() => ({} as Record<string, unknown>))) as {
    messageId?: string;
  };
  if (!response.ok) {
    return { status: 'failed', errorMessage: `Brevo error (${response.status})` };
  }
  return { status: 'sent', providerRef: payload.messageId ?? randomUUID() };
};

export const defaultEmailSender: EmailSender = async ({ to, subject, text }) => {
  const provider = (process.env.EMAIL_PROVIDER ?? 'mock').trim().toLowerCase();
  const mockEnabled = (process.env.EMAIL_MOCK ?? 'false').toLowerCase() === 'true';
  if ((provider === 'mock' || mockEnabled) && process.env.NODE_ENV === 'production') {
    console.warn('[notifications] Email provider is mock in production — set EMAIL_PROVIDER env var');
  }
  if (provider === 'mock' || mockEnabled) {
    console.info(`[email][mock] to=${to}`);
    return { status: 'sent', providerRef: 'mock-email' };
  }
  if (provider === 'brevo') {
    return sendBrevoEmail({ to, subject, text });
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
  private _started = false;

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

  // ici teacherLateListener écoute les événements de type 'teacher.late' émis sur le bus d'événements, et pour chaque événement reçu, 
  // il appelle la méthode handleTeacherLate pour traiter l'événement. 
  // Si une erreur survient lors du traitement de l'événement, elle est capturée et un message d'erreur est affiché dans la console.
  private readonly teacherLateListener = (payload: EventMap['teacher.late']): void => {
    void this.handleTeacherLate(payload).catch((error) => { // Gestion des erreurs pour éviter que des exceptions non gérées ne fassent planter le service de notifications
      console.error('[notifications] failed to process teacher.late', error); // Affiche une erreur dans la console si le traitement de l'événement 'teacher.late' échoue, avec des détails sur l'erreur
    });
  };

  private readonly teacherQrAlertListener = (payload: EventMap['teacher.qr_alert']): void => {
    void this.handleTeacherQrAlert(payload).catch((error) => {
      console.error('[notifications] failed to process teacher.qr_alert', error);
    });
  };

  private readonly teacherQrInvalidListener = (payload: EventMap['teacher.qr_invalid']): void => {
    void this.handleTeacherQrInvalid(payload).catch((error) => {
      console.error('[notifications] failed to process teacher.qr_invalid', error);
    });
  };

  private readonly teacherAttendanceRejectedListener = (
    payload: EventMap['teacher.attendance_rejected']
  ): void => {
    void this.handleTeacherAttendanceRejected(payload).catch((error) => {
      console.error('[notifications] failed to process teacher.attendance_rejected', error);
    });
  };

  private readonly teacherAttendanceApprovedListener = (
    payload: EventMap['teacher.attendance_approved']
  ): void => {
    void this.handleTeacherAttendanceApproved(payload).catch((error) => {
      console.error('[notifications] failed to process teacher.attendance_approved', error);
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

  private readonly teacherEndScanActionListener = (
    payload: EventMap['teacher.end_scan_action']
  ): void => {
    void this.handleTeacherEndScanAction(payload).catch((error) => {
      console.error('[notifications] failed to process teacher.end_scan_action', error);
    });
  };

  private readonly teacherSanctionCancelledListener = (
    payload: EventMap['teacher.sanction_cancelled']
  ): void => {
    void this.handleTeacherSanctionCancelled(payload).catch((error) => {
      console.error('[notifications] failed to process teacher.sanction_cancelled', error);
    });
  };

  private readonly teacherEndScanWarningListener = (
    payload: EventMap['teacher.end_scan_warning']
  ): void => {
    void this.handleTeacherEndScanWarning(payload).catch((error) => {
      console.error('[notifications] failed to process teacher.end_scan_warning', error);
    });
  };

  start(): void {
    if (this._started) return;
    this._started = true;
    this.deps.eventBus.on('teacher.late', this.teacherLateListener);
    this.deps.eventBus.on('teacher.qr_alert', this.teacherQrAlertListener);
    this.deps.eventBus.on('teacher.qr_invalid', this.teacherQrInvalidListener);
    this.deps.eventBus.on(
      'teacher.attendance_rejected',
      this.teacherAttendanceRejectedListener
    );
    this.deps.eventBus.on(
      'teacher.attendance_approved',
      this.teacherAttendanceApprovedListener
    );
    this.deps.eventBus.on('teacher.end_scan_action', this.teacherEndScanActionListener);
    this.deps.eventBus.on('teacher.sanction_cancelled', this.teacherSanctionCancelledListener);
    this.deps.eventBus.on('teacher.end_scan_warning', this.teacherEndScanWarningListener);
    this.deps.eventBus.on('student.absent', this.studentAbsentListener);
    this.deps.eventBus.on('subscription.expired', this.subscriptionExpiredListener);
  }

  stop(): void {
    this._started = false;
    this.deps.eventBus.off('teacher.late', this.teacherLateListener);
    this.deps.eventBus.off('teacher.qr_alert', this.teacherQrAlertListener);
    this.deps.eventBus.off('teacher.qr_invalid', this.teacherQrInvalidListener);
    this.deps.eventBus.off(
      'teacher.attendance_rejected',
      this.teacherAttendanceRejectedListener
    );
    this.deps.eventBus.off(
      'teacher.attendance_approved',
      this.teacherAttendanceApprovedListener
    );
    this.deps.eventBus.off('teacher.end_scan_action', this.teacherEndScanActionListener);
    this.deps.eventBus.off('teacher.sanction_cancelled', this.teacherSanctionCancelledListener);
    this.deps.eventBus.off('teacher.end_scan_warning', this.teacherEndScanWarningListener);
    this.deps.eventBus.off('student.absent', this.studentAbsentListener);
    this.deps.eventBus.off('subscription.expired', this.subscriptionExpiredListener);
  }

  // La méthode handleTeacherLate est une fonction asynchrone qui traite les événements de type 'teacher.late'. 
  // elle envoie une notification SMS au directeur de l'école lorsque le professeur arrive en retard à une classe prévue.
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

      await this.deps.repository.insertNotificationLog(tenantDb, {
        type: 'teacher_late_director',
        recipientPhone: context.directorPhone,
        message,
        status: 'queued',
        providerRef: queueRef,
        relatedId: payload.scheduleId,
      });

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
    });
  }

  // QR alerts (mismatch, missing, out-of-time) sont tracées en base pour le dashboard
  // mais n'envoient pas de SMS — trop bruyant pour le directeur.
  // Seul qr_invalid_alert (QR inconnu = alerte sécurité) envoie un SMS via handleTeacherQrInvalid.
  async handleTeacherQrAlert(payload: TeacherQrAlertPayload): Promise<void> {
    await this.deps.withTenantSchema(payload.schemaName, async (tenantDb) => {
      const context = await this.deps.repository.getQrAlertContext(tenantDb, payload);
      if (!context) {
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

      // Log uniquement — pas de SMS envoyé pour ces alertes QR (dashboard uniquement)
      await this.deps.repository.insertNotificationLog(tenantDb, {
        type: notificationType,
        recipientPhone: context.directorPhone ?? '',
        message,
        status: 'skipped_unknown',
        relatedId: payload.scheduleId,
      });

      // Marquer qr_alert_sent pour éviter les doublons de détection
      if (context.directorPhone) {
        await this.deps.repository.markQrAlertSent(tenantDb, {
          teacherId: payload.teacherId,
          scheduleId: payload.scheduleId,
          date: payload.date,
        });
      }
    });
  }

  // La méthode handleTeacherQrInvalid est une fonction asynchrone qui traite les événements de type 'teacher.qr_invalid'. 
  // elle envoie une notification SMS et/ou email au directeur de l'école lorsque le professeur tente de scanner un QR code inconnu, avec des détails sur l'heure du scan et le QR token scanné.
  async handleTeacherQrInvalid(payload: TeacherQrInvalidPayload): Promise<void> {
    await this.deps.withTenantSchema(payload.schemaName, async (tenantDb) => {
      const director = await this.deps.repository.getQrInvalidAlertContext(tenantDb, {
        teacherId: payload.teacherId,
      });
      if (!director?.directorPhone && !director?.directorEmail) {
        return;
      }

      const scanTime = new Date(payload.timestamp).toLocaleTimeString('fr-FR', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Africa/Abidjan',
      });
      const message = `[EduTrack] ${payload.teacherName} a tenté de scanner un QR inconnu à ${scanTime}. Accès refusé.`;
      const tasks: Array<Promise<void>> = [];

      if (director.directorPhone) {
        const queueRef = buildQueueRef(payload.schemaName, 'qr_invalid_alert');
        await this.deps.repository.insertNotificationLog(tenantDb, {
          type: 'qr_invalid_alert',
          channel: 'sms',
          recipientPhone: director.directorPhone,
          message,
          status: 'queued',
          providerRef: queueRef,
          relatedId: payload.teacherId,
        });
        tasks.push(
          this.deps.smsQueue.add(
            'send-sms',
            toSmsJobData({
              queueRef,
              to: director.directorPhone,
              message,
              notificationType: 'qr_invalid_alert',
              schemaName: payload.schemaName,
              relatedId: payload.teacherId,
            }),
            {
              jobId: queueRef,
              attempts: 3,
              backoff: { type: 'exponential', delay: 5_000 },
              removeOnComplete: true,
              removeOnFail: true,
            }
          ).then(() => undefined)
        );
      }

      if (director.directorEmail) {
        const emailQueueRef = buildQueueRef(payload.schemaName, 'qr_invalid_alert');
        const emailText = `${payload.teacherName} a tenté de scanner un QR non reconnu le ${payload.timestamp}. QR: ${payload.qrToken}.`;
        await this.deps.repository.insertNotificationLog(tenantDb, {
          type: 'qr_invalid_alert',
          channel: 'email',
          recipientPhone: director.directorPhone ?? '',
          recipientEmail: director.directorEmail,
          message: emailText,
          status: 'queued',
          providerRef: emailQueueRef,
          relatedId: payload.teacherId,
        });
        tasks.push(
          this.deps.smsQueue.add(
            'send-email',
            toEmailJobData({
              queueRef: emailQueueRef,
              to: director.directorEmail,
              subject: 'Alerte sécurité - QR non reconnu',
              text: emailText,
              recipientPhone: director.directorPhone ?? '',
              notificationType: 'qr_invalid_alert',
              schemaName: payload.schemaName,
              relatedId: payload.teacherId,
            }),
            {
              jobId: emailQueueRef,
              attempts: 3,
              backoff: { type: 'exponential', delay: 5_000 },
              removeOnComplete: true,
              removeOnFail: true,
            }
          ).then(() => undefined)
        );
      }

      await Promise.all(tasks);
    });
  }

  // La méthode handleTeacherAttendanceRejected est une fonction asynchrone qui traite les événements de type 'teacher.attendance_rejected'. 
  // elle envoie une notification email au professeur lorsque sa présence pour un cours n'a pas pu être validée, avec des détails sur le cours, la date, le motif du rejet et les coordonnées de contact de la direction.
  async handleTeacherAttendanceRejected(
    payload: TeacherAttendanceRejectedPayload
  ): Promise<void> {
    if (!payload.teacherEmail) {
      return;
    }
    const teacherEmail = payload.teacherEmail;

    await this.deps.withTenantSchema(payload.schemaName, async (tenantDb) => {
      const queueRef = buildQueueRef(payload.schemaName, 'attendance_rejected');
      const text = `Votre présence pour le cours ${payload.courseName} du ${payload.date} n'a pas pu être validée.\nMotif : ${payload.reason}.\nContactez votre direction pour plus d'informations.`;

      // FIXME: removed recipient_id reference — column does not exist in schema
      await this.deps.repository.insertNotificationLog(tenantDb, {
        type: 'attendance_rejected',
        channel: 'email',
        recipientPhone: payload.teacherPhone ?? '',
        recipientEmail: teacherEmail,
        message: text,
        status: 'queued',
        providerRef: queueRef,
        relatedId: payload.attendanceId,
      });

      await this.deps.smsQueue.add(
        'send-email',
        toEmailJobData({
          queueRef,
          to: teacherEmail,
          subject: `Information sur votre présence du ${payload.date}`,
          text,
          recipientPhone: payload.teacherPhone ?? '',
          notificationType: 'attendance_rejected',
          schemaName: payload.schemaName,
          relatedId: payload.attendanceId,
        }),
        {
          jobId: queueRef,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: true,
          removeOnFail: true,
        }
      );
    });
  }

  // La méthode handleTeacherAttendanceApproved est une fonction asynchrone qui traite les événements de type 'teacher.attendance_approved'.
  // elle envoie une notification SMS et/ou email au professeur lorsque sa présence pour un cours a été validée, avec des détails sur le cours, la date, les heures validées et les coordonnées de contact de la direction.
  async handleTeacherAttendanceApproved(
    payload: TeacherAttendanceApprovedPayload
  ): Promise<void> {
    const tasks: Array<Promise<void>> = [];

    await this.deps.withTenantSchema(payload.schemaName, async (tenantDb) => {
      const validatedHoursLabel =
        payload.validatedHours > 0
          ? `${payload.validatedHours.toFixed(2).replace('.00', '')}h validées`
          : 'heures validées';

      if (payload.teacherPhone) {
        const smsMessage = `[EduTrack] Présence validée — ${payload.courseName} du ${payload.date}. ${validatedHoursLabel}. Consultez l'app pour le détail.`;
        const smsQueueRef = buildQueueRef(payload.schemaName, 'attendance_approved');

        // FIXME: removed recipient_id reference — column does not exist in schema
        await this.deps.repository.insertNotificationLog(tenantDb, {
          type: 'attendance_approved',
          channel: 'sms',
          recipientPhone: payload.teacherPhone,
          message: smsMessage,
          status: 'queued',
          providerRef: smsQueueRef,
          relatedId: payload.attendanceId,
        });

        tasks.push(
          this.deps.smsQueue.add(
            'send-sms',
            toSmsJobData({
              queueRef: smsQueueRef,
              to: payload.teacherPhone,
              message: smsMessage,
              notificationType: 'attendance_approved',
              schemaName: payload.schemaName,
              relatedId: payload.attendanceId,
            }),
            {
              jobId: smsQueueRef,
              attempts: 3,
              backoff: { type: 'exponential', delay: 5_000 },
              removeOnComplete: true,
              removeOnFail: true,
            }
          ).then(() => undefined)
        );
      }

      if (payload.teacherEmail) {
        const emailText = `Votre présence pour le cours ${payload.courseName} du ${payload.date} a été validée.\n${validatedHoursLabel}.\nConsultez votre espace EduTrack pour le récapitulatif.`;
        const emailQueueRef = buildQueueRef(payload.schemaName, 'attendance_approved');

        // FIXME: removed recipient_id reference — column does not exist in schema
        await this.deps.repository.insertNotificationLog(tenantDb, {
          type: 'attendance_approved',
          channel: 'email',
          recipientPhone: payload.teacherPhone ?? '',
          recipientEmail: payload.teacherEmail,
          message: emailText,
          status: 'queued',
          providerRef: emailQueueRef,
          relatedId: payload.attendanceId,
        });

        tasks.push(
          this.deps.smsQueue.add(
            'send-email',
            toEmailJobData({
              queueRef: emailQueueRef,
              to: payload.teacherEmail,
              subject: `[EduTrack] Présence validée — ${payload.courseName} du ${payload.date}`,
              text: emailText,
              recipientPhone: payload.teacherPhone ?? '',
              notificationType: 'attendance_approved',
              schemaName: payload.schemaName,
              relatedId: payload.attendanceId,
            }),
            {
              jobId: emailQueueRef,
              attempts: 3,
              backoff: { type: 'exponential', delay: 5_000 },
              removeOnComplete: true,
              removeOnFail: true,
            }
          ).then(() => undefined)
        );
      }

      await Promise.all(tasks);
    });
  }

  // La méthode handleStudentAbsentWithLegacySubscriptionCheck est une fonction asynchrone qui traite les événements de type 'student.absent'.
  // elle vérifie les abonnements actifs de l'école pour déterminer si une notification SMS et/ou email peut être envoyée aux parents d'un élève absent, puis envoie les notifications correspondantes avec des détails sur l'élève, le cours et la date d'absence.
  // Cette méthode utilise un service de gestion des abonnements pour vérifier les droits d'envoi de notifications, et enregistre des logs de notification avec le statut de chaque tentative d'envoi (envoyé, refusé, ou ignoré pour différentes raisons).
  // voici une explication détaillée de son fonctionnement : 
  // 1. Vérification des abonnements : La méthode commence par créer une instance du service de gestion des abonnements en utilisant le repository approprié pour accéder à la base de données du locataire. Elle appelle ensuite la méthode canSendNotification pour vérifier si une notification peut être envoyée pour l'élève concerné, en fonction de son ID, du tenant, du schéma et du type de notification (SMS dans ce cas). Si la vérification échoue (par exemple, en raison d'un abonnement expiré ou d'une fonctionnalité désactivée), un log de notification est enregistré avec le statut correspondant (refusé pour différentes raisons) et la méthode se termine sans envoyer de notification.
  // 2. Envoi de la notification SMS : Si la vérification des abonnements est réussie, la méthode résout le template de message SMS à utiliser pour la notification d'absence d'élève, en fonction du schéma et du type de notification. Elle rend ensuite le message en remplissant les variables du template avec les informations de l'élève, du cours et de la date d'absence. Un log de notification est enregistré avec le statut "queued" pour indiquer que la notification est en attente d'envoi, puis un job est ajouté à la queue pour envoyer le SMS, avec des paramètres tels que le numéro de téléphone du parent, le message à envoyer, et des options de retry en cas d'échec.
  // 3. Envoi de la notification email : Si une adresse email du parent est disponible, la méthode effectue une vérification similaire des abonnements pour l'envoi d'emails. Si l'envoi d'emails est autorisé, elle rend un message email à partir d'un template, enregistre un log de notification pour l'email, puis ajoute un job à la queue pour envoyer l'email avec les détails appropriés. Si l'envoi d'emails n'est pas autorisé, un log de notification est enregistré avec le statut correspondant et la méthode se termine.
  async handleTeacherEndScanAction(payload: TeacherEndScanActionPayload): Promise<void> {
    if (!payload.teacherEmail && !payload.teacherPhone) return;
    if (!payload.schemaName) return;

    const isSanction = payload.action === 'sanctioned';
    const message = isSanction
      ? `[EduTrack] Sanction pour absence de scan de fin — ${payload.courseName} du ${payload.date}. Présentez-vous à l'administration.`
      : `[EduTrack] Avertissement — scan de fin manquant pour ${payload.courseName} du ${payload.date}. Aucun impact sur votre salaire.`;

    const tasks: Array<Promise<void>> = [];

    await this.deps.withTenantSchema(payload.schemaName, async (tenantDb) => {
      if (payload.teacherPhone) {
        const smsQueueRef = buildQueueRef(payload.schemaName, isSanction ? 'scan_end_sanction' : 'scan_end_warning');
        await this.deps.repository.insertNotificationLog(tenantDb, {
          type: isSanction ? 'scan_end_sanction' : 'scan_end_warning',
          channel: 'sms',
          recipientPhone: payload.teacherPhone,
          message,
          status: 'queued',
          providerRef: smsQueueRef,
          relatedId: payload.attendanceId,
        });
        tasks.push(
          this.deps.smsQueue.add(
            'send-sms',
            toSmsJobData({
              queueRef: smsQueueRef,
              to: payload.teacherPhone,
              message,
              notificationType: isSanction ? 'scan_end_sanction' : 'scan_end_warning',
              schemaName: payload.schemaName,
              relatedId: payload.attendanceId,
            }),
            { jobId: smsQueueRef, attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: true, removeOnFail: true }
          ).then(() => undefined)
        );
      }

      if (payload.teacherEmail) {
        const emailText = isSanction
          ? `Votre cours ${payload.courseName} du ${payload.date} n'a pas pu être comptabilisé (scan de fin manquant). Motif : ${payload.reason}. Veuillez vous présenter à l'administration.`
          : `Vous avez un avertissement pour absence de scan de fin : ${payload.courseName} du ${payload.date}. Motif : ${payload.reason}. Votre salaire n'est pas impacté.`;
        const emailQueueRef = buildQueueRef(payload.schemaName, isSanction ? 'scan_end_sanction' : 'scan_end_warning');
        await this.deps.repository.insertNotificationLog(tenantDb, {
          type: isSanction ? 'scan_end_sanction' : 'scan_end_warning',
          channel: 'email',
          recipientPhone: payload.teacherPhone ?? '',
          recipientEmail: payload.teacherEmail,
          message: emailText,
          status: 'queued',
          providerRef: emailQueueRef,
          relatedId: payload.attendanceId,
        });
        tasks.push(
          this.deps.smsQueue.add(
            'send-email',
            toEmailJobData({
              queueRef: emailQueueRef,
              to: payload.teacherEmail,
              subject: isSanction ? `[EduTrack] Sanction — ${payload.courseName} du ${payload.date}` : `[EduTrack] Avertissement — scan de fin manquant`,
              text: emailText,
              recipientPhone: payload.teacherPhone ?? '',
              notificationType: isSanction ? 'scan_end_sanction' : 'scan_end_warning',
              schemaName: payload.schemaName,
              relatedId: payload.attendanceId,
            }),
            { jobId: emailQueueRef, attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: true, removeOnFail: true }
          ).then(() => undefined)
        );
      }

      await Promise.all(tasks);
    });
  }

  async handleTeacherSanctionCancelled(payload: TeacherSanctionCancelledPayload): Promise<void> {
    if (!payload.teacherEmail && !payload.teacherPhone) return;
    if (!payload.schemaName) return;

    const message = `[EduTrack] La sanction pour ${payload.courseName} du ${payload.date} a été annulée. Votre cours est de nouveau comptabilisé.`;
    const tasks: Array<Promise<void>> = [];

    await this.deps.withTenantSchema(payload.schemaName, async (tenantDb) => {
      if (payload.teacherPhone) {
        const smsQueueRef = buildQueueRef(payload.schemaName, 'scan_end_sanction_cancelled');
        await this.deps.repository.insertNotificationLog(tenantDb, {
          type: 'scan_end_sanction_cancelled',
          channel: 'sms',
          recipientPhone: payload.teacherPhone,
          message,
          status: 'queued',
          providerRef: smsQueueRef,
          relatedId: payload.attendanceId,
        });
        tasks.push(
          this.deps.smsQueue.add(
            'send-sms',
            toSmsJobData({
              queueRef: smsQueueRef,
              to: payload.teacherPhone,
              message,
              notificationType: 'scan_end_sanction_cancelled',
              schemaName: payload.schemaName,
              relatedId: payload.attendanceId,
            }),
            { jobId: smsQueueRef, attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: true, removeOnFail: true }
          ).then(() => undefined)
        );
      }

      if (payload.teacherEmail) {
        const emailText = `La sanction appliquée pour ${payload.courseName} du ${payload.date} a été annulée. Motif de l'annulation : ${payload.cancelReason}. Votre cours est de nouveau comptabilisé dans votre salaire.`;
        const emailQueueRef = buildQueueRef(payload.schemaName, 'scan_end_sanction_cancelled');
        await this.deps.repository.insertNotificationLog(tenantDb, {
          type: 'scan_end_sanction_cancelled',
          channel: 'email',
          recipientPhone: payload.teacherPhone ?? '',
          recipientEmail: payload.teacherEmail,
          message: emailText,
          status: 'queued',
          providerRef: emailQueueRef,
          relatedId: payload.attendanceId,
        });
        tasks.push(
          this.deps.smsQueue.add(
            'send-email',
            toEmailJobData({
              queueRef: emailQueueRef,
              to: payload.teacherEmail,
              subject: `[EduTrack] Sanction annulée — ${payload.courseName} du ${payload.date}`,
              text: emailText,
              recipientPhone: payload.teacherPhone ?? '',
              notificationType: 'scan_end_sanction_cancelled',
              schemaName: payload.schemaName,
              relatedId: payload.attendanceId,
            }),
            { jobId: emailQueueRef, attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: true, removeOnFail: true }
          ).then(() => undefined)
        );
      }

      await Promise.all(tasks);
    });
  }

  async handleTeacherEndScanWarning(payload: TeacherEndScanWarningPayload): Promise<void> {
    if (!payload.teacherEmail && !payload.teacherPhone) return;
    if (!payload.schemaName) return;

    const message = `[EduTrack] ${payload.missingCount} cours sans scan de fin pour ${payload.month}. Veuillez régulariser.`;
    const tasks: Array<Promise<void>> = [];

    await this.deps.withTenantSchema(payload.schemaName, async (tenantDb) => {
      if (payload.teacherPhone) {
        const smsQueueRef = buildQueueRef(payload.schemaName, 'scan_end_warning');
        await this.deps.repository.insertNotificationLog(tenantDb, {
          type: 'scan_end_warning',
          channel: 'sms',
          recipientPhone: payload.teacherPhone,
          message,
          status: 'queued',
          providerRef: smsQueueRef,
        });
        tasks.push(
          this.deps.smsQueue.add(
            'send-sms',
            toSmsJobData({
              queueRef: smsQueueRef,
              to: payload.teacherPhone,
              message,
              notificationType: 'scan_end_warning',
              schemaName: payload.schemaName,
            }),
            { jobId: smsQueueRef, attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: true, removeOnFail: true }
          ).then(() => undefined)
        );
      }

      if (payload.teacherEmail) {
        const emailText = `Vous avez ${payload.missingCount} cours sans scan de fin pour le mois ${payload.month}. Veuillez vous rapprocher de l'administration pour régulariser la situation.`;
        const emailQueueRef = buildQueueRef(payload.schemaName, 'scan_end_warning');
        await this.deps.repository.insertNotificationLog(tenantDb, {
          type: 'scan_end_warning',
          channel: 'email',
          recipientPhone: payload.teacherPhone ?? '',
          recipientEmail: payload.teacherEmail,
          message: emailText,
          status: 'queued',
          providerRef: emailQueueRef,
        });
        tasks.push(
          this.deps.smsQueue.add(
            'send-email',
            toEmailJobData({
              queueRef: emailQueueRef,
              to: payload.teacherEmail,
              subject: `[EduTrack] Scans de fin manquants — ${payload.month}`,
              text: emailText,
              recipientPhone: payload.teacherPhone ?? '',
              notificationType: 'scan_end_warning',
              schemaName: payload.schemaName,
            }),
            { jobId: emailQueueRef, attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: true, removeOnFail: true }
          ).then(() => undefined)
        );
      }

      await Promise.all(tasks);
    });
  }

  private async handleStudentAbsentWithLegacySubscriptionCheck(
    tenantDb: TenantDbLike,
    payload: StudentAbsentPayload
  ): Promise<void> {
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
        allowed: false as const,
        reason: 'no_active_subscription' as const,
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
    const recipientPhone = canSend.parentPhone ?? payload.parentPhone;

    await this.deps.repository.insertNotificationLog(tenantDb, {
      type: 'student_absent_parent',
      channel: 'sms',
      recipientPhone,
      message,
      status: 'queued',
      providerRef: queueRef,
      relatedId: payload.scheduleId,
    });

    await this.deps.smsQueue.add(
      'send-sms',
      toSmsJobData({
        queueRef,
        to: recipientPhone,
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
    if (canSend.subscriptionId) {
      await subscriptionsService.incrementUsage({
        studentId: payload.studentId,
        subscriptionId: canSend.subscriptionId,
        type: 'sms',
      });
    }

    const emailAddress = canSend.parentEmail ?? payload.parentEmail;
    if (!emailAddress) {
      await this.deps.repository.insertNotificationLog(tenantDb, {
        type: 'student_absent_parent',
        channel: 'email',
        recipientPhone,
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
        allowed: false as const,
        reason: 'no_active_subscription' as const,
      }));
    if (!canSendEmail.allowed) {
      await this.deps.repository.insertNotificationLog(tenantDb, {
        type: 'student_absent_parent',
        channel: 'email',
        recipientPhone,
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
    await this.deps.repository.insertNotificationLog(tenantDb, {
      type: 'student_absent_parent',
      channel: 'email',
      recipientPhone,
      recipientEmail: emailAddress,
      message: emailText,
      status: 'queued',
      providerRef: emailQueueRef,
      relatedId: payload.scheduleId,
    });

    await this.deps.smsQueue.add(
      'send-email',
      toEmailJobData({
        queueRef: emailQueueRef,
        to: emailAddress,
        subject: DEFAULT_STUDENT_ABSENT_EMAIL_SUBJECT,
        text: emailText,
        recipientPhone,
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
    if (canSendEmail.subscriptionId) {
      await subscriptionsService.incrementUsage({
        studentId: payload.studentId,
        subscriptionId: canSendEmail.subscriptionId,
        type: 'email',
      });
    }
  }

  // La méthode handleStudentAbsent est une fonction asynchrone qui traite les événements de type 'student.absent'.
  // elle envoie une notification SMS et/ou email aux parents de l'élève lorsqu'il est absent à un cours prévu, avec des détails sur le cours, la date et les coordonnées de contact de l'école.
  // elle envoie les notification si l'école a activé la fonctionnalité pour les parents et si les parents ont un abonnement actif (ou si la fonctionnalité n'est pas monétisée).
  // voici les étapes principales de la méthode :
  // 1. Récupérer les informations d'abonnement de l'école et vérifier si la fonctionnalité de notifications pour les parents est activée.
  // 2. Si la fonctionnalité est désactivée, enregistrer une entrée dans le journal des notifications avec le statut "skipped_feature_disabled" et ne pas envoyer de notification.
  // 3. Si la fonctionnalité est activée, construire le message à envoyer en utilisant un template et les données de l'événement.
  // 4. Récupérer les contacts des parents à notifier depuis la base de données. Si aucun contact n'est trouvé, utiliser les coordonnées fournies dans l'événement.
  // 5. Pour chaque contact, vérifier si l'envoi de notifications est autorisé en fonction de l'abonnement du parent (si la fonctionnalité est monétisée). Si l'envoi n'est pas autorisé, enregistrer une entrée dans le journal des notifications avec le statut approprié et ne pas envoyer de notification.
  // 6. Si l'envoi est autorisé, ajouter une tâche à la file d'attente pour envoyer la notification SMS et/ou email, et enregistrer une entrée dans le journal des notifications avec le statut "queued".
  async handleStudentAbsent(payload: StudentAbsentPayload): Promise<void> {
    await this.deps.withTenantSchema(payload.schemaName, async (tenantDb) => {
      const subscriptionsRepository = new SubscriptionsRepository(
        tenantDb as NodePgDatabase<Record<string, unknown>>
      );
      const tenantId = payload.tenantId ?? (await subscriptionsRepository.getTenantIdBySchemaName(payload.schemaName));
      const feature = tenantId
        ? await subscriptionsRepository.getSmsFeatureByTenantId(tenantId).catch(async () => {
            await this.handleStudentAbsentWithLegacySubscriptionCheck(tenantDb, payload);
            return null;
          })
        : null;
      if (tenantId && !feature) {
        return;
      }

      if (!feature?.is_enabled) {
        await this.deps.repository.insertNotificationLog(tenantDb, {
          type: 'student_absent_parent',
          channel: 'sms',
          recipientPhone: payload.parentPhone,
          message: '',
          status: 'skipped_feature_disabled',
          relatedId: payload.scheduleId,
        });
        await this.deps.repository.insertNotificationLog(tenantDb, {
          type: 'student_absent_parent',
          channel: 'email',
          recipientPhone: payload.parentPhone,
          message: '',
          status: 'skipped_feature_disabled',
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

      const emailText = renderSmsTemplate(DEFAULT_STUDENT_ABSENT_EMAIL_TEMPLATE, {
        studentFirstName: payload.studentFirstName,
        subject: payload.subject,
        date: payload.date,
        schoolPhone: payload.schoolPhone,
      });

      const contactsFromDb = await subscriptionsRepository.listParentAlertContactsByStudent(payload.studentId);
      const contacts = contactsFromDb.length > 0
        ? contactsFromDb
        : [
            {
              parent_id: null,
              subscription_id: null,
              parent_phone: payload.parentPhone,
              parent_email: payload.parentEmail ?? null,
              ends_at: null,
              subscription_status: null,
            },
          ];
      const today = todayInBusinessTimezone();
      const currentMonth = monthKeyInBusinessTimezone();

      for (const contact of contacts) {
        const hasActiveSubscription =
          contact.subscription_status === 'active' &&
          contact.subscription_id !== null &&
          contact.ends_at !== null &&
          contact.ends_at >= today;

        if (feature.monetize_parent_alerts && !hasActiveSubscription) {
          await this.deps.repository.insertNotificationLog(tenantDb, {
            type: 'student_absent_parent',
            channel: 'sms',
            recipientPhone: contact.parent_phone,
            message: '',
            status: contact.subscription_status === 'active' ? 'skipped_subscription_expired' : 'skipped_no_active_subscription',
            relatedId: payload.scheduleId,
          });
          if (contact.parent_email) {
            await this.deps.repository.insertNotificationLog(tenantDb, {
              type: 'student_absent_parent',
              channel: 'email',
              recipientPhone: contact.parent_phone,
              recipientEmail: contact.parent_email,
              message: '',
              status: contact.subscription_status === 'active' ? 'skipped_subscription_expired' : 'skipped_no_active_subscription',
              relatedId: payload.scheduleId,
            });
          }
          continue;
        }

        if (feature.monetize_parent_alerts) {
          const usage = await subscriptionsRepository.getUsageByStudentMonth(payload.studentId, currentMonth);
          if (usage.sms >= feature.sms_cap_per_student) {
            await this.deps.repository.insertNotificationLog(tenantDb, {
              type: 'student_absent_parent',
              channel: 'sms',
              recipientPhone: contact.parent_phone,
              message: '',
              status: 'skipped_cap_reached',
              relatedId: payload.scheduleId,
            });
            continue;
          }
        }

        const queueRef = buildQueueRef(payload.schemaName, 'student_absent_parent');
        await this.deps.repository.insertNotificationLog(tenantDb, {
          type: 'student_absent_parent',
          channel: 'sms',
          recipientPhone: contact.parent_phone,
          message,
          status: 'queued',
          providerRef: queueRef,
          relatedId: payload.scheduleId,
        });

        await this.deps.smsQueue.add(
          'send-sms',
          toSmsJobData({
            queueRef,
            to: contact.parent_phone,
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

        if (feature.monetize_parent_alerts && contact.subscription_id) {
          await subscriptionsRepository.incrementUsage({
            studentId: payload.studentId,
            subscriptionId: contact.subscription_id,
            month: currentMonth,
            type: 'sms',
          });
        }

        if (!contact.parent_email) {
          await this.deps.repository.insertNotificationLog(tenantDb, {
            type: 'student_absent_parent',
            channel: 'email',
            recipientPhone: contact.parent_phone,
            message: '',
            status: 'skipped_unknown',
            relatedId: payload.scheduleId,
          });
          continue;
        }

        const emailQueueRef = buildQueueRef(payload.schemaName, 'student_absent_parent');
        await this.deps.repository.insertNotificationLog(tenantDb, {
          type: 'student_absent_parent',
          channel: 'email',
          recipientPhone: contact.parent_phone,
          recipientEmail: contact.parent_email,
          message: emailText,
          status: 'queued',
          providerRef: emailQueueRef,
          relatedId: payload.scheduleId,
        });

        await this.deps.smsQueue.add(
          'send-email',
          toEmailJobData({
            queueRef: emailQueueRef,
            to: contact.parent_email,
            subject: DEFAULT_STUDENT_ABSENT_EMAIL_SUBJECT,
            text: emailText,
            recipientPhone: contact.parent_phone,
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

        if (feature.monetize_parent_alerts && contact.subscription_id) {
          await subscriptionsRepository.incrementUsage({
            studentId: payload.studentId,
            subscriptionId: contact.subscription_id,
            month: currentMonth,
            type: 'email',
          });
        }
      }
    });
  }

  // La méthode handleSubscriptionExpired est une fonction asynchrone qui traite les événements de type 'subscription.expired'.
  // elle envoie une notification SMS et/ou email au directeur de l'école lorsque l'abonnement de l'école expire, avec des détails sur le montant restant à payer, la date d'échéance et les coordonnées de contact pour régulariser la situation.
  // cet événement est déclenché lorsque l'abonnement de l'école arrive à expiration, et la méthode vérifie les informations nécessaires pour envoyer les notifications, puis construit les messages à envoyer et les ajoute à la file d'attente des notifications.
  // comment elle sait que l'abonnement est expiré ? L'événement 'subscription.expired' doit être émis par un autre service (probablement le service de gestion des abonnements) au moment où l'abonnement d'une école expire. Cet événement doit contenir les informations nécessaires (comme le nom de l'école, le montant restant, la date d'échéance, etc.) pour que le service de notifications puisse traiter l'événement et envoyer les notifications appropriées.
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

      await this.deps.repository.insertNotificationLog(tenantDb, {
        type: 'payment_reminder',
        channel: 'sms',
        recipientPhone: payload.directorPhone,
        message,
        status: 'queued',
        providerRef: queueRef,
      });

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

      if (!payload.directorEmail) {
        await this.deps.repository.insertNotificationLog(tenantDb, {
          type: 'payment_reminder',
          channel: 'email',
          recipientPhone: payload.directorPhone,
          message: '',
          status: 'skipped_unknown',
        });
        return;
      }

      const emailText = buildPaymentReminderEmailText({
        schoolName: payload.schoolName,
        periodLabel: payload.periodLabel,
        dueDate: payload.dueDate,
        remainingAmountFcfa: payload.remainingAmountFcfa,
      });
      const emailQueueRef = buildQueueRef(payload.schemaName, 'payment_reminder');

      await this.deps.repository.insertNotificationLog(tenantDb, {
        type: 'payment_reminder',
        channel: 'email',
        recipientPhone: payload.directorPhone,
        recipientEmail: payload.directorEmail,
        message: emailText,
        status: 'queued',
        providerRef: emailQueueRef,
      });

      await this.deps.smsQueue.add(
        'send-email',
        toEmailJobData({
          queueRef: emailQueueRef,
          to: payload.directorEmail,
          subject: `[EduTrack] Relance paiement — ${payload.schoolName}`,
          text: emailText,
          recipientPhone: payload.directorPhone,
          notificationType: 'payment_reminder',
          schemaName: payload.schemaName,
        }),
        {
          jobId: emailQueueRef,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: true,
          removeOnFail: true,
        }
      );
    });
  }
}
