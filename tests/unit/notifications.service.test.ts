import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationsService } from '../../src/modules/notifications/notifications.service.js';
import type { TeacherLatePayload, TeacherQrAlertPayload } from '../../src/shared/events/events.types.js';

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
} = {};

const eventBus = {
  on: vi.fn((event: 'teacher.late' | 'teacher.qr_alert', handler: (payload: unknown) => void) => {
    if (event === 'teacher.late') {
      eventBusHandlers['teacher.late'] = handler as (payload: TeacherLatePayload) => void;
      return;
    }

    eventBusHandlers['teacher.qr_alert'] = handler as (payload: TeacherQrAlertPayload) => void;
  }),
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
  it('start() subscribe aux events teacher.late et teacher.qr_alert', () => {
    const service = new NotificationsService({
      withTenantSchema,
      repository,
      eventBus,
      smsQueue: smsQueue as never,
    });

    service.start();

    expect(eventBus.on).toHaveBeenCalledWith('teacher.late', expect.any(Function));
    expect(eventBus.on).toHaveBeenCalledWith('teacher.qr_alert', expect.any(Function));
    expect(eventBusHandlers['teacher.late']).toBeTypeOf('function');
    expect(eventBusHandlers['teacher.qr_alert']).toBeTypeOf('function');
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
  });

  it('teacher.late queue le SMS et loggue queued', async () => {
    const service = new NotificationsService({
      withTenantSchema,
      repository,
      eventBus,
      smsQueue: smsQueue as never,
    });

    await service.handleTeacherLate(baseLatePayload);

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

    expect(repository.insertNotificationLog).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({
        type: 'teacher_late_director',
        status: 'queued',
        recipientPhone: '2250700000001',
      })
    );
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
});
