import { describe, expect, it, vi } from 'vitest';
import { birthDateIssue, civilMonthSchema, dateValidationProblem, isCivilDate, isCivilWeek, isOrderedDateRange } from '../../src/shared/utils/date-validation.js';
import { createGradingPeriodBodySchema } from '../../src/modules/academic/academic-grading.types.js';
import { createStudentBodySchema, updateStudentBodySchema, absenceStatsQuerySchema, attendanceHistoryQuerySchema } from '../../src/modules/students/students.types.js';
import { teacherStatsQuerySchema } from '../../src/modules/teachers/teachers.types.js';
import { cashJournalQuerySchema, paymentHistoryQuerySchema, upsertTuitionPlanBodySchema } from '../../src/modules/finance/finance.types.js';
import { openSchoolYearBodySchema } from '../../src/modules/admin/admin.types.js';
import { periodPayloadSchema } from '../../src/modules/schedule/schedule.schemas.js';

describe('civil dates and ranges', () => {
  it('rejects impossible dates and accepts leap days', () => {
    expect(isCivilDate('2024-02-29')).toBe(true);
    for (const value of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-1-01', '0000-01-01']) {
      expect(isCivilDate(value)).toBe(false);
    }
  });

  it('distinguishes inclusive and exclusive boundaries', () => {
    expect(isOrderedDateRange('2026-01-01', '2026-01-01')).toBe(true);
    expect(isOrderedDateRange('2026-01-01', '2026-01-01', false)).toBe(false);
    expect(isOrderedDateRange('2026-01-02', '2026-01-01')).toBe(false);
  });

  it('rejects impossible months and ISO week 53 when the year has 52 weeks', () => {
    expect(civilMonthSchema.safeParse('2026-13').success).toBe(false);
    expect(civilMonthSchema.safeParse('2026-12').success).toBe(true);
    expect(isCivilWeek('2020-W53')).toBe(true);
    expect(isCivilWeek('2021-W53')).toBe(false);
    expect(isCivilWeek('2026-W00')).toBe(false);
  });

  it('uses the Abidjan calendar day at midnight', () => {
    expect(birthDateIssue('2026-10-11', new Date('2026-10-12T00:01:00Z'))).toBeNull();
    expect(birthDateIssue('2026-10-12', new Date('2026-10-12T00:01:00Z'))).toContain('antérieure');
    expect(birthDateIssue('2026-10-12', new Date('2026-10-11T23:59:00Z'))).toContain('antérieure');
    expect(birthDateIssue('2026-02-30')).toContain('invalide');
  });

  it('rejects invalid births in create and update without an age floor', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T00:01:00Z'));
    try {
      expect(createStudentBodySchema.safeParse({ first_name: 'Aya', last_name: 'Kone', birth_date: '1900-01-01' }).success).toBe(true);
      for (const birth_date of ['2026-10-12', '2026-10-13', '2026-02-30']) {
        expect(createStudentBodySchema.safeParse({ first_name: 'Aya', last_name: 'Kone', birth_date }).success).toBe(false);
        expect(updateStudentBodySchema.safeParse({ birth_date }).success).toBe(false);
      }
    } finally { vi.useRealTimers(); }
  });

  it('guards date ranges used by student and teacher routes', () => {
    expect(teacherStatsQuerySchema.safeParse({ date_from: '2026-04-02', date_to: '2026-04-01' }).success).toBe(false);
    expect(teacherStatsQuerySchema.safeParse({ date_from: '2026-02-30', date_to: '2026-04-01' }).success).toBe(false);
    expect(teacherStatsQuerySchema.safeParse({ date_from: '2026-04-01', date_to: '2026-04-01' }).success).toBe(true);
    expect(absenceStatsQuerySchema.safeParse({ from: '2026-04-02', to: '2026-04-01' }).success).toBe(false);
    expect(attendanceHistoryQuerySchema.safeParse({ date_from: '2026-04-02', date_to: '2026-04-01' }).success).toBe(false);
  });

  it('guards finance filters and permits a future tuition deadline', () => {
    expect(cashJournalQuerySchema.safeParse({ from: '2026-04-02', to: '2026-04-01' }).success).toBe(false);
    expect(cashJournalQuerySchema.safeParse({ from: '2026-02-30', to: '2026-04-01' }).success).toBe(false);
    expect(cashJournalQuerySchema.safeParse({ from: '2026-04-01', to: '2026-04-01' }).success).toBe(true);
    const school_year_id = '66f048d8-d053-48e2-b4a8-7fce3ebc3ed8';
    expect(paymentHistoryQuerySchema.safeParse({ school_year_id, from: '2026-04-02', to: '2026-04-01' }).success).toBe(false);
    expect(upsertTuitionPlanBodySchema.safeParse({ schoolYearId: school_year_id, totalAmount: 100,
      scheduleSteps: [{ dueDate: '2099-12-31', cumulativeAmountExpected: 100 }] }).success).toBe(true);
  });

  it('rejects impossible schedule and super-admin school-year dates', () => {
    expect(periodPayloadSchema.safeParse({ name: 'Semaine', valid_from: '2026-02-30', valid_to: '2026-03-01' }).success).toBe(false);
    expect(openSchoolYearBodySchema.safeParse({ label: '2026-2027', start_date: '2026-02-30', end_date: '2027-06-30' }).success).toBe(false);
    expect(openSchoolYearBodySchema.safeParse({ label: '2026-2027', start_date: '2027-07-01', end_date: '2026-09-01' }).success).toBe(false);
  });

  it('returns the shared 400 range code for a grading review outside its period', () => {
    const parsed = createGradingPeriodBodySchema.safeParse({
      schoolYearId: '66f048d8-d053-48e2-b4a8-7fce3ebc3ed8', type: 'trimester', orderIndex: 1,
      label: 'T1', startDate: '2026-09-01', reviewStartDate: '2027-01-01', endDate: '2026-12-20',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(dateValidationProblem(parsed.error)).toMatchObject({ code: 'INVALID_DATE_RANGE', statusCode: 400 });
  });
});
