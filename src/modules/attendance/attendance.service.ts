import {
  emitTeacherCheckedIn,
  emitTeacherLate,
  emitTeacherQrAlert,
} from './attendance.events.js';
import { AttendanceRepository } from './attendance.repository.js';
import type { ActiveAttendanceItem, CheckInResult } from './attendance.types.js';
import { calculateAttendanceStatus, validateRoomScan } from '../../shared/utils/attendance.js';
import { scheduleQrMissingScanCheck } from './attendance.scheduler.js';

export class AttendanceModuleError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string
  ) {
    super(message);
    this.name = 'AttendanceModuleError';
  }
}

type ServiceContext = {
  schemaName: string;
  userId: string;
};

const currentDateIso = (): string => new Date().toISOString().slice(0, 10);

const dayOfWeekFromDate = (date: Date): number => {
  const d = date.getUTCDay();
  return d === 0 ? 7 : d;
};

const toSlotDateTime = (date: string, time: string): Date => new Date(`${date}T${time}.000Z`);

const toIso = (date: Date): string => date.toISOString();

export class AttendanceService {
  constructor(private readonly repository: AttendanceRepository) {}

  async checkIn(
    input: {
      scheduleId: string;
      date?: string;
    },
    context: ServiceContext
  ): Promise<CheckInResult> {
    const teacher = await this.repository.findTeacherByUserId(context.userId);
    if (!teacher) {
      throw new AttendanceModuleError('Teacher profile not found', 404, 'TEACHER_NOT_FOUND');
    }

    const schedule = await this.repository.findScheduleContextForTeacher(
      input.scheduleId,
      teacher.id
    );
    if (!schedule) {
      throw new AttendanceModuleError('Schedule not found', 404, 'SCHEDULE_NOT_FOUND');
    }

    const date = input.date ?? currentDateIso();
    const checkedInAt = new Date();
    const slotStart = toSlotDateTime(date, schedule.slotStartTime);
    const slotEnd = toSlotDateTime(date, schedule.slotEndTime);
    const status = calculateAttendanceStatus(checkedInAt, slotStart, slotEnd);

    await this.repository.upsertCheckIn({
      teacherId: teacher.id,
      scheduleId: schedule.scheduleId,
      date,
      status: status.status,
      lateMinutes: status.lateMinutes,
      checkedInAt: toIso(checkedInAt),
    });

    if (status.status !== 'absent') {
      try {
        await scheduleQrMissingScanCheck({
          schemaName: context.schemaName,
          scheduleId: schedule.scheduleId,
          date,
          slotStartTimeUtc: schedule.slotStartTime,
        });
      } catch (error) {
        // Ne pas bloquer le pointage si la queue Redis est indisponible.
        console.error('[attendance] failed to schedule qr missing-scan check', error);
      }
    }

    const commonPayload = {
      tenantId: context.schemaName,
      schemaName: context.schemaName,
      teacherId: teacher.id,
      scheduleId: schedule.scheduleId,
      date,
      checkedInAt: toIso(checkedInAt),
      checkedInVia: 'app' as const,
    };

    if (status.status === 'late') {
      emitTeacherLate({
        ...commonPayload,
        lateMinutes: status.lateMinutes ?? 0,
      });
    } else if (status.status === 'present') {
      emitTeacherCheckedIn(commonPayload);
    }

    return {
      status: status.status,
      lateMinutes: status.lateMinutes,
      checkedInAt: toIso(checkedInAt),
    };
  }

  async qrScan(
    input: {
      qrToken: string;
      scanType: 'start' | 'end';
      scheduleId: string;
      date?: string;
    },
    context: ServiceContext
  ): Promise<{
    valid: boolean;
    roomMismatch: boolean;
    alertType: 'teacher_qr_mismatch' | 'teacher_qr_scan_out_of_time' | null;
  }> {
    const teacher = await this.repository.findTeacherByUserId(context.userId);
    if (!teacher) {
      throw new AttendanceModuleError('Teacher profile not found', 404, 'TEACHER_NOT_FOUND');
    }

    const schedule = await this.repository.findScheduleContextForTeacher(
      input.scheduleId,
      teacher.id
    );
    if (!schedule) {
      throw new AttendanceModuleError('Schedule not found', 404, 'SCHEDULE_NOT_FOUND');
    }

    const date = input.date ?? currentDateIso();
    const scannedAt = new Date();

    const scannedRoom = await this.repository.findRoomByToken(input.qrToken);

    const validation = validateRoomScan({
      scannedRoomToken: input.qrToken,
      expectedRoomToken: schedule.plannedRoomToken,
      scheduleDate: date,
      slotStartTime: schedule.slotStartTime,
      slotEndTime: schedule.slotEndTime,
      scanTime: scannedAt,
    });

    await this.repository.ensureAttendanceRecord({
      teacherId: teacher.id,
      scheduleId: schedule.scheduleId,
      date,
    });

    const roomMismatch = !validation.valid;
    await this.repository.recordQrScan({
      teacherId: teacher.id,
      scheduleId: schedule.scheduleId,
      date,
      scanType: input.scanType,
      scannedRoomId: scannedRoom?.id ?? null,
      roomMismatch,
      qrAlertSent: !validation.valid,
      scannedAtIso: toIso(scannedAt),
    });

    if (!validation.valid && validation.alertType) {
      emitTeacherQrAlert({
        tenantId: context.schemaName,
        schemaName: context.schemaName,
        teacherId: teacher.id,
        scheduleId: schedule.scheduleId,
        date,
        alertType: validation.alertType,
        roomMismatch: true,
      });
    }

    return {
      valid: validation.valid,
      roomMismatch,
      alertType: validation.alertType,
    };
  }

