import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type { Queue } from 'bullmq';

import { db, withTenantSchema } from '../../shared/database/db.js';
import { off as defaultOff, on as defaultOn } from '../../shared/events/event-bus.js';
import type {
  EventMap,
  StudentAbsentPayload,
  TeacherLatePayload,
  TeacherQrAlertPayload,
} from '../../shared/events/events.types.js';
import type { NotificationType } from '../../shared/types/index.js';

import type { NotificationSmsJobData, SmsSender } from './notifications.queue.js';
import {
  buildStudentAbsentSms,
  buildTeacherLateSms,
  buildTeacherQrAlertSms,
} from './notifications.sms.js';
import {
  defaultRepository,
  type NotificationsRepository,
  type TenantDbLike,
} from './notifications.repository.js';

type NotificationsServiceDeps = {
  withTenantSchema: <T>(
    schemaName: string,
    callback: (tenantDb: TenantDbLike) => Promise<T>
  ) => Promise<T>;
  eventBus: {
    on: <K extends keyof Pick<EventMap, 'teacher.late' | 'teacher.qr_alert' | 'student.absent'>>(
      event: K,
      handler: (payload: EventMap[K]) => void
    ) => void;
    off: <K extends keyof Pick<EventMap, 'teacher.late' | 'teacher.qr_alert' | 'student.absent'>>(
      event: K,
      handler: (payload: EventMap[K]) => void
    ) => void;
  };
  repository: NotificationsRepository;
  smsQueue: Queue<NotificationSmsJobData>;
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
    smsQueue: Queue<NotificationSmsJobData>;
  };

  constructor(deps: Partial<Omit<NotificationsServiceDeps, 'smsQueue'>> & {
    smsQueue: Queue<NotificationSmsJobData>;
  }) {
    this.deps = {
      ...defaultDeps,
      ...deps,
      eventBus: {
        ...defaultDeps.eventBus,
        ...(deps.eventBus ?? {}),
      },
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

  start(): void {
    this.deps.eventBus.on('teacher.late', this.teacherLateListener);
    this.deps.eventBus.on('teacher.qr_alert', this.teacherQrAlertListener);
    this.deps.eventBus.on('student.absent', this.studentAbsentListener);
  }

  stop(): void {
    this.deps.eventBus.off('teacher.late', this.teacherLateListener);
    this.deps.eventBus.off('teacher.qr_alert', this.teacherQrAlertListener);
    this.deps.eventBus.off('student.absent', this.studentAbsentListener);
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
      const message = buildStudentAbsentSms({
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
          removeOnComplete: true,
          removeOnFail: true,
        }
      );

      await this.deps.repository.insertNotificationLog(tenantDb, {
        type: 'student_absent_parent',
        recipientPhone: payload.parentPhone,
        message,
        status: 'queued',
        providerRef: queueRef,
        relatedId: payload.scheduleId,
      });
    });
  }
}
