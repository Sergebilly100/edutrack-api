import argon2 from 'argon2';
import { resolveScheduleSubjectDisplay } from '../../shared/utils/schedule-subject-display.js';

import { ParentPortalRepository } from './parent-portal.repository.js';
import type { TenantDb } from './parent-portal.repository.js';
import type {
  ParentGradeEvaluation,
  ParentGradeSubject,
  ParentNotification,
  ParentStudentSummary,
  ParentSubscriptionStatus,
} from './parent-portal.types.js';

type ServiceContext = {
  parentId: string;
  allowedStudentIds: string[];
};

export class ParentPortalError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string
  ) {
    super(message);
    this.name = 'ParentPortalError';
  }
}

const parseWeek = (week: string): { weekStart: string; weekEnd: string; weekLabel: string } => {
  const match = week.match(/^(\d{4})-W(\d{2})$/);
  if (!match) {
    throw new ParentPortalError('Invalid week format', 400, 'BAD_REQUEST');
  }

  const year = Number(match[1]);
  const weekNumber = Number(match[2]);
  const january4 = new Date(Date.UTC(year, 0, 4));
  const january4Day = january4.getUTCDay() || 7;
  const mondayWeek1 = new Date(january4);
  mondayWeek1.setUTCDate(january4.getUTCDate() - (january4Day - 1));

  const weekStartDate = new Date(mondayWeek1);
  weekStartDate.setUTCDate(mondayWeek1.getUTCDate() + (weekNumber - 1) * 7);
  const weekEndDate = new Date(weekStartDate);
  weekEndDate.setUTCDate(weekStartDate.getUTCDate() + 6);

  return {
    weekStart: weekStartDate.toISOString().slice(0, 10),
    weekEnd: weekEndDate.toISOString().slice(0, 10),
    weekLabel: week,
  };
};

const monthBounds = (month: string): { monthStart: string; monthEnd: string } => {
  const [yearText, monthText] = month.split('-');
  const year = Number(yearText);
  const monthNumber = Number(monthText);
  const monthStart = `${month}-01`;
  const monthEnd = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  return { monthStart, monthEnd };
};

const toIsoDate = (date: Date): string => date.toISOString().slice(0, 10);

const toDateWithTime = (date: string, time: string): Date => new Date(`${date}T${time}.000Z`);

export const monthlyAttendanceRates = (breakdown: { present: number; absent: number; total: number }) => {
  const total = Number.isFinite(breakdown.total) ? Math.max(0, breakdown.total) : 0;
  const clampCount = (count: number) => Number.isFinite(count) ? Math.min(total, Math.max(0, count)) : 0;
  const rate = (count: number) => total > 0 ? Math.min(100, Math.max(0, Math.round(clampCount(count) / total * 100))) : 0;
  return {
    // Legacy field: present + excused / all recorded statuses; late is in the denominator.
    // With no recorded session, attendance retains its historical neutral value of 100%.
    attendanceRateMonth: total > 0 ? rate(breakdown.present) : 100,
    // All four recorded statuses count as sessions; only absent contributes to this rate.
    absenceRateMonth: rate(breakdown.absent),
  };
};

export class ParentPortalService {
  constructor(private readonly repository: ParentPortalRepository) {}

  async getSchoolConfig(): Promise<{ activeSchoolYear: string | null }> {
    // Finance endpoints require the tenant year's UUID, not the public display label.
    return { activeSchoolYear: await this.repository.getActiveSchoolYearId() };
  }

  private async assertStudentAccess(studentId: string, context: ServiceContext): Promise<void> {
    if (
      !context.allowedStudentIds.includes(studentId) ||
      !(await this.repository.parentCanAccessStudent(context.parentId, studentId))
    ) {
      throw new ParentPortalError('Student access denied', 403, 'STUDENT_ACCESS_DENIED');
    }
  }

  async loginParent(input: {
    phone: string;
    password: string;
  }): Promise<{ parentId: string; phone: string; full_name: string; email: string | null; studentIds: string[]; mustChangePassword: boolean }> {
    const parent = await this.repository.findParentByPhone(input.phone);
    if (!parent || !parent.is_active) {
      throw new ParentPortalError('Invalid credentials', 401, 'UNAUTHORIZED');
    }

    const isValid = await argon2.verify(parent.password_hash, input.password);
    if (!isValid) {
      throw new ParentPortalError('Invalid credentials', 401, 'UNAUTHORIZED');
    }

    const studentIds = await this.repository.listLinkedStudentIds(parent.id);
    if (studentIds.length === 0) {
      throw new ParentPortalError(
        "Accès au portail parent non autorisé. Contactez l'établissement.",
        403,
        'PARENT_PORTAL_ACCESS_DENIED'
      );
    }

    await this.repository.updateParentLastLogin(parent.id);
    return {
      parentId: parent.id,
      phone: parent.phone,
      full_name: parent.full_name,
      email: parent.email,
      studentIds,
      mustChangePassword: parent.must_change_password,
    };
  }

