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
  TeacherAttendanceRejectedPayload,
  TeacherLatePayload,
  TeacherQrAlertPayload,
  TeacherQrInvalidPayload,
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
    on: <K extends keyof Pick<EventMap, 'teacher.late' | 'teacher.qr_alert' | 'teacher.qr_invalid' | 'teacher.attendance_rejected' | 'student.absent' | 'subscription.expired'>>(
      event: K,
      handler: (payload: EventMap[K]) => void
    ) => void;
    off: <K extends keyof Pick<EventMap, 'teacher.late' | 'teacher.qr_alert' | 'teacher.qr_invalid' | 'teacher.attendance_rejected' | 'student.absent' | 'subscription.expired'>>(
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
  provider: 'mock' | 'infobip' | 'africas_talking' | 'twilio' | 'orange_api' | 'custom';
  apiBaseUrl: string | null;
  apiKey: string | null;
  senderId: string;
  fallbackSenderId: string | null;
  smsMaintenanceMode: boolean;
  smsMaintenanceMessage: string;
};

let smsConfigCache: { fetchedAt: number; value: SmsPlatformRuntimeConfig } | null = null;
let orangeTokenCache: { cacheKey: string; value: string; expiresAt: number } | null = null;

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
  }>(sql.raw(`
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
  `));

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

const resolveOrangeCredentials = (config: SmsPlatformRuntimeConfig): {
  clientId: string;
  clientSecret: string;
  senderAddress: string;
  senderName: string;
  smsBaseUrl: string;
  tokenUrl: string;
} | null => {
  const configuredKey = config.apiKey?.trim();
  const separatorIndex = configuredKey?.indexOf(':') ?? -1;
  const clientId =
    (separatorIndex > 0 ? configuredKey?.slice(0, separatorIndex).trim() : '') ||
    process.env.ORANGE_CLIENT_ID?.trim() ||
    '';
  const clientSecret =
    (separatorIndex > 0 ? configuredKey?.slice(separatorIndex + 1).trim() : configuredKey ?? '') ||
    process.env.ORANGE_CLIENT_SECRET?.trim() ||
    '';
  const configuredSenderAddress =
    config.senderId.trim() && config.senderId.trim() !== 'EduTrack'
      ? config.senderId.trim()
      : '';
  const senderAddress = normalizeSmsRecipient(
    configuredSenderAddress || process.env.ORANGE_SENDER_ADDRESS?.trim() || ''
  );
  const senderName =
    config.fallbackSenderId !== null
      ? config.fallbackSenderId.trim()
      : process.env.ORANGE_SENDER_NAME?.trim() || '';
  const smsBaseUrl =
    config.apiBaseUrl?.trim() ||
    process.env.ORANGE_SMS_BASE_URL?.trim() ||
    'https://api.orange.com/smsmessaging/v1/outbound';
  const tokenUrl =
    process.env.ORANGE_TOKEN_URL?.trim() || 'https://api.orange.com/oauth/v3/token';

  if (!clientId || !clientSecret || !senderAddress) {
    return null;
  }

  return {
    clientId,
    clientSecret,
    senderAddress,
    senderName,
    smsBaseUrl,
    tokenUrl,
  };
};

