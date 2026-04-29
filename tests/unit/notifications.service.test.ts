import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SMS_MAX_LENGTH } from '../../src/modules/notifications/notifications.sms.js';
import { NotificationsService } from '../../src/modules/notifications/notifications.service.js';
import { SubscriptionsService } from '../../src/modules/subscriptions/subscriptions.service.js';
import type {
  StudentAbsentPayload,
  TeacherLatePayload,
  TeacherQrAlertPayload,
} from '../../src/shared/events/events.types.js';

const repository = {
  getLateAlertContext: vi.fn(),
  getQrAlertContext: vi.fn(),
  insertNotificationLog: vi.fn(),
  updateNotificationLogStatus: vi.fn(),
  markQrAlertSent: vi.fn(),
};

const smsQueue = {
  add: vi.fn(),
};

const smsSender = vi.fn();
const withTenantSchema = vi.fn();

const eventBusHandlers: {
  'teacher.late'?: (payload: TeacherLatePayload) => void;
  'teacher.qr_alert'?: (payload: TeacherQrAlertPayload) => void;
  'student.absent'?: (payload: StudentAbsentPayload) => void;
} = {};

const eventBus = {
  on: vi.fn(
    (
      event: 'teacher.late' | 'teacher.qr_alert' | 'student.absent',
      handler: (payload: unknown) => void
    ) => {
    if (event === 'teacher.late') {
      eventBusHandlers['teacher.late'] = handler as (payload: TeacherLatePayload) => void;
      return;
    }

      if (event === 'teacher.qr_alert') {
        eventBusHandlers['teacher.qr_alert'] = handler as (payload: TeacherQrAlertPayload) => void;
        return;
      }

      eventBusHandlers['student.absent'] = handler as (payload: StudentAbsentPayload) => void;
    }
  ),
  off: vi.fn(),
};

const tenantDb = { execute: vi.fn() };

const baseContext = {
  teacherName: 'Kouassi Awa',
  subject: 'Mathématiques',
  className: '3ème A',
  slotLabel: '07h30-09h00',
  directorPhone: '2250700000001',
};

const baseLatePayload: TeacherLatePayload = {
  tenantId: 'tenant-1',
  schemaName: 'school_sainte_marie',
  teacherId: 'teacher-1',
  scheduleId: 'schedule-1',
  date: '2026-04-14',
  checkedInAt: '2026-04-14T07:42:00.000Z',
  checkedInVia: 'app',
  lateMinutes: 12,
};

beforeEach(() => {
  vi.clearAllMocks();
  eventBusHandlers['teacher.late'] = undefined;
  eventBusHandlers['teacher.qr_alert'] = undefined;
  eventBusHandlers['student.absent'] = undefined;

  withTenantSchema.mockImplementation(async (_schemaName, callback) => callback(tenantDb));
  smsQueue.add.mockResolvedValue({ id: 'job-1' });

  repository.getLateAlertContext.mockResolvedValue(baseContext);

  repository.getQrAlertContext.mockResolvedValue({
    ...baseContext,
    expectedRoom: 'Salle A1',
    scannedRoom: 'Salle B2',
  });
});