  async getActive(context: ServiceContext): Promise<{ date: string; items: ActiveAttendanceItem[] }> {
    const teacher = await this.repository.findTeacherByUserId(context.userId);
    if (!teacher) {
      throw new AttendanceModuleError('Teacher profile not found', 404, 'TEACHER_NOT_FOUND');
    }

    const now = new Date();
    const date = currentDateIso();
    const dayOfWeek = dayOfWeekFromDate(now);

    const items = await this.repository.listActiveAttendanceForTeacher({
      teacherId: teacher.id,
      date,
      dayOfWeek,
    });

    return { date, items };
  }

  // ── NOUVEAU — statuts de pointage pour une date (TeacherSchedulePage) ──────
  async getTeacherAttendanceByDate(
    input: { date: string },
    context: ServiceContext
  ): Promise<Array<{
    id: string;
    schedule_id: string;
    status: 'present' | 'absent' | 'late' | 'excused';
    late_minutes: number | null;
    date: string;
  }>> {
    const teacher = await this.repository.findTeacherByUserId(context.userId);
    if (!teacher) {
      throw new AttendanceModuleError('Teacher profile not found', 404, 'TEACHER_NOT_FOUND');
    }

    return this.repository.getTeacherAttendanceByDate({
      teacherId: teacher.id,
      date: input.date,
    });
  }

  // ── NOUVEAU — appel élèves par le prof ────────────────────────────────────
  async submitStudentAttendance(
    input: {
      scheduleId: string;
      date: string;
      absentStudentIds: string[];
    },
    context: ServiceContext
  ): Promise<{ upsertedCount: number }> {
    const teacher = await this.repository.findTeacherByUserId(context.userId);
    if (!teacher) {
      throw new AttendanceModuleError('Teacher profile not found', 404, 'TEACHER_NOT_FOUND');
    }

    // Vérifier que ce schedule appartient bien au prof
    const schedule = await this.repository.findScheduleContextForTeacher(
      input.scheduleId,
      teacher.id
    );
    if (!schedule) {
      throw new AttendanceModuleError('Schedule not found', 404, 'SCHEDULE_NOT_FOUND');
    }

    // Récupérer la liste complète des élèves de la classe
    const allStudents = await this.repository.listStudentsByClass(schedule.classId ?? '');

    if (allStudents.length === 0) {
      // Pas d'élèves dans la classe — on accepte quand même (classe vide ou pas encore importée)
      return { upsertedCount: 0 };
    }

    const allStudentIds = allStudents.map((s) => s.id);

    return this.repository.bulkUpsertStudentAttendance({
      scheduleId: input.scheduleId,
      date: input.date,
      absentStudentIds: input.absentStudentIds,
      markedByUserId: context.userId,
      allStudentIds,
    });
  }

  async detectMissingQrScans(context: { schemaName: string; date?: string }): Promise<number> {
    const date = context.date ?? currentDateIso();
    const missing = await this.repository.listMissingQrScans({ date });

    for (const item of missing) {
      emitTeacherQrAlert({
        tenantId: context.schemaName,
        schemaName: context.schemaName,
        teacherId: item.teacherId,
        scheduleId: item.scheduleId,
        date,
        alertType: 'teacher_qr_missing_scan',
        roomMismatch: false,
      });

      await this.repository.markQrAlertSent({
        teacherId: item.teacherId,
        scheduleId: item.scheduleId,
        date,
      });
    }

    return missing.length;
  }

  async getTodayForDirector(): Promise<{
    date: string;
    present: number;
    absent: number;
    not_checked: number;
    present_count: number;
    absent_count: number;
    not_checked_count: number;
    unmarked_count: number;
    courses: Array<{
      schedule_id: string;
      teacher_name: string;
      subject: string;
      class: string;
      class_name: string;
      room_name: string;
      slot_label: string;
      start_time: string;
      end_time: string;
      status: 'present' | 'absent' | 'not_checked';
      attendance_status: 'present' | 'absent' | 'late' | 'excused' | null;
      late_minutes: number | null;
      room_mismatch: boolean;
      room_scanned_name: string | null;
      checked_in_at: string | null;
    }>;
  }> {
    const today = await this.repository.listTodayForDirector();
    return {
      date: today.date,
      present: today.presentCount,
      absent: today.absentCount,
      not_checked: today.unmarkedCount,
      present_count: today.presentCount,
      absent_count: today.absentCount,
      not_checked_count: today.unmarkedCount,
      unmarked_count: today.unmarkedCount,
      courses: today.courses.map((course) => ({
        ...course,
        class: course.class_name,
        status:
          course.attendance_status === 'absent'
            ? 'absent'
            : course.attendance_status === null
              ? 'not_checked'
              : 'present',
        room_mismatch: course.room_mismatch ?? false,
      })),
    };
  }

  async getHistoryForDirector(days: number): Promise<
    Array<{
      date: string;
      present: number;
      absent: number;
      not_checked: number;
      present_count: number;
      absent_count: number;
      not_checked_count: number;
      total_count: number;
      attendance_rate: number;
    }>
  > {
    const rows = await this.repository.listHistoryForDirector(days);
    return rows.map((row) => ({
      ...row,
      present: row.present_count,
      absent: row.absent_count,
      not_checked: row.not_checked_count,
    }));
  }
}

export const buildAttendanceService = (
  db: ConstructorParameters<typeof AttendanceRepository>[0]
): AttendanceService => new AttendanceService(new AttendanceRepository(db));