  async restoreSessionByParentId(input: {
    parentId: string;
  }): Promise<{ parentId: string; phone: string; studentIds: string[]; mustChangePassword: boolean }> {
    const parent = await this.repository.findParentById(input.parentId);
    if (!parent || !parent.is_active) {
      throw new ParentPortalError('Invalid credentials', 401, 'UNAUTHORIZED');
    }

    const studentIds = await this.repository.listLinkedStudentIds(parent.id);
    if (studentIds.length === 0) {
      throw new ParentPortalError(
        "Accès au portail parent non autorisé. Contactez l'établissement.",
        403,
        'PARENT_PORTAL_ACCESS_DENIED'
      );
    }

    return {
      parentId: parent.id,
      phone: parent.phone,
      studentIds,
      mustChangePassword: parent.must_change_password,
    };
  }

  async listStudents(context: ServiceContext): Promise<ParentStudentSummary[]> {
    const allowed = new Set(context.allowedStudentIds);
    return (await this.repository.listStudentsByParent(context.parentId)).filter((student) =>
      allowed.has(student.id)
    );
  }

  async listNotifications(input: { limit: number }, context: ServiceContext): Promise<{
    notifications: ParentNotification[];
    unreadCount: number;
  }> {
    const [rows, unreadCount] = await Promise.all([
      this.repository.listNotifications(context.parentId, input.limit),
      this.repository.countUnreadNotifications(context.parentId),
    ]);
    const notifications = rows.map((row) => {
      const metadata = row.metadata && typeof row.metadata === 'object'
        ? row.metadata as Record<string, unknown>
        : {};
      return {
        id: row.id,
        type: 'payment_reminder' as const,
        message: row.message,
        createdAt: row.created_at,
        readAt: typeof metadata.read_at === 'string' ? metadata.read_at : null,
        studentId: typeof metadata.studentId === 'string' ? metadata.studentId : null,
        studentName: typeof metadata.studentName === 'string' ? metadata.studentName : null,
      };
    });
    return {
      notifications,
      unreadCount,
    };
  }

  async markNotificationRead(notificationId: string, context: ServiceContext): Promise<void> {
    if (!(await this.repository.findNotification(notificationId, context.parentId))) {
      throw new ParentPortalError('Notification introuvable', 404, 'NOTIFICATION_NOT_FOUND');
    }
    await this.repository.markNotificationRead(notificationId);
  }

  markAllNotificationsRead(context: ServiceContext): Promise<void> {
    return this.repository.markAllNotificationsRead(context.parentId);
  }

  async getStudentSchedule(input: { studentId: string; week: string }, context: ServiceContext) {
    await this.assertStudentAccess(input.studentId, context);

    const classId = await this.repository.getStudentClassId(input.studentId);
    if (!classId) {
      throw new ParentPortalError('Student not found', 404, 'STUDENT_NOT_FOUND');
    }

    const { weekStart, weekEnd, weekLabel } = parseWeek(input.week);
    const [schedules, attendances] = await Promise.all([
      this.repository.listWeekSchedulesForClass({ classId, weekStart, weekEnd }),
      this.repository.listAttendancesForStudentInRange({ studentId: input.studentId, from: weekStart, to: weekEnd }),
    ]);

    const attendanceMap = new Map(attendances.map((row) => [`${row.schedule_id}:${row.date}`, row.status]));

    const now = new Date();
    const days = Array.from({ length: 7 }).map((_, index) => {
      const date = new Date(`${weekStart}T00:00:00.000Z`);
      date.setUTCDate(date.getUTCDate() + index);
      const iso = toIsoDate(date);

      const daySlots = schedules
        .filter((slot) => slot.day_of_week === index + 1)
        .map((slot) => {
          const startAt = toDateWithTime(iso, slot.start_time);
          const endAt = toDateWithTime(iso, slot.end_time);
          const attendance = attendanceMap.get(`${slot.schedule_id}:${iso}`);

          let status: 'present' | 'absent' | 'upcoming' | 'unknown' = 'unknown';
          if (startAt > now) {
            status = 'upcoming';
          } else if (attendance === 'present' || attendance === 'excused') {
            status = 'present';
          } else if (attendance === 'absent') {
            status = 'absent';
          } else if (endAt > now) {
            status = 'upcoming';
          } else {
            // Règle métier parent: cours terminé non pointé => élève présent par défaut.
            status = 'present';
          }

          return {
            time: slot.slot_label,
            subject: slot.subject,
            subjectDisplay: resolveScheduleSubjectDisplay(slot.subject, slot.level_subjects ?? []),
            teacher: slot.teacher_name,
            room: slot.room_name,
            status,
          };
        });

      return {
        day: iso,
        slots: daySlots,
      };
    });

    return {
      week_label: weekLabel,
      days,
    };
  }

