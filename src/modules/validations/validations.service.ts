import { ValidationsRepository } from './validations.repository.js';
import { emit } from '../../shared/events/event-bus.js';
import type { MissingEndScanTeacher, PendingValidationCount, PendingValidationGroups } from './validations.types.js';

export class ValidationModuleError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string
  ) {
    super(message);
    this.name = 'ValidationModuleError';
  }
}

type ServiceContext = {
  schemaName: string;
  tenantId?: string;
  userId: string;
  role: string;
};

export class ValidationsService {
  constructor(private readonly repository: ValidationsRepository) {}

  listPending(): Promise<PendingValidationGroups> {
    return this.repository.listPending();
  }

  countPending(): Promise<PendingValidationCount> {
    return this.repository.countPending();
  }

  async approve(
    input: { attendanceId: string; validatedHours?: number },
    context: ServiceContext
  ): Promise<{ success: true }> {
    const before = await this.repository.findValidationContext(input.attendanceId);
    if (!before) {
      throw new ValidationModuleError('Validation not found', 404, 'VALIDATION_NOT_FOUND');
    }

    const fullHours = Number(before.schedule_duration_minutes) / 60;
    const validatedHours = input.validatedHours ?? fullHours;
    await this.repository.approve({
      attendanceId: input.attendanceId,
      validatedHours,
      validatedBy: context.userId,
    });
    await this.repository.recomputeForAttendanceDate(before.teacher_id, before.date);
    await this.repository.auditValidation({
      schemaName: context.schemaName,
      actorId: context.userId,
      actorRole: context.role,
      action: 'attendance_validation_approved',
      before,
      after: {
        attendanceId: input.attendanceId,
        validationStatus: 'approved',
        validatedHours,
      },
    });

    return { success: true };
  }

  async reject(
    input: { attendanceId: string; reason: string },
    context: ServiceContext
  ): Promise<{ success: true }> {
    const before = await this.repository.findValidationContext(input.attendanceId);
    if (!before) {
      throw new ValidationModuleError('Validation not found', 404, 'VALIDATION_NOT_FOUND');
    }

    await this.repository.reject({
      attendanceId: input.attendanceId,
      reason: input.reason,
      validatedBy: context.userId,
    });
    await this.repository.insertRejectedTeacherNotification({
      context: before,
      reason: input.reason,
      validatedBy: context.userId,
    });
    emit('teacher.attendance_rejected', {
      tenantId: context.tenantId ?? '',
      schemaName: context.schemaName,
      teacherId: before.teacher_id,
      teacherUserId: before.teacher_user_id,
      teacherName: before.teacher_name,
      teacherPhone: before.teacher_phone,
      teacherEmail: before.teacher_email,
      attendanceId: before.attendance_id,
      courseName: before.course_name,
      date: before.date,
      reason: input.reason,
      validatedBy: context.userId,
    });
    await this.repository.recomputeForAttendanceDate(before.teacher_id, before.date);
    await this.repository.auditValidation({
      schemaName: context.schemaName,
      actorId: context.userId,
      actorRole: context.role,
      action: 'attendance_validation_rejected',
      before,
      after: {
        attendanceId: input.attendanceId,
        validationStatus: 'rejected',
        validatedHours: 0,
        reason: input.reason,
      },
    });

    return { success: true };
  }

  // ── Missing end-scan feature ──────────────────────────────────────────────

  async listMissingEndScans(month: string): Promise<MissingEndScanTeacher[]> {
    return this.repository.listMissingEndScans(month);
  }

  async sendEndScanWarnings(
    teacherIds: string[],
    month: string,
    context: ServiceContext
  ): Promise<{ sentCount: number }> {
    const teachers = await this.repository.getTeacherUserInfo(teacherIds);
    if (teachers.length === 0) {
      throw new ValidationModuleError('No teachers found', 404, 'TEACHERS_NOT_FOUND');
    }

    const missing = await this.repository.listMissingEndScans(month);
    const missingMap = new Map(missing.map((t) => [t.teacherId, t]));

    let sentCount = 0;
    for (const teacher of teachers) {
      const entry = missingMap.get(teacher.teacher_id);
      if (!entry || entry.missingEndScanCount === 0) continue;

      await this.repository.insertEndScanWarningNotification({
        teacherUserId: teacher.user_id,
        teacherPhone: teacher.phone,
        teacherEmail: teacher.email,
        teacherName: teacher.teacher_name,
        month,
        missingCount: entry.missingEndScanCount,
        validatedBy: context.userId,
      });
      sentCount++;
    }

    return { sentCount };
  }

  async invalidateSession(
    input: { attendanceId: string; reason: string },
    context: ServiceContext
  ): Promise<{ success: true }> {
    const before = await this.repository.findValidationContext(input.attendanceId);
    if (!before) {
      throw new ValidationModuleError('Attendance record not found', 404, 'ATTENDANCE_NOT_FOUND');
    }

    await this.repository.invalidateSession({
      attendanceId: input.attendanceId,
      reason: input.reason,
      validatedBy: context.userId,
    });

    await this.repository.insertRejectedTeacherNotification({
      context: before,
      reason: `Cours non comptabilisé (scan de fin manquant) : ${input.reason}`,
      validatedBy: context.userId,
    });

    await this.repository.recomputeForAttendanceDate(before.teacher_id, before.date);

    await this.repository.auditValidation({
      schemaName: context.schemaName,
      actorId: context.userId,
      actorRole: context.role,
      action: 'attendance_validation_rejected',
      before,
      after: {
        attendanceId: input.attendanceId,
        validationStatus: 'rejected',
        validatedHours: 0,
        reason: input.reason,
        source: 'missing_end_scan',
      },
    });

    return { success: true };
  }
}

export const buildValidationsService = (
  db: ConstructorParameters<typeof ValidationsRepository>[0]
): ValidationsService => new ValidationsService(new ValidationsRepository(db));
