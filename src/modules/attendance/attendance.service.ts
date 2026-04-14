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
      await scheduleQrMissingScanCheck({
        schemaName: context.schemaName,
        scheduleId: schedule.scheduleId,
        date,
        slotStartTimeUtc: schedule.slotStartTime,
      });
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
}

export const buildAttendanceService = (
  db: ConstructorParameters<typeof AttendanceRepository>[0]
): AttendanceService => new AttendanceService(new AttendanceRepository(db));
