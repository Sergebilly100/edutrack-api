import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const eventMocks = vi.hoisted(() => ({
  emitStudentAbsent: vi.fn(),
  emitTeacherCheckedIn: vi.fn(),
  emitTeacherLate: vi.fn(),
  emitTeacherQrAlert: vi.fn(),
  emitTeacherQrInvalid: vi.fn(),
  emitTeacherCheckoutCompleted: vi.fn(),
}));

const schedulerMocks = vi.hoisted(() => ({
  scheduleQrMissingScanCheck: vi.fn(),
}));

vi.mock('../../src/modules/attendance/attendance.events.js', () => ({
  emitStudentAbsent: eventMocks.emitStudentAbsent,
  emitTeacherCheckedIn: eventMocks.emitTeacherCheckedIn,
  emitTeacherLate: eventMocks.emitTeacherLate,
  emitTeacherQrAlert: eventMocks.emitTeacherQrAlert,
  emitTeacherQrInvalid: eventMocks.emitTeacherQrInvalid,
  emitTeacherCheckoutCompleted: eventMocks.emitTeacherCheckoutCompleted,
}));

vi.mock('../../src/shared/queue/attendance-queue.js', () => ({
  scheduleQrMissingScanCheck: schedulerMocks.scheduleQrMissingScanCheck,
}));

import { AttendanceService } from '../../src/modules/attendance/attendance.service.js';

