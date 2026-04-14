import { randomUUID } from 'node:crypto';

import type { Queue } from 'bullmq';

import { withTenantSchema } from '../../shared/database/db.js';
import { off as defaultOff, on as defaultOn } from '../../shared/events/event-bus.js';
import type {
  EventMap,
  TeacherLatePayload,
  TeacherQrAlertPayload,
} from '../../shared/events/events.types.js';
import type { NotificationType } from '../../shared/types/index.js';

import type { NotificationSmsJobData, SmsSender } from './notifications.queue.js';
import { buildTeacherLateSms, buildTeacherQrAlertSms } from './notifications.sms.js';
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
    on: <K extends keyof Pick<EventMap, 'teacher.late' | 'teacher.qr_alert'>>(
      event: K,
      handler: (payload: EventMap[K]) => void
    ) => void;
    off: <K extends keyof Pick<EventMap, 'teacher.late' | 'teacher.qr_alert'>>(
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

export const defaultSmsSender: SmsSender = async ({ type, schemaName }) => {
  const isMock = (process.env.SMS_MOCK ?? 'true').toLowerCase() === 'true';

  if (isMock) {
    console.info(`[sms][mock] schema=${schemaName} type=${type} ref=mock`);
    return {
      status: 'sent',
      providerRef: 'mock',
    };
  }

  console.error('[notifications] SMS provider not configured (SMS_MOCK=false)');
  return {
    status: 'failed',
    errorMessage: 'SMS provider not configured',
  };
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

  start(): void {
    this.deps.eventBus.on('teacher.late', this.teacherLateListener);
    this.deps.eventBus.on('teacher.qr_alert', this.teacherQrAlertListener);
  }

  stop(): void {
    this.deps.eventBus.off('teacher.late', this.teacherLateListener);
    this.deps.eventBus.off('teacher.qr_alert', this.teacherQrAlertListener);
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
}