  async listStudentAbsences(input: { studentId: string; month: string }, context: ServiceContext) {
    await this.assertStudentAccess(input.studentId, context);

    const { monthStart, monthEnd } = monthBounds(input.month);
    return this.repository.listAbsencesByStudentAndMonth({
      studentId: input.studentId,
      monthStart,
      monthEnd,
    });
  }

  async getStudentGrades(input: {
    studentId: string;
    gradingPeriodId?: string;
  }, context: ServiceContext) {
    await this.assertStudentAccess(input.studentId, context);

    const gradeContext = await this.repository.getStudentActiveGradeContext(input.studentId);
    if (!gradeContext) {
      throw new ParentPortalError('Student not found', 404, 'STUDENT_NOT_FOUND');
    }

    const periods = await this.repository.listGradePeriods(gradeContext.schoolYearId);
    if (input.gradingPeriodId && !periods.some((period) => period.id === input.gradingPeriodId)) {
      throw new ParentPortalError('Grading period not found', 404, 'GRADING_PERIOD_NOT_FOUND');
    }

    const selectedPeriod = input.gradingPeriodId
      ? periods.find((period) => period.id === input.gradingPeriodId) ?? null
      : periods.find((period) => period.isCurrent) ?? periods[0] ?? null;

    if (!selectedPeriod) {
      return {
        schoolYear: { id: gradeContext.schoolYearId, label: gradeContext.schoolYearLabel },
        periods: [],
        selectedGradingPeriodId: null,
        subjects: [],
        conductGrade: null,
        resultsInRevision: false,
      };
    }

    const [subjectRows, conductGrade, resultsInRevision] = await Promise.all([
      this.repository.listAvailableSubjectGrades({
        studentId: input.studentId,
        classId: gradeContext.classId,
        schoolYearId: gradeContext.schoolYearId,
        gradingPeriodId: selectedPeriod.id,
      }),
      this.repository.getStudentConductGrade({
        studentId: input.studentId,
        classId: gradeContext.classId,
        schoolYearId: gradeContext.schoolYearId,
        gradingPeriodId: selectedPeriod.id,
      }),
      this.repository.hasApprovedGradeRevision({
        classId: gradeContext.classId,
        gradingPeriodId: selectedPeriod.id,
      }),
    ]);

    const subjectsById = new Map<string, ParentGradeSubject>();
    for (const row of subjectRows) {
      let subject = subjectsById.get(row.id);
      if (!subject) {
        subject = {
          id: row.id,
          name: row.name,
          average: row.average,
          evaluations: [],
        };
        subjectsById.set(row.id, subject);
      }

      if (
        row.evaluationId &&
        row.evaluationLabel &&
        row.evaluationType &&
        row.coefficient !== null &&
        row.score !== null &&
        row.maxScore !== null
      ) {
        const evaluation: ParentGradeEvaluation = {
          id: row.evaluationId,
          label: row.evaluationLabel,
          date: row.evaluationDate,
          type: row.evaluationType,
          coefficient: row.coefficient,
          score: row.score,
          maxScore: row.maxScore,
        };
        subject.evaluations.push(evaluation);
      }
    }

    return {
      schoolYear: { id: gradeContext.schoolYearId, label: gradeContext.schoolYearLabel },
      periods: periods.map(({ id, label, isCurrent }) => ({ id, label, isCurrent })),
      selectedGradingPeriodId: selectedPeriod.id,
      subjects: [...subjectsById.values()],
      conductGrade,
      resultsInRevision,
    };
  }

