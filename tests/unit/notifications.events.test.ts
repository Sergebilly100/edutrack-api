import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationsService } from '../../src/modules/notifications/notifications.service.js';
import { SubscriptionsRepository } from '../../src/modules/subscriptions/subscriptions.repository.js';
import { emit, off, on } from '../../src/shared/events/event-bus.js';

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

const withTenantSchema = vi.fn();
const tenantDb = { execute: vi.fn() };

let service: NotificationsService | null = null;

beforeEach(() => {
  vi.clearAllMocks();

  withTenantSchema.mockImplementation(async (_schemaName, callback) => callback(tenantDb));
  smsQueue.add.mockResolvedValue({ id: 'job-1' });

  // Mock SubscriptionsRepository used by handleStudentAbsent
  vi.spyOn(SubscriptionsRepository.prototype, 'getTenantIdBySchemaName').mockResolvedValue('tenant-1');
  vi.spyOn(SubscriptionsRepository.prototype, 'getSmsFeatureByTenantId').mockResolvedValue({
    tenant_id: 'tenant-1',
    is_enabled: true,
    monetize_parent_alerts: false,
    sms_cap_per_student: 10,
    commission_pct: 15,
    sms_unit_price_fcfa: 2000,
    use_real_hours: false,
    geo_check_enabled: false,
    checkout_tolerance_minutes: 5,
  });
  vi.spyOn(SubscriptionsRepository.prototype, 'listParentAlertContactsByStudent').mockResolvedValue([
    {
      parent_id: 'parent-1',
      subscription_id: null,
      parent_phone: '2250700000009',
      parent_email: null,
      ends_at: null,
      subscription_status: null,
    },
  ]);
  vi.spyOn(SubscriptionsRepository.prototype, 'getUsageByStudentMonth').mockResolvedValue({ sms: 0, email: 0 });
  vi.spyOn(SubscriptionsRepository.prototype, 'incrementUsage').mockResolvedValue(undefined);

  repository.getLateAlertContext.mockResolvedValue({
    teacherName: 'Kouassi Awa',
    subject: 'Mathématiques',
    className: '3ème A',
    slotLabel: '07h30-09h00',
    directorPhone: '2250700000001',
  });

  repository.getQrAlertContext.mockResolvedValue({
    teacherName: 'Kouassi Awa',
    subject: 'Mathématiques',
    className: '3ème A',
    slotLabel: '07h30-09h00',
    expectedRoom: 'Salle A1',
    scannedRoom: 'Salle B2',
    directorPhone: '2250700000001',
  });

  service = new NotificationsService({
    withTenantSchema,
    repository,
    smsQueue: smsQueue as never,
    eventBus: { on, off },
  });
  service.start();
});

afterEach(() => {
  service?.stop();
  service = null;
});

describe('notifications event-bus integration', () => {
  it('emit(teacher.late) déclenche la mise en queue + log queued', async () => {
    emit('teacher.late', {
      tenantId: 'tenant-1',
      schemaName: 'school_sainte_marie',
      teacherId: 'teacher-1',
      scheduleId: 'schedule-1',
      date: '2026-04-14',
      checkedInAt: '2026-04-14T07:42:00.000Z',
      checkedInVia: 'app',
      lateMinutes: 12,
    });

    await vi.waitFor(() => {
      expect(smsQueue.add).toHaveBeenCalledTimes(1);
    });

    expect(smsQueue.add).toHaveBeenCalledWith(
      'send-sms',
      expect.objectContaining({
        notificationType: 'teacher_late_director',
      }),
      expect.any(Object)
    );

    expect(repository.insertNotificationLog).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({
        type: 'teacher_late_director',
        status: 'queued',
      })
    );
  });

  it('emit(teacher.qr_alert) loggue en base sans SMS (dashboard only)', async () => {
    emit('teacher.qr_alert', {
      tenantId: 'tenant-1',
      schemaName: 'school_sainte_marie',
      teacherId: 'teacher-1',
      scheduleId: 'schedule-1',
      date: '2026-04-14',
      alertType: 'teacher_qr_mismatch',
      roomMismatch: true,
    });

    await vi.waitFor(() => {
      expect(repository.insertNotificationLog).toHaveBeenCalledTimes(1);
    });

    expect(smsQueue.add).not.toHaveBeenCalled();
    expect(repository.insertNotificationLog).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({
        type: 'teacher_qr_mismatch',
        status: 'skipped_unknown',
      })
    );
  });

  it('emit(student.absent) queue un SMS parent + log queued', async () => {
    emit('student.absent', {
      tenantId: 'tenant-1',
      schemaName: 'school_sainte_marie',
      studentId: 'student-1',
      scheduleId: 'schedule-1',
      studentFirstName: 'Awa',
      parentPhone: '2250700000009',
      subject: 'Mathématiques',
      date: '2026-04-14',
      schoolPhone: '2250700000001',
    });

    await vi.waitFor(() => {
      expect(smsQueue.add).toHaveBeenCalledTimes(1);
    });

    expect(smsQueue.add).toHaveBeenCalledWith(
      'send-sms',
      expect.objectContaining({
        notificationType: 'student_absent_parent',
        to: '2250700000009',
        relatedId: 'schedule-1',
      }),
      expect.any(Object)
    );

    expect(repository.insertNotificationLog).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({
        type: 'student_absent_parent',
        recipientPhone: '2250700000009',
        status: 'queued',
      })
    );
  });
});