const repository = {
  findTeacherByUserId: vi.fn(),
  findScheduleContextForTeacher: vi.fn(),
  upsertCheckIn: vi.fn(),
  getSchoolFeatureFlags: vi.fn(),
  findRoomByToken: vi.fn(),
  ensureAttendanceRecord: vi.fn(),
  recordQrScan: vi.fn(),
  getStartScanRoomToken: vi.fn(),
  listActiveAttendanceForTeacher: vi.fn(),
  listMissingQrScans: vi.fn(),
  markQrAlertSent: vi.fn(),
  listStudentsByClass: vi.fn(),
  bulkUpsertStudentAttendance: vi.fn(),
  listStudentAbsenceNotificationCandidates: vi.fn(),
  listAbsentStudentsForSchedule: vi.fn(),
  getTeacherAttendance: vi.fn(),
  checkOut: vi.fn(),
  listStudentRollCallForSchedule: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  repository.getSchoolFeatureFlags.mockResolvedValue({
    use_real_hours: false,
    geo_check_enabled: false,
  });
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

  it('qrScan() scanType=end dans une salle ≠ EDT mais cohérente avec le début → accepté (room_scan_end_at posé)', async () => {
    // Régression : le scan de fin était bloqué (1) sur l'écart EDT, puis (2) sur la
    // fenêtre horaire. Un prof qui fait cours hors de la salle prévue mais scanne la
    // même salle au début et à la fin doit pouvoir clôturer - y compris APRÈS l'heure
    // de fin du créneau (cas normal : on scanne la fin une fois le cours terminé).
    // 09:20 > slotEnd 09:00 → hors fenêtre horaire, mais doit quand même être accepté.
    vi.setSystemTime(new Date('2026-04-14T09:20:00.000Z'));
    repository.findTeacherByUserId.mockResolvedValue({ id: 'teacher-1' });
    repository.findScheduleContextForTeacher.mockResolvedValue({
      scheduleId: 'schedule-1',
      teacherId: 'teacher-1',
      teacherName: 'Teacher 1',
      className: '3eme A',
      subject: 'Maths',
      plannedRoomId: 'room-1',
      plannedRoomName: 'A1',
      plannedRoomToken: 'edt-room-token', // salle PRÉVUE dans l'EDT
      timeSlotId: 'slot-1',
      slotLabel: '07h30-09h00',
      slotStartTime: '07:30:00',
      slotEndTime: '09:00:00',
    });
    // Le prof a fait cours dans la salle B (≠ EDT) : début scanné en 'actual-room-token'
    repository.findRoomByToken.mockResolvedValue({ id: 'room-2' });
    repository.getStartScanRoomToken.mockResolvedValue('actual-room-token');
    repository.ensureAttendanceRecord.mockResolvedValue(undefined);
    repository.recordQrScan.mockResolvedValue(undefined);

    const service = new AttendanceService(repository as never);
    const result = await service.qrScan(
      {
        qrToken: 'actual-room-token', // scan de fin = MÊME salle qu'au début
        scanType: 'end',
        scheduleId: 'schedule-1',
        date: '2026-04-14',
      },
      { schemaName: 'school_sainte_marie', userId: 'user-1' }
    );

    // Cohérent début↔fin → pas de mismatch renvoyé au front
    expect(result.roomMismatch).toBe(false);
    // recordQrScan reçoit endScanMismatch=false → room_scan_end_at sera posé
    expect(repository.recordQrScan).toHaveBeenCalledWith(
      expect.objectContaining({
        scanType: 'end',
        endScanMismatch: false,
      })
    );
  });

  it('qrScan() scanType=end dans une salle DIFFÉRENTE du début → refusé (endScanMismatch=true)', async () => {
    vi.setSystemTime(new Date('2026-04-14T08:55:00.000Z'));
    repository.findTeacherByUserId.mockResolvedValue({ id: 'teacher-1' });
    repository.findScheduleContextForTeacher.mockResolvedValue({
      scheduleId: 'schedule-1',
      teacherId: 'teacher-1',
      teacherName: 'Teacher 1',
      className: '3eme A',
      subject: 'Maths',
      plannedRoomId: 'room-1',
      plannedRoomName: 'A1',
      plannedRoomToken: 'edt-room-token',
      timeSlotId: 'slot-1',
      slotLabel: '07h30-09h00',
      slotStartTime: '07:30:00',
      slotEndTime: '09:00:00',
    });
    repository.findRoomByToken.mockResolvedValue({ id: 'room-3' });
    repository.getStartScanRoomToken.mockResolvedValue('start-room-token');
    repository.ensureAttendanceRecord.mockResolvedValue(undefined);
    repository.recordQrScan.mockResolvedValue(undefined);

    const service = new AttendanceService(repository as never);
    const result = await service.qrScan(
      {
        qrToken: 'other-room-token', // ≠ salle scannée au début
        scanType: 'end',
        scheduleId: 'schedule-1',
        date: '2026-04-14',
      },
      { schemaName: 'school_sainte_marie', userId: 'user-1' }
    );

    expect(result.roomMismatch).toBe(true);
    expect(repository.recordQrScan).toHaveBeenCalledWith(
      expect.objectContaining({ scanType: 'end', endScanMismatch: true })
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

  it('submitStudentAttendance() émet student.absent uniquement pour les absences à notifier (sans queue)', async () => {
    // Temps fixé AVANT la fin du créneau 09:00 + 15 min → pas de ROLLCALL_WINDOW_CLOSED
    vi.setSystemTime(new Date('2026-04-14T08:30:00.000Z'));
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

    expect(result).toMatchObject({ upsertedCount: 3, isLocked: false });
    expect(result.notifSendAfter).toBeGreaterThan(Date.now());
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
    // Sans queue → émission immédiate
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

  it('submitStudentAttendance() lève ROLLCALL_WINDOW_CLOSED si délai dépassé', async () => {
    // Temps fixé APRÈS fin du créneau 09:00 + 15 min
    vi.setSystemTime(new Date('2026-04-14T09:20:00.000Z'));
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

    const service = new AttendanceService(repository as never);
    await expect(
      service.submitStudentAttendance(
        { scheduleId: 'schedule-1', date: '2026-04-14', absentStudentIds: [] },
        { schemaName: 'school_sainte_marie', userId: 'user-1' }
      )
    ).rejects.toMatchObject({ code: 'ROLLCALL_WINDOW_CLOSED', statusCode: 409 });
    expect(repository.bulkUpsertStudentAttendance).not.toHaveBeenCalled();
    expect(eventMocks.emitStudentAbsent).not.toHaveBeenCalled();
  });

  it('submitStudentAttendance() avec queue : enfile un job différé pour chaque absent candidat', async () => {
    vi.setSystemTime(new Date('2026-04-14T08:30:00.000Z'));
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
    ]);
    repository.bulkUpsertStudentAttendance.mockResolvedValue({ upsertedCount: 2 });
    repository.listStudentAbsenceNotificationCandidates.mockResolvedValue([
      {
        tenantId: 'tenant-1',
        studentId: 'student-1',
        studentFirstName: 'Awa',
        parentPhone: '2250700000001',
        parentEmail: null,
        subject: 'Maths',
        schoolPhone: '2250700000099',
      },
    ]);

    const notifQueue = {
      remove: vi.fn().mockResolvedValue(undefined),
      add: vi.fn().mockResolvedValue(undefined),
    };

    const service = new AttendanceService(repository as never, notifQueue as never);
    const result = await service.submitStudentAttendance(
      {
        scheduleId: 'schedule-1',
        date: '2026-04-14',
        absentStudentIds: ['student-1'],
      },
      { schemaName: 'school_sainte_marie', userId: 'user-1' }
    );

    expect(result).toMatchObject({ upsertedCount: 2, isLocked: false });
    // Pas d'émission directe - tout passe par la queue
    expect(eventMocks.emitStudentAbsent).not.toHaveBeenCalled();
    // Le job différé est ajouté pour l'absent candidat
    expect(notifQueue.add).toHaveBeenCalledWith(
      'deferred-student-absent',
      expect.objectContaining({
        type: 'deferred-student-absent',
        schemaName: 'school_sainte_marie',
        studentId: 'student-1',
        scheduleId: 'schedule-1',
      }),
      expect.objectContaining({
        jobId: expect.stringContaining('deferred-absent__school_sainte_marie__schedule-1__student-1'),
        delay: expect.any(Number),
      })
    );
    // Annulation du job du présent (student-2)
    expect(notifQueue.remove).toHaveBeenCalledWith(
      expect.stringContaining('student-2')
    );
  });

  it('qrScan() scanType=end avec queue : changeDelay(0) pour chaque job absent', async () => {
    vi.setSystemTime(new Date('2026-04-14T09:05:00.000Z'));
    repository.findTeacherByUserId.mockResolvedValue({ id: 'teacher-1' });
    repository.findScheduleContextForTeacher.mockResolvedValue({
      scheduleId: 'schedule-1',
      teacherId: 'teacher-1',
      teacherName: 'Teacher 1',
      className: '3eme A',
      subject: 'Maths',
      plannedRoomId: 'room-1',
      plannedRoomName: 'A1',
      plannedRoomToken: 'correct-token',
      timeSlotId: 'slot-1',
      slotLabel: '07h30-09h00',
      slotStartTime: '07:30:00',
      slotEndTime: '09:00:00',
    });
    repository.findRoomByToken.mockResolvedValue({ id: 'room-1' });
    repository.ensureAttendanceRecord.mockResolvedValue(undefined);
    repository.recordQrScan.mockResolvedValue(undefined);
    repository.getStartScanRoomToken.mockResolvedValue(null); // pas de scan de début → validation dégradée
    repository.listAbsentStudentsForSchedule.mockResolvedValue(['student-1', 'student-2']);

    const mockJob = { changeDelay: vi.fn().mockResolvedValue(undefined) };
    const notifQueue = {
      getJob: vi.fn().mockResolvedValue(mockJob),
    };

    const service = new AttendanceService(repository as never, notifQueue as never);
    await service.qrScan(
      {
        qrToken: 'correct-token',
        scanType: 'end',
        scheduleId: 'schedule-1',
        date: '2026-04-14',
      },
      { schemaName: 'school_sainte_marie', userId: 'user-1' }
    );

    expect(repository.listAbsentStudentsForSchedule).toHaveBeenCalledWith({
      scheduleId: 'schedule-1',
      date: '2026-04-14',
    });
    expect(notifQueue.getJob).toHaveBeenCalledTimes(2);
    expect(mockJob.changeDelay).toHaveBeenCalledTimes(2);
    expect(mockJob.changeDelay).toHaveBeenCalledWith(0);
  });

  it('checkOut() scanné bien après la fin du créneau → actualMinutes borné à slotEnd (pas de sur-paie)', async () => {
    // Créneau 07:30→09:00 (90 min). Check-in à l'heure, scan de fin à 11:00 (2h
    // après la fin). actual_minutes alimente la paie (use_real_hours) : il doit
    // valoir 90 min (07:30→09:00), PAS 210 min (07:30→11:00).
    vi.setSystemTime(new Date('2026-04-14T11:00:00.000Z'));
    repository.findTeacherByUserId.mockResolvedValue({ id: 'teacher-1' });
    repository.findScheduleContextForTeacher.mockResolvedValue({
      scheduleId: 'schedule-1',
      teacherId: 'teacher-1',
      teacherName: 'Teacher 1',
      className: '3eme A',
      subject: 'Maths',
      plannedRoomId: 'room-1',
      plannedRoomName: 'A1',
      plannedRoomToken: 'token',
      timeSlotId: 'slot-1',
      slotLabel: '07h30-09h00',
      slotStartTime: '07:30:00',
      slotEndTime: '09:00:00',
    });
    repository.getTeacherAttendance.mockResolvedValue({
      checked_in_at: '2026-04-14T07:30:00.000Z',
      checked_out_at: null,
      room_scan_end_at: '2026-04-14T09:00:00.000Z',
    });
    repository.getSchoolFeatureFlags.mockResolvedValue({
      use_real_hours: true,
      geo_check_enabled: false,
      require_end_scan: false,
      checkout_tolerance_minutes: 5,
    });
    repository.checkOut.mockResolvedValue(undefined);

    const service = new AttendanceService(repository as never);
    const result = await service.checkOut(
      { scheduleId: 'schedule-1', date: '2026-04-14' },
      { schemaName: 'school_sainte_marie', userId: 'user-1' }
    );

    // 90 min = durée du créneau, pas 210 min (07:30 → 11:00)
    expect(result.actualMinutes).toBe(90);
    expect(repository.checkOut).toHaveBeenCalledWith(
      expect.objectContaining({ actualMinutes: 90 })
    );
  });

  it('getStudentRollCall() retourne les statuts élèves pour pré-remplir l\'appel rouvert', async () => {
    repository.findTeacherByUserId.mockResolvedValue({ id: 'teacher-1' });
    repository.findScheduleContextForTeacher.mockResolvedValue({
      scheduleId: 'schedule-1',
      teacherId: 'teacher-1',
      classId: 'class-1',
      slotStartTime: '07:30:00',
      slotEndTime: '09:00:00',
    });
    repository.listStudentRollCallForSchedule.mockResolvedValue([
      { student_id: 'stu-1', status: 'absent' },
      { student_id: 'stu-2', status: 'present' },
      { student_id: 'stu-3', status: 'unmarked' },
    ]);

    const service = new AttendanceService(repository as never);
    const result = await service.getStudentRollCall(
      { scheduleId: 'schedule-1', date: '2026-04-14' },
      { schemaName: 'school_sainte_marie', userId: 'user-1' }
    );

    expect(result).toHaveLength(3);
    expect(result.find((r) => r.student_id === 'stu-1')?.status).toBe('absent');
    // scoping prof : la classe vient du schedule résolu pour CE prof
    expect(repository.listStudentRollCallForSchedule).toHaveBeenCalledWith({
      classId: 'class-1',
      scheduleId: 'schedule-1',
      date: '2026-04-14',
    });
  });
});