const getOrangeAccessToken = async (credentials: {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
}): Promise<string> => {
  const now = Date.now();
  const cacheKey = `${credentials.tokenUrl}:${credentials.clientId}`;
  if (orangeTokenCache?.cacheKey === cacheKey && orangeTokenCache.expiresAt > now) {
    return orangeTokenCache.value;
  }

  const basicCredentials = Buffer.from(
    `${credentials.clientId}:${credentials.clientSecret}`
  ).toString('base64');
  const response = await fetch(credentials.tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicCredentials}`,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    return Promise.reject(
      new Error(`Orange OAuth2 error (${response.status})${errorText ? `: ${errorText}` : ''}`)
    );
  }

  const payload = (await response.json().catch(() => ({} as Record<string, unknown>))) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!payload.access_token) {
    return Promise.reject(new Error('Orange OAuth2 response missing access_token'));
  }

  const expiresInSeconds = Math.max((payload.expires_in ?? 3600) - 300, 60);
  orangeTokenCache = {
    cacheKey,
    value: payload.access_token,
    expiresAt: now + expiresInSeconds * 1000,
  };
  return payload.access_token;
};

const sendOrangeSms = async (params: {
  to: string;
  message: string;
  config: SmsPlatformRuntimeConfig;
}): Promise<{ status: 'sent' | 'failed'; providerRef?: string; errorMessage?: string }> => {
  const credentials = resolveOrangeCredentials(params.config);
  if (!credentials) {
    return {
      status: 'failed',
      errorMessage:
        'Missing Orange SMS client credentials or sender address',
    };
  }

  const recipient = normalizeSmsRecipient(params.to);
  if (!recipient) {
    return { status: 'failed', errorMessage: 'Missing Orange SMS recipient' };
  }

  try {
    const accessToken = await getOrangeAccessToken(credentials);
    const senderAddress = `tel:${credentials.senderAddress}`;
    const smsBaseUrl = credentials.smsBaseUrl.replace(/\/+$/, '');
    const outboundBaseUrl = /\/outbound$/.test(smsBaseUrl)
      ? smsBaseUrl
      : `${smsBaseUrl}/outbound`;
    const endpoint = `${outboundBaseUrl}/${encodeURIComponent(
      senderAddress
    )}/requests`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        outboundSMSMessageRequest: {
          address: `tel:${recipient}`,
          senderAddress,
          outboundSMSTextMessage: {
            message: params.message,
          },
          ...(credentials.senderName ? { senderName: credentials.senderName } : {}),
        },
      }),
    });

    const payloadText = await response.text().catch(() => '');
    let payload: {
      outboundSMSMessageRequest?: { resourceURL?: string };
      resourceURL?: string;
      status?: string;
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
      if (response.status === 401) {
        orangeTokenCache = null;
      }
      return {
        status: 'failed',
        errorMessage: `Orange SMS error (${response.status})${payloadText ? `: ${payloadText}` : ''}`,
      };
    }

    return {
      status: 'sent',
      providerRef:
        payload.outboundSMSMessageRequest?.resourceURL ??
        payload.resourceURL ??
        randomUUID(),
    };
  } catch (error) {
    return {
      status: 'failed',
      errorMessage: error instanceof Error ? error.message : 'Orange SMS error',
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

  if (config.provider === 'orange_api') {
    return sendOrangeSms({
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
  const mockEnabled = (process.env.EMAIL_MOCK ?? 'true').toLowerCase() === 'true';
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
    if (this._started) return;
    this._started = true;
    if (this.deps.eventBus.on === defaultOn) {
      this.deps.eventBus.on('teacher.late', this.teacherLateListener);
      this.deps.eventBus.on('teacher.qr_alert', this.teacherQrAlertListener);
      this.deps.eventBus.on('teacher.qr_invalid', this.teacherQrInvalidListener);
      this.deps.eventBus.on(
        'teacher.attendance_rejected',
        this.teacherAttendanceRejectedListener
      );
    }
    this.deps.eventBus.on('student.absent', this.studentAbsentListener);
    this.deps.eventBus.on('subscription.expired', this.subscriptionExpiredListener);
  }

  stop(): void {
    this._started = false;
    if (this.deps.eventBus.off === defaultOff) {
      this.deps.eventBus.off('teacher.late', this.teacherLateListener);
      this.deps.eventBus.off('teacher.qr_alert', this.teacherQrAlertListener);
      this.deps.eventBus.off('teacher.qr_invalid', this.teacherQrInvalidListener);
      this.deps.eventBus.off(
        'teacher.attendance_rejected',
        this.teacherAttendanceRejectedListener
      );
    }
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

  async handleTeacherQrInvalid(payload: TeacherQrInvalidPayload): Promise<void> {
    await this.deps.withTenantSchema(payload.schemaName, async (tenantDb) => {
      const result = await (tenantDb as {
        execute: <TRow = Record<string, unknown>>(query: unknown) => Promise<{ rows: TRow[] }>;
      }).execute<{
        director_phone: string | null;
        director_email: string | null;
      }>(sql`
        SELECT u.phone AS director_phone, u.email AS director_email
        FROM users u
        WHERE u.role = 'director'
          AND u.is_active = true
          AND (u.phone IS NOT NULL OR u.email IS NOT NULL)
        ORDER BY u.created_at ASC
        LIMIT 1
      `);
      const director = result.rows[0];
      if (!director?.director_phone && !director?.director_email) {
        return;
      }

      const scanTime = new Date(payload.timestamp).toLocaleTimeString('fr-FR', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Africa/Abidjan',
      });
      const message = `[EduTrack] ${payload.teacherName} a tenté de scanner un QR inconnu à ${scanTime}. Accès refusé.`;
      const tasks: Array<Promise<void>> = [];

      if (director.director_phone) {
        const queueRef = buildQueueRef(payload.schemaName, 'qr_invalid_alert');
        await this.deps.repository.insertNotificationLog(tenantDb, {
          type: 'qr_invalid_alert',
          channel: 'sms',
          recipientPhone: director.director_phone,
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
              to: director.director_phone,
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

      if (director.director_email) {
        const emailQueueRef = buildQueueRef(payload.schemaName, 'qr_invalid_alert');
        const emailText = `${payload.teacherName} a tenté de scanner un QR non reconnu le ${payload.timestamp}. QR: ${payload.qrToken}.`;
        await this.deps.repository.insertNotificationLog(tenantDb, {
          type: 'qr_invalid_alert',
          channel: 'email',
          recipientPhone: director.director_phone ?? '',
          recipientEmail: director.director_email,
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
              to: director.director_email,
              subject: 'Alerte sécurité - QR non reconnu',
              text: emailText,
              recipientPhone: director.director_phone ?? '',
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

      await (tenantDb as NodePgDatabase<Record<string, unknown>>).execute(sql`
        WITH target AS (
          SELECT id
          FROM notifications_log
          WHERE type = 'attendance_rejected'
            AND channel = 'email'
            AND related_id = ${payload.attendanceId}::uuid
            AND recipient_id = ${payload.teacherUserId}::uuid
          ORDER BY created_at DESC
          LIMIT 1
        )
        UPDATE notifications_log
        SET
          provider_ref = ${queueRef},
          message = ${text},
          recipient_email = ${teacherEmail},
          status = 'queued'
        WHERE id IN (SELECT id FROM target)
      `);

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
    await this.deps.repository.insertNotificationLog(tenantDb, {
      type: 'student_absent_parent',
      channel: 'sms',
      recipientPhone,
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
    if (canSendEmail.subscriptionId) {
      await subscriptionsService.incrementUsage({
        studentId: payload.studentId,
        subscriptionId: canSendEmail.subscriptionId,
        type: 'email',
      });
    }
  }

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

        await this.deps.repository.insertNotificationLog(tenantDb, {
          type: 'student_absent_parent',
          channel: 'sms',
          recipientPhone: contact.parent_phone,
          message,
          status: 'queued',
          providerRef: queueRef,
          relatedId: payload.scheduleId,
        });

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
        channel: 'sms',
        recipientPhone: payload.directorPhone,
        message,
        status: 'queued',
        providerRef: queueRef,
      });

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

      await this.deps.repository.insertNotificationLog(tenantDb, {
        type: 'payment_reminder',
        channel: 'email',
        recipientPhone: payload.directorPhone,
        recipientEmail: payload.directorEmail,
        message: emailText,
        status: 'queued',
        providerRef: emailQueueRef,
      });
    });
  }
}
