import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const eventMocks = vi.hoisted(() => ({
  emitStudentAbsent: vi.fn(),
  emitTeacherCheckedIn: vi.fn(),
  emitTeacherLate: vi.fn(),
  emitTeacherQrAlert: vi.fn(),
}));

const schedulerMocks = vi.hoisted(() => ({
  scheduleQrMissingScanCheck: vi.fn(),
}));

vi.mock('../../src/modules/attendance/attendance.events.js', () => ({
  emitStudentAbsent: eventMocks.emitStudentAbsent,
  emitTeacherCheckedIn: eventMocks.emitTeacherCheckedIn,
  emitTeacherLate: eventMocks.emitTeacherLate,
  emitTeacherQrAlert: eventMocks.emitTeacherQrAlert,
}));

vi.mock('../../src/modules/attendance/attendance.scheduler.js', () => ({
  scheduleQrMissingScanCheck: schedulerMocks.scheduleQrMissingScanCheck,
}));

import { AttendanceService } from '../../src/modules/attendance/attendance.service.js';

const repository = {
  findTeacherByUserId: vi.fn(),
  findScheduleContextForTeacher: vi.fn(),
  upsertCheckIn: vi.fn(),
  findRoomByToken: vi.fn(),
  ensureAttendanceRecord: vi.fn(),
  recordQrScan: vi.fn(),
  listActiveAttendanceForTeacher: vi.fn(),
  listMissingQrScans: vi.fn(),
  markQrAlertSent: vi.fn(),
  listStudentsByClass: vi.fn(),
  bulkUpsertStudentAttendance: vi.fn(),
  listStudentAbsenceNotificationCandidates: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('attendance.service', () => {
  it('checkIn() en retard (>15min) émet teacher.late et programme le check QR manquant', async () => {
    vi.setSystemTime(new Date('2026-04-14T07:50:00.000Z'));
    repository.findTeacherByUserId.mockResolvedValue({ id: 'teacher-1' });
    repository.findScheduleContextForTeacher.mockResolvedValue({
      scheduleId: 'schedule-1',
      teacherId: 'teacher-1',
      teacherName: 'Teacher 1',
      className: '3eme A',
      subject: 'Maths',
      plannedRoomId: 'room-1',
      plannedRoomName: 'A1',
      plannedRoomToken: 'expected-token',
      timeSlotId: 'slot-1',
      slotLabel: '07h30-09h00',
      slotStartTime: '07:30:00',
      slotEndTime: '09:00:00',
    });
    repository.upsertCheckIn.mockResolvedValue({});

    const service = new AttendanceService(repository as never);
    const result = await service.checkIn(
      { scheduleId: 'schedule-1', date: '2026-04-14' },
      { schemaName: 'school_sainte_marie', userId: 'user-1' }
    );

    expect(result).toMatchObject({
      status: 'late',
      lateMinutes: 20,
      checkedInAt: '2026-04-14T07:50:00.000Z',
    });
    expect(repository.upsertCheckIn).toHaveBeenCalledWith(
      expect.objectContaining({
        teacherId: 'teacher-1',
        scheduleId: 'schedule-1',
        date: '2026-04-14',
        status: 'late',
        lateMinutes: 20,
        checkedInAt: '2026-04-14T07:50:00.000Z',
      })
    );
    expect(eventMocks.emitTeacherLate).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaName: 'school_sainte_marie',
        teacherId: 'teacher-1',
        scheduleId: 'schedule-1',
        date: '2026-04-14',
        checkedInVia: 'app',
        lateMinutes: 20,
      })
    );
    expect(eventMocks.emitTeacherCheckedIn).not.toHaveBeenCalled();
    expect(schedulerMocks.scheduleQrMissingScanCheck).toHaveBeenCalledWith({
      schemaName: 'school_sainte_marie',
      scheduleId: 'schedule-1',
      date: '2026-04-14',
      slotStartTimeUtc: '07:30:00',
    });
  });

  it('checkIn() à l’heure émet teacher.checked_in', async () => {
    vi.setSystemTime(new Date('2026-04-14T07:38:00.000Z'));
    repository.findTeacherByUserId.mockResolvedValue({ id: 'teacher-1' });
    repository.findScheduleContextForTeacher.mockResolvedValue({
      scheduleId: 'schedule-1',
      teacherId: 'teacher-1',
      teacherName: 'Teacher 1',
      className: '3eme A',
      subject: 'Maths',
      plannedRoomId: 'room-1',
      plannedRoomName: 'A1',
      plannedRoomToken: 'expected-token',
      timeSlotId: 'slot-1',
      slotLabel: '07h30-09h00',
      slotStartTime: '07:30:00',
      slotEndTime: '09:00:00',
    });
    repository.upsertCheckIn.mockResolvedValue({});

    const service = new AttendanceService(repository as never);
    const result = await service.checkIn(
      { scheduleId: 'schedule-1', date: '2026-04-14' },
      { schemaName: 'school_sainte_marie', userId: 'user-1' }
    );

    expect(result).toMatchObject({
      status: 'present',
      lateMinutes: 8,
      checkedInAt: '2026-04-14T07:38:00.000Z',
    });
    expect(eventMocks.emitTeacherCheckedIn).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaName: 'school_sainte_marie',
        teacherId: 'teacher-1',
        scheduleId: 'schedule-1',
        date: '2026-04-14',
        checkedInVia: 'app',
      })
    );
    expect(eventMocks.emitTeacherLate).not.toHaveBeenCalled();
  });

  it('qrScan() invalide (mismatch) enregistre roomMismatch=true, qrAlertSent=true et émet teacher.qr_alert', async () => {
    vi.setSystemTime(new Date('2026-04-14T07:35:00.000Z'));
    repository.findTeacherByUserId.mockResolvedValue({ id: 'teacher-1' });
    repository.findScheduleContextForTeacher.mockResolvedValue({
      scheduleId: 'schedule-1',
      teacherId: 'teacher-1',
      teacherName: 'Teacher 1',
      className: '3eme A',
      subject: 'Maths',
      plannedRoomId: 'room-1',
      plannedRoomName: 'A1',
      plannedRoomToken: 'expected-token',
      timeSlotId: 'slot-1',
      slotLabel: '07h30-09h00',
      slotStartTime: '07:30:00',
      slotEndTime: '09:00:00',
    });
    repository.findRoomByToken.mockResolvedValue({ id: 'room-2' });
    repository.ensureAttendanceRecord.mockResolvedValue(undefined);
    repository.recordQrScan.mockResolvedValue(undefined);

    const service = new AttendanceService(repository as never);
    const result = await service.qrScan(
      {
        qrToken: 'wrong-token',
        scanType: 'start',
        scheduleId: 'schedule-1',
        date: '2026-04-14',
      },
      { schemaName: 'school_sainte_marie', userId: 'user-1' }
    );

    expect(result).toEqual({
      valid: false,
      roomMismatch: true,
      alertType: 'teacher_qr_mismatch',
    });
    expect(repository.recordQrScan).toHaveBeenCalledWith(
      expect.objectContaining({
        teacherId: 'teacher-1',
        scheduleId: 'schedule-1',
        date: '2026-04-14',
        scanType: 'start',
        scannedRoomId: 'room-2',
        roomMismatch: true,
        qrAlertSent: true,
      })
    );
    expect(eventMocks.emitTeacherQrAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaName: 'school_sainte_marie',
        teacherId: 'teacher-1',
        scheduleId: 'schedule-1',
        date: '2026-04-14',
        alertType: 'teacher_qr_mismatch',
        roomMismatch: true,
      })
    );
  });

  it('detectMissingQrScans() émet teacher_qr_missing_scan, marque qr_alert_sent et retourne le compteur', async () => {
    repository.listMissingQrScans.mockResolvedValue([
      { teacherId: 'teacher-1', scheduleId: 'schedule-1' },
      { teacherId: 'teacher-2', scheduleId: 'schedule-2' },
    ]);
    repository.markQrAlertSent.mockResolvedValue(undefined);

    const service = new AttendanceService(repository as never);
    const detected = await service.detectMissingQrScans({
      schemaName: 'school_sainte_marie',
      date: '2026-04-14',
    });

    expect(detected).toBe(2);
    expect(repository.listMissingQrScans).toHaveBeenCalledWith({ date: '2026-04-14' });
    expect(eventMocks.emitTeacherQrAlert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        schemaName: 'school_sainte_marie',
        teacherId: 'teacher-1',
        scheduleId: 'schedule-1',
        date: '2026-04-14',
        alertType: 'teacher_qr_missing_scan',
        roomMismatch: false,
      })
    );
    expect(eventMocks.emitTeacherQrAlert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        schemaName: 'school_sainte_marie',
        teacherId: 'teacher-2',
        scheduleId: 'schedule-2',
        date: '2026-04-14',
        alertType: 'teacher_qr_missing_scan',
        roomMismatch: false,
      })
    );
    expect(repository.markQrAlertSent).toHaveBeenCalledTimes(2);
    expect(repository.markQrAlertSent).toHaveBeenCalledWith({
      teacherId: 'teacher-1',
      scheduleId: 'schedule-1',
      date: '2026-04-14',
    });
    expect(repository.markQrAlertSent).toHaveBeenCalledWith({
      teacherId: 'teacher-2',
      scheduleId: 'schedule-2',
      date: '2026-04-14',
    });
  });

  it('submitStudentAttendance() émet student.absent uniquement pour les absences à notifier', async () => {
    repository.findTeacherByUserId.mockResolvedValue({ id: 'teacher-1' });
    repository.findScheduleContextForTeacher.mockResolvedValue({
      scheduleId: 'schedule-1',
      teacherId: 'teacher-1',
      teacherName: 'Teacher 1',
      classId: 'class-1',
      className: '3eme A',
      subject: 'Maths',
      plannedRoomId: 'room-1',
      plannedRoomName: 'A1',
      plannedRoomToken: 'expected-token',
      timeSlotId: 'slot-1',
      slotLabel: '07h30-09h00',
      slotStartTime: '07:30:00',
      slotEndTime: '09:00:00',
    });
    repository.listStudentsByClass.mockResolvedValue([
      { id: 'student-1' },
      { id: 'student-2' },
      { id: 'student-3' },
    ]);
    repository.bulkUpsertStudentAttendance.mockResolvedValue({ upsertedCount: 3 });
    repository.listStudentAbsenceNotificationCandidates.mockResolvedValue([
      {
        tenantId: 'tenant-1',
        studentId: 'student-1',
        studentFirstName: 'Awa',
        parentPhone: '2250700000001',
        subject: 'Maths',
        schoolPhone: '2250700000099',
      },
    ]);

    const service = new AttendanceService(repository as never);
    const result = await service.submitStudentAttendance(
      {
        scheduleId: 'schedule-1',
        date: '2026-04-14',
        absentStudentIds: ['student-1', 'student-2'],
      },
      { schemaName: 'school_sainte_marie', userId: 'user-1' }
    );

    expect(result).toEqual({ upsertedCount: 3 });
    expect(repository.bulkUpsertStudentAttendance).toHaveBeenCalledWith({
      scheduleId: 'schedule-1',
      date: '2026-04-14',
      absentStudentIds: ['student-1', 'student-2'],
      markedByUserId: 'user-1',
      allStudentIds: ['student-1', 'student-2', 'student-3'],
    });
    expect(repository.listStudentAbsenceNotificationCandidates).toHaveBeenCalledWith({
      schemaName: 'school_sainte_marie',
      scheduleId: 'schedule-1',
      date: '2026-04-14',
      absentStudentIds: ['student-1', 'student-2'],
    });
    expect(eventMocks.emitStudentAbsent).toHaveBeenCalledTimes(1);
    expect(eventMocks.emitStudentAbsent).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      schemaName: 'school_sainte_marie',
      studentId: 'student-1',
      scheduleId: 'schedule-1',
      studentFirstName: 'Awa',
      parentPhone: '2250700000001',
      subject: 'Maths',
      date: '2026-04-14',
      schoolPhone: '2250700000099',
    });
  });
});
