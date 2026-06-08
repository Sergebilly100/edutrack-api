import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dbExecute: vi.fn(),
  withTenantSchema: vi.fn(),
}));

vi.mock('../../src/shared/database/db.js', () => ({
  db: {
    execute: mocks.dbExecute,
  },
  withTenantSchema: mocks.withTenantSchema,
}));

import {
  processNotificationJob,
  buildDeferredAbsentJobId,
} from '../../src/modules/notifications/notifications.queue.js';

const tenantDb = { execute: vi.fn() };

const repository = {
  getLateAlertContext: vi.fn(),
  getQrAlertContext: vi.fn(),
  insertNotificationLog: vi.fn(),
  updateNotificationLogStatus: vi.fn(),
  markQrAlertSent: vi.fn(),
  getTeacherDailySummaryContext: vi.fn(),
};

const smsSender = vi.fn();
const emailSender = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dbExecute.mockResolvedValue({ rows: [] });
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

  it('envoie le résumé quotidien profs aux directeurs des écoles actives (email uniquement)', async () => {
    mocks.dbExecute.mockResolvedValueOnce({
      rows: [
        { id: 'tenant-1', schema_name: 'school_sainte_marie', name: 'Sainte Marie' },
        { id: 'tenant-2', schema_name: 'school_belle_vue', name: 'Belle Vue' },
      ],
    });
    repository.getTeacherDailySummaryContext
      .mockResolvedValueOnce({
        directorPhone: '2250700000001',
        directorEmail: 'directeur@sainte-marie.ci',
        totalCourses: 8,
        presentCount: 5,
        lateCount: 1,
        absentCount: 2,
      })
      .mockResolvedValueOnce({
        directorPhone: null,
        directorEmail: null,
        totalCourses: 4,
        presentCount: 4,
        lateCount: 0,
        absentCount: 0,
      });

    await processNotificationJob(
      {
        type: 'teacher-daily-summary-all',
        date: '2026-05-02',
      },
      {
        repository,
        smsSender,
        emailSender,
      }
    );

    expect(mocks.withTenantSchema).toHaveBeenCalledTimes(2);
    // SMS bilan désactivé (décision produit 2026-05) - seul l'email part.
    expect(repository.insertNotificationLog).toHaveBeenCalledTimes(1);
    expect(repository.insertNotificationLog).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({
        type: 'teacher_absent_director',
        channel: 'email',
        recipientEmail: 'directeur@sainte-marie.ci',
        status: 'queued',
      })
    );
    expect(smsSender).not.toHaveBeenCalled();
    expect(emailSender).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'directeur@sainte-marie.ci',
        type: 'teacher_absent_director',
        schemaName: 'school_sainte_marie',
      })
    );
  });

  it('envoie aussi le résumé quotidien profs par email si le directeur a un email', async () => {
    mocks.dbExecute.mockResolvedValueOnce({
      rows: [{ id: 'tenant-1', schema_name: 'school_sainte_marie', name: 'Sainte Marie' }],
    });
    repository.getTeacherDailySummaryContext.mockResolvedValueOnce({
      directorPhone: '2250700000001',
      directorEmail: 'directeur@test.ci',
      totalCourses: 8,
      presentCount: 5,
      lateCount: 1,
      absentCount: 2,
    });

    await processNotificationJob(
      {
        type: 'teacher-daily-summary-all',
        date: '2026-05-02',
      },
      {
        repository,
        smsSender,
        emailSender,
      }
    );

    expect(repository.insertNotificationLog).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({
        type: 'teacher_absent_director',
        channel: 'email',
        recipientEmail: 'directeur@test.ci',
        status: 'queued',
      })
    );
    expect(emailSender).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'directeur@test.ci',
        subject: '[IvoirEdu] Bilan présences du 2026-05-02 - Sainte Marie',
        type: 'teacher_absent_director',
      })
    );
    expect(repository.updateNotificationLogStatus).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({
        status: 'sent',
        providerRef: 'email-provider-1',
      })
    );
  });

  it('buildDeferredAbsentJobId() produit un ID déterministe', () => {
    const id1 = buildDeferredAbsentJobId('school_abc', 'sched-1', 'stu-1', '2026-06-07');
    const id2 = buildDeferredAbsentJobId('school_abc', 'sched-1', 'stu-1', '2026-06-07');
    expect(id1).toBe(id2);
    expect(id1).toBe('deferred-absent__school_abc__sched-1__stu-1__2026-06-07');
  });

  it('buildDeferredAbsentJobId() ne contient pas ":" (interdit par BullMQ pour un jobId custom)', () => {
    // Régression critique : un jobId avec ':' fait échouer queue.add (avalé par
    // Promise.allSettled) → aucun job différé → aucune notification d'absence.
    const id = buildDeferredAbsentJobId('school_abc', 'sched-1', 'stu-1', '2026-06-07');
    expect(id).not.toContain(':');
  });

  it('buildDeferredAbsentJobId() produit des IDs distincts pour des étudiants différents', () => {
    const id1 = buildDeferredAbsentJobId('school_abc', 'sched-1', 'stu-1', '2026-06-07');
    const id2 = buildDeferredAbsentJobId('school_abc', 'sched-1', 'stu-2', '2026-06-07');
    expect(id1).not.toBe(id2);
  });

  it('processNotificationJob() appelle onDeferredStudentAbsent pour deferred-student-absent', async () => {
    const onDeferredStudentAbsent = vi.fn();
    const payload = {
      type: 'deferred-student-absent' as const,
      schemaName: 'school_sainte_marie',
      tenantId: 'tenant-1',
      studentId: 'student-1',
      scheduleId: 'schedule-1',
      studentFirstName: 'Awa',
      parentPhone: '2250700000001',
      subject: 'Maths',
      date: '2026-06-07',
      schoolPhone: '2250700000099',
    };

    await processNotificationJob(payload, {
      repository,
      smsSender,
      emailSender,
      onDeferredStudentAbsent,
    });

    expect(onDeferredStudentAbsent).toHaveBeenCalledOnce();
    expect(onDeferredStudentAbsent).toHaveBeenCalledWith(payload);
    expect(smsSender).not.toHaveBeenCalled();
  });

  it('processNotificationJob() fonctionne sans onDeferredStudentAbsent (callback optionnel)', async () => {
    await expect(
      processNotificationJob(
        {
          type: 'deferred-student-absent' as const,
          schemaName: 'school_sainte_marie',
          tenantId: 'tenant-1',
          studentId: 'student-1',
          scheduleId: 'schedule-1',
          studentFirstName: 'Awa',
          parentPhone: '2250700000001',
          subject: 'Maths',
          date: '2026-06-07',
          schoolPhone: '2250700000099',
        },
        { repository, smsSender, emailSender }
      )
    ).resolves.not.toThrow();
    expect(smsSender).not.toHaveBeenCalled();
  });
});
