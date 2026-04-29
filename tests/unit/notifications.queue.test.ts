import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  withTenantSchema: vi.fn(),
}));

vi.mock('../../src/shared/database/db.js', () => ({
  withTenantSchema: mocks.withTenantSchema,
}));

import { processNotificationJob } from '../../src/modules/notifications/notifications.queue.js';

const tenantDb = { execute: vi.fn() };

const repository = {
  getLateAlertContext: vi.fn(),
  getQrAlertContext: vi.fn(),
  insertNotificationLog: vi.fn(),
  updateNotificationLogStatus: vi.fn(),
  markQrAlertSent: vi.fn(),
};

const smsSender = vi.fn();
const emailSender = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withTenantSchema.mockImplementation(async (_schemaName, callback) => callback(tenantDb));
  smsSender.mockResolvedValue({ status: 'sent', providerRef: 'provider-1' });
  emailSender.mockResolvedValue({ status: 'sent', providerRef: 'email-provider-1' });
});

describe('notifications.queue', () => {
  it('marque sent et met qr_alert_sent=true après envoi réussi', async () => {
    await processNotificationJob(
      {
        type: 'send-sms',
        to: '2250700000001',
        recipientPhone: '2250700000001',
        message: 'EduTrack: test',
        notificationType: 'teacher_qr_mismatch',
        schemaName: 'school_sainte_marie',
        relatedId: 'schedule-1',
        queueRef: 'notif-ref-1',
        qrAlertSentUpdate: {
          teacherId: 'teacher-1',
          scheduleId: 'schedule-1',
          date: '2026-04-14',
        },
      },
      {
        repository,
        smsSender,
        emailSender,
      }
    );

    expect(repository.updateNotificationLogStatus).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({
        queueRef: 'notif-ref-1',
        status: 'sent',
        providerRef: 'provider-1',
      })
    );
    expect(repository.markQrAlertSent).toHaveBeenCalledWith(tenantDb, {
      teacherId: 'teacher-1',
      scheduleId: 'schedule-1',
      date: '2026-04-14',
    });
  });

  it('marque failed quand le provider retourne failed', async () => {
    smsSender.mockResolvedValueOnce({ status: 'failed', errorMessage: 'quota' });

    await processNotificationJob(
      {
        type: 'send-sms',
        to: '2250700000001',
        recipientPhone: '2250700000001',
        message: 'EduTrack: test',
        notificationType: 'teacher_late_director',
        schemaName: 'school_sainte_marie',
        queueRef: 'notif-ref-2',
      },
      {
        repository,
        smsSender,
        emailSender,
      }
    );

    expect(repository.updateNotificationLogStatus).toHaveBeenCalledWith(tenantDb, {
      queueRef: 'notif-ref-2',
      status: 'failed',
    });
    expect(repository.markQrAlertSent).not.toHaveBeenCalled();
  });
});
