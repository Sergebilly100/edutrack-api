import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcademicGradingRepository, type AcademicGradingQueryExecutor } from '../../src/modules/academic/academic-grading.repository.js';

afterEach(() => vi.useRealTimers());

describe('AcademicGradingRepository period capabilities', () => {
  it('expose simultanément T1 en revue, T2 en saisie et la clôture de la seule classe complète', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-15T12:00:00.000Z'));
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [
        { id: 'p1', school_year_id: 'y1', school_year_status: 'active', type: 'trimester', order_index: 1, label: 'T1', start_date: '2026-09-01', review_start_date: '2026-11-15', end_date: '2026-12-20' },
        { id: 'p2', school_year_id: 'y1', school_year_status: 'active', type: 'trimester', order_index: 2, label: 'T2', start_date: '2026-11-15', review_start_date: '2027-02-15', end_date: '2027-03-31' },
      ] })
      .mockResolvedValueOnce({ rows: [
        { grading_period_id: 'p1', class_id: 'c1', class_closed: true, has_cards: true },
        { grading_period_id: 'p1', class_id: 'c2', class_closed: false, has_cards: false },
        { grading_period_id: 'p2', class_id: 'c1', class_closed: false, has_cards: false },
        { grading_period_id: 'p2', class_id: 'c2', class_closed: false, has_cards: false },
      ] });
    const repository = new AcademicGradingRepository({ execute } as unknown as AcademicGradingQueryExecutor);
    const [first, second] = await repository.listGradingPeriods('y1');
    expect(first).toMatchObject({ notesEntryOpen: true, conductReviewOpen: true, bulletinGenerationAvailable: true, isClosed: false, closedClassIds: ['c1'], hasGeneratedCards: true });
    expect(second).toMatchObject({ notesEntryOpen: true, conductReviewOpen: false, closedClassIds: [] });
  });
});
