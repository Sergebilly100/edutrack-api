import { describe, expect, it, vi } from 'vitest';
import { getPeriodCapabilities, validatePeriodSequence } from '../../src/modules/academic/grading-period-capabilities.js';

const first = { orderIndex: 1, startDate: '2026-09-01', reviewStartDate: '2026-11-15', endDate: '2026-12-20' };
const second = { orderIndex: 2, startDate: '2026-11-15', reviewStartDate: '2027-02-15', endDate: '2027-03-31' };

describe('grading period capabilities', () => {
  it('utilise la journée métier du serveur lorsque la date est omise', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-12-20T23:59:59Z'));
      expect(getPeriodCapabilities(first, null, false).conductReviewOpen).toBe(true);
      vi.setSystemTime(new Date('2026-12-21T00:00:00Z'));
      expect(getPeriodCapabilities(first, null, false).conductReviewOpen).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  it('garde les notes révisables au début de revue et ouvre la conduite', () => {
    expect(getPeriodCapabilities(first, null, false, '2026-11-14')).toMatchObject({ notesEntryOpen: true, conductReviewOpen: false });
    expect(getPeriodCapabilities(first, null, false, '2026-11-15')).toMatchObject({ notesEntryOpen: true, conductReviewOpen: true, bulletinGenerationAvailable: true });
    expect(getPeriodCapabilities(second, first.reviewStartDate, false, '2026-11-15')).toMatchObject({ notesEntryOpen: true, conductReviewOpen: false });
    expect(getPeriodCapabilities(first, null, false, '2026-12-20')).toMatchObject({ conductReviewOpen: true });
    expect(getPeriodCapabilities(first, null, false, '2026-12-21')).toMatchObject({ conductReviewOpen: false, notesEntryOpen: true });
    expect(getPeriodCapabilities(first, null, false, '2026-11-15', false)).toMatchObject({ conductReviewOpen: false });
  });

  it('ne rouvre pas une classe dont les bulletins sont complets', () => {
    expect(getPeriodCapabilities(first, null, true, '2026-11-15')).toMatchObject({ notesEntryOpen: false, conductReviewOpen: false, isClosed: true });
  });

  it('refuse un calendrier sans chevauchement de saisie et une revue hors période', () => {
    expect(validatePeriodSequence([first, second])).toBeNull();
    expect(validatePeriodSequence([first, { ...second, startDate: '2027-01-01' }])).not.toBeNull();
    expect(validatePeriodSequence([first, { ...second, startDate: '2026-08-31' }])).not.toBeNull();
    expect(validatePeriodSequence([{ ...first, reviewStartDate: '2026-08-31' }])).not.toBeNull();
  });

  it('applique la même transition aux deux semestres', () => {
    const semesterOne = { orderIndex: 1, startDate: '2026-09-01', reviewStartDate: '2027-01-15', endDate: '2027-02-15' };
    const semesterTwo = { orderIndex: 2, startDate: '2027-01-15', reviewStartDate: '2027-05-31', endDate: '2027-06-30' };
    expect(validatePeriodSequence([semesterOne, semesterTwo])).toBeNull();
    expect(getPeriodCapabilities(semesterOne, null, false, '2027-01-15')).toMatchObject({ notesEntryOpen: true, conductReviewOpen: true });
    expect(getPeriodCapabilities(semesterTwo, semesterOne.reviewStartDate, false, '2027-01-15')).toMatchObject({ notesEntryOpen: true, conductReviewOpen: false });
    expect(validatePeriodSequence([semesterOne, { ...semesterTwo, startDate: '2027-02-16' }])).not.toBeNull();
  });
});
