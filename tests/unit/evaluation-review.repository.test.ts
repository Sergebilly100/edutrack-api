import { describe, expect, it, vi } from 'vitest';
import { EvaluationReviewRepository } from '../../src/modules/academic/evaluation-review.repository.js';

const id = (last: string) => `00000000-0000-4000-8000-0000000000${last}`;

describe('assemblage paginé des notes de direction', () => {
  it('conserve les évaluations sans note et identifie les élèves sans score', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [{ grace_days: 7, late_days: 14 }] })
      .mockResolvedValueOnce({ rows: [{ evaluation_count: '2', grade_count: '1', missing_count: '3' }] })
      .mockResolvedValueOnce({ rows: [
        { id: id('01'), label: 'Devoir noté', evaluation_date: '2026-10-01', type: 'scheduled', coefficient: '2', expected_count: '2', entered_count: '1', last_reminder_at: null,
          subject_id: id('02'), subject_name: 'Maths', teacher_id: id('03'), teacher_name: 'Professeur',
          class_id: id('04'), class_name: '6e A', level_id: id('05'), level_name: '6e', period_id: id('06'), period_name: 'T1' },
        { id: id('07'), label: 'Devoir vide', evaluation_date: null, type: 'scheduled', coefficient: '1', expected_count: '2', entered_count: '0', last_reminder_at: null,
          subject_id: id('02'), subject_name: 'Maths', teacher_id: id('03'), teacher_name: 'Professeur',
          class_id: id('04'), class_name: '6e A', level_id: id('05'), level_name: '6e', period_id: id('06'), period_name: 'T1' },
      ] })
      .mockResolvedValueOnce({ rows: [
        { evaluation_id: id('01'), student_id: id('08'), first_name: 'Awa', last_name: 'Kouassi', score: '14', max_score: '20', comment: 'Bien' },
        { evaluation_id: id('01'), student_id: id('09'), first_name: 'Moussa', last_name: 'Koné', score: null, max_score: null, comment: null },
        { evaluation_id: id('07'), student_id: id('08'), first_name: 'Awa', last_name: 'Kouassi', score: null, max_score: null, comment: null },
        { evaluation_id: id('07'), student_id: id('09'), first_name: 'Moussa', last_name: 'Koné', score: null, max_score: null, comment: null },
      ] });
    const repository = new EvaluationReviewRepository({ execute } as unknown as ConstructorParameters<typeof EvaluationReviewRepository>[0]);
    const result = await repository.list({ schoolYearId: id('10'), gradingPeriodId: id('06'), page: 1, pageSize: 20 });
    expect(result.summary).toEqual({ evaluations: 2, grades: 1, missing: 3 });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.notes).toEqual(expect.arrayContaining([
      expect.objectContaining({ studentName: 'KOUASSI Awa', score: 14, maxScore: 20, comment: 'Bien' }),
      expect.objectContaining({ studentName: 'KONÉ Moussa', score: null, maxScore: null }),
    ]));
    expect(result.items[1]?.notes.every((note) => note.score === null)).toBe(true);
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it('regroupe uniquement les élèves notés, par matière, avec le signe de l’ajustement', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [{ students: '2', notes: '3' }] })
      .mockResolvedValueOnce({ rows: [
        { id: id('08'), first_name: 'Awa', last_name: 'Kouassi', matricule: 'CI-001' },
      ] })
      .mockResolvedValueOnce({ rows: [
        { evaluation_id: id('01'), student_id: id('08'), subject_id: id('02'), subject_name: 'Maths',
          class_name: '6e A', teacher_id: id('03'), teacher_name: 'Professeur A', evaluation_date: '2026-10-01', adjustment: '3', comment: 'Bravo' },
        { evaluation_id: id('04'), student_id: id('08'), subject_id: id('05'), subject_name: 'Français',
          class_name: '6e A', teacher_id: id('06'), teacher_name: 'Professeur B', evaluation_date: '2026-10-02', adjustment: '-2', comment: null },
      ] });
    const repository = new EvaluationReviewRepository({ execute } as unknown as ConstructorParameters<typeof EvaluationReviewRepository>[0]);
    const result = await repository.listSpontaneous({ schoolYearId: id('10'), gradingPeriodId: id('11'), page: 1, pageSize: 1 });
    expect(result).toMatchObject({ totalStudents: 2, totalNotes: 3, page: 1, students: [{ name: 'KOUASSI Awa', matricule: 'CI-001',
      subjects: [{ name: 'Maths', notes: [expect.objectContaining({ adjustment: 3, teacher: { id: id('03'), name: 'Professeur A' } })] },
        { name: 'Français', notes: [expect.objectContaining({ adjustment: -2, date: '2026-10-02' })] }],
    }] });
    expect(result.students).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(3);
  });
});
