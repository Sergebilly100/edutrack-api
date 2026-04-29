import argon2 from 'argon2';

import { ParentPortalRepository } from './parent-portal.repository.js';
import type { TenantDb } from './parent-portal.repository.js';
import type { ParentStudentSummary, ParentSubscriptionStatus } from './parent-portal.types.js';

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

export class ParentPortalService {
  constructor(private readonly repository: ParentPortalRepository) {}

  async loginParent(input: {
    phone: string;
    password: string;
  }): Promise<{ parentId: string; studentIds: string[]; mustChangePassword: boolean }> {
    const parent = await this.repository.findParentByPhone(input.phone);
    if (!parent || !parent.is_active) {
      throw new ParentPortalError('Invalid credentials', 401, 'UNAUTHORIZED');
    }

    const isValid = await argon2.verify(parent.password_hash, input.password);
    if (!isValid) {
      throw new ParentPortalError('Invalid credentials', 401, 'UNAUTHORIZED');
    }

    const studentIds = await this.repository.listActiveStudentIds(parent.id);
    if (studentIds.length === 0) {
      throw new ParentPortalError(
        "Votre abonnement a expiré. Contactez l'établissement.",
        403,
        'SUBSCRIPTION_EXPIRED'
      );
    }

    await this.repository.updateParentLastLogin(parent.id);
    return { parentId: parent.id, studentIds, mustChangePassword: parent.must_change_password };
  }

  async listStudents(context: ServiceContext): Promise<ParentStudentSummary[]> {
    return this.repository.listStudentsByParent(context.parentId);
  }

  async getStudentSchedule(input: { studentId: string; week: string }, context: ServiceContext) {
    if (!context.allowedStudentIds.includes(input.studentId)) {
      throw new ParentPortalError('Student access denied', 403, 'STUDENT_ACCESS_DENIED');
    }

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
          }

          return {
            time: slot.slot_label,
            subject: slot.subject,
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
    if (!context.allowedStudentIds.includes(input.studentId)) {
      throw new ParentPortalError('Student access denied', 403, 'STUDENT_ACCESS_DENIED');
    }

    const { monthStart, monthEnd } = monthBounds(input.month);
    return this.repository.listAbsencesByStudentAndMonth({
      studentId: input.studentId,
      monthStart,
      monthEnd,
    });
  }

  async getStudentStats(input: { studentId: string }, context: ServiceContext) {
    if (!context.allowedStudentIds.includes(input.studentId)) {
      throw new ParentPortalError('Student access denied', 403, 'STUDENT_ACCESS_DENIED');
    }

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

    const attendanceRateMonth =
      monthBreakdown.total > 0 ? Math.round((monthBreakdown.present / monthBreakdown.total) * 100) : 0;

    return {
      absences_this_week: weekAbsences,
      absences_this_month: monthAbsences,
      attendance_rate_month: attendanceRateMonth,
      total_absences_year: yearAbsences,
    };
  }

  async getSubscriptionStatus(context: ServiceContext): Promise<{
    status: ParentSubscriptionStatus;
    starts_at: string;
    ends_at: string;
    days_remaining: number;
    student_count: number;
    monthly_amount_fcfa: number;
    total_amount_fcfa: number;
    duration_months: number;
    auto_renew_alert: boolean;
  }> {
    const row = await this.repository.getActiveOrLatestSubscription(context.parentId);
    if (!row) {
      throw new ParentPortalError('Subscription not found', 404, 'SUBSCRIPTION_NOT_FOUND');
    }

    const now = new Date();
    const end = new Date(`${row.ends_at}T00:00:00.000Z`);
    const daysRemaining = Math.max(0, Math.ceil((end.getTime() - now.getTime()) / (24 * 3600 * 1000)));

    return {
      status: row.status,
      starts_at: row.starts_at,
      ends_at: row.ends_at,
      days_remaining: daysRemaining,
      student_count: row.student_count,
      monthly_amount_fcfa: Math.round(row.total_amount_fcfa / Math.max(1, row.duration_months)),
      total_amount_fcfa: row.total_amount_fcfa,
      duration_months: row.duration_months,
      auto_renew_alert: row.auto_renew_alert,
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