describe('notifications.service', () => {
  it('start() subscribe aux events teacher.late, teacher.qr_alert et student.absent', () => {
    const service = new NotificationsService({
      withTenantSchema,
      repository,
      eventBus,
      smsQueue: smsQueue as never,
    });

    service.start();

    expect(eventBus.on).toHaveBeenCalledWith('teacher.late', expect.any(Function));
    expect(eventBus.on).toHaveBeenCalledWith('teacher.qr_alert', expect.any(Function));
    expect(eventBus.on).toHaveBeenCalledWith('student.absent', expect.any(Function));
    expect(eventBusHandlers['teacher.late']).toBeTypeOf('function');
    expect(eventBusHandlers['teacher.qr_alert']).toBeTypeOf('function');
    expect(eventBusHandlers['student.absent']).toBeTypeOf('function');
  });

  it('stop() désinscrit les deux listeners', () => {
    const service = new NotificationsService({
      withTenantSchema,
      repository,
      eventBus,
      smsQueue: smsQueue as never,
    });

    service.start();
    service.stop();

    expect(eventBus.off).toHaveBeenCalledWith('teacher.late', expect.any(Function));
    expect(eventBus.off).toHaveBeenCalledWith('teacher.qr_alert', expect.any(Function));
    expect(eventBus.off).toHaveBeenCalledWith('student.absent', expect.any(Function));
  });

  it('teacher.late queue le SMS et loggue queued', async () => {
    const service = new NotificationsService({
      withTenantSchema,
      repository,
      eventBus,
      smsQueue: smsQueue as never,
    });

    await service.handleTeacherLate(baseLatePayload);

    const smsData = smsQueue.add.mock.calls[0]?.[1];

    expect(smsQueue.add).toHaveBeenCalledWith(
      'send-sms',
      expect.objectContaining({
        type: 'send-sms',
        to: '2250700000001',
        notificationType: 'teacher_late_director',
      }),
      expect.objectContaining({
        jobId: expect.stringContaining('notif:school_sainte_marie:teacher_late_director:'),
      })
    );
    expect(smsData?.message).toContain('Kouassi Awa');
    expect((smsData?.message as string).length).toBeLessThanOrEqual(SMS_MAX_LENGTH);

    expect(repository.insertNotificationLog).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({
        type: 'teacher_late_director',
        status: 'queued',
        recipientPhone: '2250700000001',
      })
    );
  });

  it('teacher.late garde un message <= SMS_MAX_LENGTH avec nom long (30 chars)', async () => {
    repository.getLateAlertContext.mockResolvedValueOnce({
      teacherName: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234',
      subject: 'Mathématiques avancées',
      className: 'Terminale D1',
      slotLabel: '07h30-09h00',
      directorPhone: '2250700000001',
    });

    const service = new NotificationsService({
      withTenantSchema,
      repository,
      eventBus,
      smsQueue: smsQueue as never,
    });

    await service.handleTeacherLate(baseLatePayload);

    const smsData = smsQueue.add.mock.calls[0]?.[1];
    expect((smsData?.message as string).length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
  });

  it('teacher.late sans directorPhone ne déclenche pas de SMS', async () => {
    repository.getLateAlertContext.mockResolvedValueOnce({
      ...baseContext,
      directorPhone: null,
    });

    const service = new NotificationsService({
      withTenantSchema,
      repository,
      eventBus,
      smsQueue: smsQueue as never,
    });

    await service.handleTeacherLate(baseLatePayload);

    expect(smsQueue.add).not.toHaveBeenCalled();
    expect(smsSender).not.toHaveBeenCalled();
  });

  it('teacher.late avec contexte null ne déclenche pas de SMS', async () => {
    repository.getLateAlertContext.mockResolvedValueOnce(null);

    const service = new NotificationsService({
      withTenantSchema,
      repository,
      eventBus,
      smsQueue: smsQueue as never,
    });

    await service.handleTeacherLate(baseLatePayload);

    expect(smsQueue.add).not.toHaveBeenCalled();
    expect(smsSender).not.toHaveBeenCalled();
  });

  it('teacher.qr_alert queue le SMS avec demande de mise à jour qr_alert_sent', async () => {
    const service = new NotificationsService({
      withTenantSchema,
      repository,
      eventBus,
      smsQueue: smsQueue as never,
    });

    const payload: TeacherQrAlertPayload = {
      tenantId: 'tenant-1',
      schemaName: 'school_sainte_marie',
      teacherId: 'teacher-1',
      scheduleId: 'schedule-1',
      date: '2026-04-14',
      alertType: 'teacher_qr_mismatch',
      roomMismatch: true,
    };

    await service.handleTeacherQrAlert(payload);

    expect(smsQueue.add).toHaveBeenCalledWith(
      'send-sms',
      expect.objectContaining({
        notificationType: 'teacher_qr_mismatch',
        qrAlertSentUpdate: {
          teacherId: 'teacher-1',
          scheduleId: 'schedule-1',
          date: '2026-04-14',
        },
      }),
      expect.objectContaining({
        jobId: expect.stringContaining('notif:school_sainte_marie:teacher_qr_mismatch:'),
      })
    );

    expect(repository.insertNotificationLog).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({
        type: 'teacher_qr_mismatch',
        status: 'queued',
      })
    );
  });

  it('student.absent queue le SMS parent et loggue queued', async () => {
    vi.spyOn(SubscriptionsService.prototype, 'canSendNotification').mockResolvedValueOnce({
      allowed: true,
      subscriptionId: 'sub-1',
      parentPhone: '2250700000001',
      parentEmail: null,
    });
    vi.spyOn(SubscriptionsService.prototype, 'incrementUsage').mockResolvedValueOnce(undefined);

    const service = new NotificationsService({
      withTenantSchema,
      repository,
      eventBus,
      smsQueue: smsQueue as never,
    });

    const payload: StudentAbsentPayload = {
      tenantId: 'tenant-1',
      schemaName: 'school_sainte_marie',
      studentId: 'student-1',
      scheduleId: 'schedule-1',
      studentFirstName: 'Awa',
      parentPhone: '2250700000001',
      subject: 'Maths',
      date: '2026-04-14',
      schoolPhone: '2250701234567',
    };

    await service.handleStudentAbsent(payload);

    expect(smsQueue.add).toHaveBeenCalledWith(
      'send-sms',
      expect.objectContaining({
        type: 'send-sms',
        to: '2250700000001',
        notificationType: 'student_absent_parent',
        relatedId: 'schedule-1',
      }),
      expect.objectContaining({
        jobId: expect.stringContaining('notif:school_sainte_marie:student_absent_parent:'),
      })
    );

    expect(repository.insertNotificationLog).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({
        type: 'student_absent_parent',
        recipientPhone: '2250700000001',
        status: 'queued',
        relatedId: 'schedule-1',
      })
    );
  });

  it('student.absent sans souscription active loggue skipped_no_active_subscription', async () => {
    vi.spyOn(SubscriptionsService.prototype, 'canSendNotification').mockResolvedValueOnce({
      allowed: false,
      reason: 'no_active_subscription',
    });

    const service = new NotificationsService({
      withTenantSchema,
      repository,
      eventBus,
      smsQueue: smsQueue as never,
    });

    await service.handleStudentAbsent({
      tenantId: 'tenant-1',
      schemaName: 'school_sainte_marie',
      studentId: 'student-1',
      scheduleId: 'schedule-1',
      studentFirstName: 'Awa',
      parentPhone: '2250700000001',
      subject: 'Maths',
      date: '2026-04-14',
      schoolPhone: '2250701234567',
    });

    expect(smsQueue.add).not.toHaveBeenCalled();
    expect(repository.insertNotificationLog).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({ status: 'skipped_no_active_subscription' })
    );
  });

  it('student.absent cap atteint loggue skipped_cap_reached', async () => {
    vi.spyOn(SubscriptionsService.prototype, 'canSendNotification').mockResolvedValueOnce({
      allowed: false,
      reason: 'cap_reached',
    });

    const service = new NotificationsService({
      withTenantSchema,
      repository,
      eventBus,
      smsQueue: smsQueue as never,
    });

    await service.handleStudentAbsent({
      tenantId: 'tenant-1',
      schemaName: 'school_sainte_marie',
      studentId: 'student-1',
      scheduleId: 'schedule-1',
      studentFirstName: 'Awa',
      parentPhone: '2250700000001',
      subject: 'Maths',
      date: '2026-04-14',
      schoolPhone: '2250701234567',
    });

    expect(smsQueue.add).not.toHaveBeenCalled();
    expect(repository.insertNotificationLog).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({ status: 'skipped_cap_reached' })
    );
  });

  it('student.absent feature désactivée loggue skipped_feature_disabled', async () => {
    vi.spyOn(SubscriptionsService.prototype, 'canSendNotification').mockResolvedValueOnce({
      allowed: false,
      reason: 'feature_disabled',
    });

    const service = new NotificationsService({
      withTenantSchema,
      repository,
      eventBus,
      smsQueue: smsQueue as never,
    });

    await service.handleStudentAbsent({
      tenantId: 'tenant-1',
      schemaName: 'school_sainte_marie',
      studentId: 'student-1',
      scheduleId: 'schedule-1',
      studentFirstName: 'Awa',
      parentPhone: '2250700000001',
      subject: 'Maths',
      date: '2026-04-14',
      schoolPhone: '2250701234567',
    });

    expect(smsQueue.add).not.toHaveBeenCalled();
    expect(repository.insertNotificationLog).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({ status: 'skipped_feature_disabled' })
    );
  });

  it('student.absent avec email parent actif queue aussi un email et incrémente email usage', async () => {
    vi.spyOn(SubscriptionsService.prototype, 'canSendNotification')
      .mockResolvedValueOnce({
        allowed: true,
        subscriptionId: 'sub-1',
        parentPhone: '2250700000001',
        parentEmail: 'parent@test.ci',
      })
      .mockResolvedValueOnce({
        allowed: true,
        subscriptionId: 'sub-1',
        parentPhone: '2250700000001',
        parentEmail: 'parent@test.ci',
      });
    const incrementSpy = vi
      .spyOn(SubscriptionsService.prototype, 'incrementUsage')
      .mockResolvedValue(undefined);

    const service = new NotificationsService({
      withTenantSchema,
      repository,
      eventBus,
      smsQueue: smsQueue as never,
    });

    await service.handleStudentAbsent({
      tenantId: 'tenant-1',
      schemaName: 'school_sainte_marie',
      studentId: 'student-1',
      scheduleId: 'schedule-1',
      studentFirstName: 'Awa',
      parentPhone: '2250700000001',
      subject: 'Maths',
      date: '2026-04-14',
      schoolPhone: '2250701234567',
    });

    expect(smsQueue.add).toHaveBeenNthCalledWith(
      1,
      'send-sms',
      expect.objectContaining({ type: 'send-sms' }),
      expect.any(Object)
    );
    expect(smsQueue.add).toHaveBeenNthCalledWith(
      2,
      'send-email',
      expect.objectContaining({
        type: 'send-email',
        to: 'parent@test.ci',
        notificationType: 'student_absent_parent',
      }),
      expect.any(Object)
    );
    expect(incrementSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sms' })
    );
    expect(incrementSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'email' })
    );
    expect(repository.insertNotificationLog).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({
        channel: 'email',
        recipientEmail: 'parent@test.ci',
        status: 'queued',
      })
    );
  });
});