  /** Vue d'ensemble enrichie (17b) : finances + dernier bulletin publié, par enfant. */
  async getStudentOverview(input: { studentId: string }, context: ServiceContext) {
    await this.assertStudentAccess(input.studentId, context);
    return this.repository.getParentOverview(input.studentId);
  }

  async getStudentStats(input: { studentId: string }, context: ServiceContext) {
    await this.assertStudentAccess(input.studentId, context);

    const now = new Date();
    const day = now.getUTCDay() || 7;
    const weekStartDate = new Date(now);
    weekStartDate.setUTCDate(now.getUTCDate() - (day - 1));
    const weekEndDate = new Date(weekStartDate);
    weekEndDate.setUTCDate(weekStartDate.getUTCDate() + 6);

    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const { monthStart, monthEnd } = monthBounds(month);
    const yearStart = `${now.getUTCFullYear()}-01-01`;
    const today = toIsoDate(now);

    const [weekAbsences, monthAbsences, yearAbsences, monthBreakdown] = await Promise.all([
      this.repository.countAbsencesForStudentInRange({
        studentId: input.studentId,
        from: toIsoDate(weekStartDate),
        to: toIsoDate(weekEndDate),
      }),
      this.repository.countAbsencesForStudentInRange({
        studentId: input.studentId,
        from: monthStart,
        to: monthEnd,
      }),
      this.repository.countAbsencesForStudentInRange({
        studentId: input.studentId,
        from: yearStart,
        to: today,
      }),
      this.repository.countAttendanceBreakdownForStudentMonth({
        studentId: input.studentId,
        monthStart,
        monthEnd,
      }),
    ]);

    const { attendanceRateMonth, absenceRateMonth } = monthlyAttendanceRates(monthBreakdown);
    return {
      absences_this_week: weekAbsences,
      absences_this_month: monthAbsences,
      attendance_rate_month: attendanceRateMonth,
      absence_rate_month: absenceRateMonth,
      total_absences_year: yearAbsences,
    };
  }

  async getSubscriptionStatus(context: ServiceContext): Promise<{
    subscription: {
      status: ParentSubscriptionStatus;
      starts_at: string;
      ends_at: string;
      days_remaining: number;
      student_count: number;
      monthly_amount_fcfa: number;
      total_amount_fcfa: number;
      duration_months: number;
      auto_renew_alert: boolean;
    } | null;
    offer: { available: boolean; unit_price_fcfa: number | null; billing: 'per_child_per_month' };
  }> {
    const row = await this.repository.getActiveOrLatestSubscription(context.parentId);
    const feature = await this.repository.getSmsOfferSettings();
    const unitPrice = feature?.sms_unit_price_fcfa ?? null;
    const available = feature?.is_enabled === true && feature.monetize_parent_alerts === true
      && unitPrice !== null && unitPrice > 0;
    const offer = {
      available,
      unit_price_fcfa: available ? unitPrice : null,
      billing: 'per_child_per_month' as const,
    };
    if (!row) {
      return { subscription: null, offer };
    }

    const now = new Date();
    const end = new Date(`${row.ends_at}T00:00:00.000Z`);
    const daysRemaining = Math.max(0, Math.ceil((end.getTime() - now.getTime()) / (24 * 3600 * 1000)));

    return {
      offer,
      subscription: {
        status: row.status,
        starts_at: row.starts_at,
        ends_at: row.ends_at,
        days_remaining: daysRemaining,
        student_count: row.student_count,
        monthly_amount_fcfa: Math.round(row.total_amount_fcfa / Math.max(1, row.duration_months)),
        total_amount_fcfa: row.total_amount_fcfa,
        duration_months: row.duration_months,
        auto_renew_alert: row.auto_renew_alert,
      },
    };
  }

  async changePassword(input: { currentPassword: string; newPassword: string }, context: ServiceContext): Promise<void> {
    const profile = await this.repository.findParentById(context.parentId);

    if (!profile || !profile.is_active) {
      throw new ParentPortalError('Invalid credentials', 401, 'UNAUTHORIZED');
    }

    const ok = await argon2.verify(profile.password_hash, input.currentPassword);
    if (!ok) {
      throw new ParentPortalError('Current password is incorrect', 401, 'UNAUTHORIZED');
    }

    const hash = await argon2.hash(input.newPassword);
    await this.repository.updateParentPassword(context.parentId, hash);
  }
}

export const buildParentPortalService = (db: TenantDb): ParentPortalService => {
  return new ParentPortalService(new ParentPortalRepository(db));
};
