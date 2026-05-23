import { ValidationsRepository } from './validations.repository.js';
import { emit } from '../../shared/events/event-bus.js';
import type { EndScanAction, MissingEndScanTeacher, PendingValidationCount, PendingValidationGroups, TeacherNotificationItem, ValidationHistoryPage } from './validations.types.js';

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
    const before = await this.repository.transaction(async (tx) => {
      const ctx = await this.repository.findValidationContext(input.attendanceId, tx);
      if (!ctx) {
        throw new ValidationModuleError('Validation not found', 404, 'VALIDATION_NOT_FOUND');
      }
      const fullHours = Number(ctx.schedule_duration_minutes) / 60;
      const validatedHours = input.validatedHours ?? fullHours;
      await this.repository.approve(
        { attendanceId: input.attendanceId, validatedHours, validatedBy: context.userId },
        tx
      );
      return { ctx, validatedHours };
    });
    // actualiser le cache de salaire de l'enseignant pour la date concernée
    await this.repository.recomputeForAttendanceDate(before.ctx.teacher_id, before.ctx.date);
    // Auditer l'action d'approbation
    await this.repository.auditValidation({
      schemaName: context.schemaName,
      actorId: context.userId,
      actorRole: context.role,
      action: 'attendance_validation_approved',
      before: before.ctx,
      after: {
        attendanceId: input.attendanceId,
        validationStatus: 'approved',
        validatedHours: before.validatedHours,
      },
    });
    // Envoyer la notification d'approbation à l'enseignant
    await this.repository.insertApprovedTeacherNotification({
      context: before.ctx,
      validatedHours: before.validatedHours,
      validatedBy: context.userId,
    });
    emit('teacher.attendance_approved', {
      tenantId: context.tenantId ?? '',
      schemaName: context.schemaName,
      teacherId: before.ctx.teacher_id,
      teacherUserId: before.ctx.teacher_user_id,
      teacherName: before.ctx.teacher_name,
      teacherPhone: before.ctx.teacher_phone,
      teacherEmail: before.ctx.teacher_email,
      attendanceId: before.ctx.attendance_id,
      courseName: before.ctx.course_name,
      date: before.ctx.date,
      validatedHours: before.validatedHours,
      validatedBy: context.userId,
    });

    return { success: true };
  }
  // ajout de la possibilité de rejeter une validation d'assiduité, avec envoi d'une notification à l'enseignant et audit de l'action
  async reject(
    input: { attendanceId: string; reason: string },
    context: ServiceContext
  ): Promise<{ success: true }> {
    const before = await this.repository.transaction(async (tx) => {
      const ctx = await this.repository.findValidationContext(input.attendanceId, tx);
      if (!ctx) {
        throw new ValidationModuleError('Validation not found', 404, 'VALIDATION_NOT_FOUND');
      }
      await this.repository.reject(
        { attendanceId: input.attendanceId, reason: input.reason, validatedBy: context.userId },
        tx
      );
      return ctx;
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
    // Auditer l'action de rejet
    await this.repository.auditValidation({
      schemaName: context.schemaName, 
      actorId: context.userId, // ID de l'utilisateur qui rejette la validation
      actorRole: context.role, // Rôle de l'utilisateur qui rejette la validation
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

  listValidationHistory(params: {
    kind?: 'short_hours' | 'gps_suspicious';
    month?: string;
    status?: 'approved' | 'rejected';
    approvalType?: 'planned' | 'actual';
    search?: string;
    page: number;
    limit: number;
  }): Promise<ValidationHistoryPage> {
    return this.repository.listValidationHistory(params);
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

      emit('teacher.end_scan_warning', {
        tenantId: context.tenantId ?? '',
        schemaName: context.schemaName,
        teacherId: teacher.teacher_id,
        teacherUserId: teacher.user_id,
        teacherName: teacher.teacher_name,
        teacherPhone: teacher.phone,
        teacherEmail: teacher.email,
        month,
        missingCount: entry.missingEndScanCount,
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

  // ── End-scan actions ─────────────────────────────────────────────────────

  async applyEndScanAction(
    input: { attendanceId: string; action: EndScanAction; reason: string },
    context: ServiceContext
  ): Promise<{ success: true }> {
    const record = await this.repository.findAttendanceForEndScanAction(input.attendanceId);
    if (!record) {
      throw new ValidationModuleError('Attendance not found', 404, 'ATTENDANCE_NOT_FOUND');
    }
    if (record.validation_status === 'approved') {
      throw new ValidationModuleError(
        'This session is already approved',
        409,
        'SESSION_ALREADY_APPROVED'
      );
    }
    if (
      record.end_scan_action !== null &&
      record.end_scan_action_cancelled_at === null
    ) {
      throw new ValidationModuleError(
        'An action has already been applied to this session',
        409,
        'END_SCAN_ACTION_ALREADY_SET'
      );
    }

    await this.repository.applyEndScanAction({
      attendanceId: input.attendanceId,
      action: input.action,
      reason: input.reason,
      actorId: context.userId,
    });

    if (input.action === 'sanctioned') {
      await this.repository.setSanctionedAttendanceRejected({
        attendanceId: input.attendanceId,
        reason: input.reason,
        actorId: context.userId,
      });
      await this.repository.recomputeForAttendanceDate(record.teacher_id, record.date);
    }

    await this.repository.insertEndScanActionNotification({
      action: input.action,
      teacherUserId: record.teacher_user_id,
      teacherPhone: record.teacher_phone,
      teacherEmail: record.teacher_email,
      teacherName: record.teacher_name,
      courseName: record.course_name,
      date: record.date,
      reason: input.reason,
    });

    emit('teacher.end_scan_action', {
      tenantId: context.tenantId ?? '',
      schemaName: context.schemaName,
      teacherId: record.teacher_id,
      teacherUserId: record.teacher_user_id,
      teacherName: record.teacher_name,
      teacherPhone: record.teacher_phone,
      teacherEmail: record.teacher_email,
      attendanceId: record.attendance_id,
      courseName: record.course_name,
      date: record.date,
      action: input.action,
      reason: input.reason,
    });

    return { success: true };
  }

  async cancelEndScanSanction(
    input: { attendanceId: string; reason: string },
    context?: ServiceContext
  ): Promise<{ success: true }> {
    const record = await this.repository.findAttendanceForEndScanAction(input.attendanceId);
    if (!record) {
      throw new ValidationModuleError('Attendance not found', 404, 'ATTENDANCE_NOT_FOUND');
    }
    if (record.end_scan_action !== 'sanctioned' || record.end_scan_action_cancelled_at !== null) {
      throw new ValidationModuleError(
        'No active sanction to cancel for this session',
        409,
        'NO_ACTIVE_SANCTION'
      );
    }

    await this.repository.cancelEndScanSanction({
      attendanceId: input.attendanceId,
      reason: input.reason,
    });
    await this.repository.revertSanctionedAttendance(input.attendanceId);
    await this.repository.recomputeForAttendanceDate(record.teacher_id, record.date);

    await this.repository.insertSanctionCancelledNotification({
      teacherUserId: record.teacher_user_id,
      teacherPhone: record.teacher_phone,
      teacherEmail: record.teacher_email,
      teacherName: record.teacher_name,
      courseName: record.course_name,
      date: record.date,
      cancelReason: input.reason,
    });

    emit('teacher.sanction_cancelled', {
      tenantId: context?.tenantId ?? '',
      schemaName: context?.schemaName ?? '',
      teacherId: record.teacher_id,
      teacherUserId: record.teacher_user_id,
      teacherName: record.teacher_name,
      teacherPhone: record.teacher_phone,
      teacherEmail: record.teacher_email,
      attendanceId: record.attendance_id,
      courseName: record.course_name,
      date: record.date,
      cancelReason: input.reason,
    });

    return { success: true };
  }

  // ── Teacher in-app notifications ─────────────────────────────────────────

  listTeacherNotifications(userId: string): Promise<TeacherNotificationItem[]> {
    return this.repository.listTeacherNotifications(userId);
  }

  async markTeacherNotificationRead(
    notificationId: string,
    userId: string
  ): Promise<{ success: true }> {
    const found = await this.repository.findTeacherNotification(notificationId, userId);
    if (!found) {
      throw new ValidationModuleError('Notification not found', 404, 'NOTIFICATION_NOT_FOUND');
    }
    await this.repository.markNotificationRead(notificationId);
    return { success: true };
  }

  async markAllTeacherNotificationsRead(userId: string): Promise<{ success: true }> {
    await this.repository.markAllNotificationsRead(userId);
    return { success: true };
  }
}

export const buildValidationsService = (
  db: ConstructorParameters<typeof ValidationsRepository>[0]
): ValidationsService => new ValidationsService(new ValidationsRepository(db));
