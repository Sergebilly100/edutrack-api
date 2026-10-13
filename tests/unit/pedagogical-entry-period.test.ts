import { describe, expect, it } from 'vitest';
import { resolvePedagogicalEntryPeriod } from '../../src/modules/academic/pedagogical-entry-period.js';
import type { GradingPeriodItem } from '../../src/modules/academic/academic-grading.types.js';

const period = (orderIndex: number, startDate: string, reviewStartDate: string, endDate: string): GradingPeriodItem => ({
  id: `period-${orderIndex}`,
  schoolYearId: 'year-1', type: 'trimester', orderIndex, label: `T${orderIndex}`,
  startDate, reviewStartDate, endDate,
  notesEntryOpen: true, conductReviewOpen: false, bulletinGenerationAvailable: false,
  isClosed: false, closedClassIds: [], hasGeneratedCards: false, isCompleted: false, isCurrent: true,
});

const t1 = period(1, '2026-09-01', '2026-11-15', '2026-12-20');
const t2 = period(2, '2026-11-15', '2027-02-15', '2027-03-31');
const t3 = period(3, '2027-02-15', '2027-05-31', '2027-06-30');

describe('période de nouvelle activité pédagogique', () => {
  it('utilise T1 avant la revue et T2 dès le début de revue de T1', () => {
    expect(resolvePedagogicalEntryPeriod([t1, t2, t3], '2026-11-14', 'class-1').period?.id).toBe(t1.id);
    expect(resolvePedagogicalEntryPeriod([t1, t2, t3], '2026-11-15', 'class-1').period?.id).toBe(t2.id);
    const earlyT2 = { ...t2, startDate: '2026-11-10' };
    expect(resolvePedagogicalEntryPeriod([t1, earlyT2, t3], '2026-11-12', 'class-1').period?.id).toBe(t1.id);
  });

  it('refuse une période suivante manquante ou non ouverte pour la date', () => {
    expect(resolvePedagogicalEntryPeriod([t1], '2026-11-15', 'class-1').code).toBe('NEXT_GRADING_PERIOD_REQUIRED');
    expect(resolvePedagogicalEntryPeriod([t1, { ...t2, startDate: '2026-11-14' }], '2026-11-15', 'class-1').period?.id).toBe(t2.id);
    expect(resolvePedagogicalEntryPeriod([t1, { ...t2, startDate: '2026-11-16' }], '2026-11-15', 'class-1').code)
      .toBe('GRADING_PERIOD_CALENDAR_INVALID');
  });

  it('refuse une classe fermée et la fin de la dernière période', () => {
    expect(resolvePedagogicalEntryPeriod([t1, { ...t2, closedClassIds: ['class-1'] }, t3], '2026-11-15', 'class-1').code)
      .toBe('GRADING_PERIOD_CLOSED');
    expect(resolvePedagogicalEntryPeriod([t1, t2, t3], '2027-05-31', 'class-1').code)
      .toBe('NEXT_SCHOOL_YEAR_REQUIRED');
  });

  it('bloque les créations rétroactives et programmées dès le calcul des moyennes de T3', () => {
    expect(resolvePedagogicalEntryPeriod([t1, t2, t3], '2027-05-30', 'class-1', '2027-05-31').code)
      .toBe('FINAL_PERIOD_CALCULATION_STARTED');
    expect(resolvePedagogicalEntryPeriod([t1, t2, t3], '2027-06-10', 'class-1', '2027-05-31').code)
      .toBe('FINAL_PERIOD_CALCULATION_STARTED');
    expect(resolvePedagogicalEntryPeriod([t1, t2, t3], '2027-05-30', 'class-1', '2027-05-30').period?.id)
      .toBe(t3.id);
  });
});
