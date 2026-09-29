import { describe, expect, it, vi } from 'vitest';
import { EvaluationReviewService } from '../../src/modules/academic/evaluation-review.service.js';
import type { EvaluationReviewRepository } from '../../src/modules/academic/evaluation-review.repository.js';

const ids = {
  year: '00000000-0000-4000-8000-000000000001', period: '00000000-0000-4000-8000-000000000002',
  level: '00000000-0000-4000-8000-000000000003', classId: '00000000-0000-4000-8000-000000000004',
  subject: '00000000-0000-4000-8000-000000000005', teacher: '00000000-0000-4000-8000-000000000006',
};

const options = {
  schoolYears: [{ id: ids.year, label: '2026', active: true }],
  gradingPeriods: [{ id: ids.period, label: 'T1', schoolYearId: ids.year, isCurrent: true }],
  levels: [{ id: ids.level, label: '6e' }], classes: [{ id: ids.classId, label: '6e A', levelId: ids.level }],
  subjects: [{ id: ids.subject, label: 'Maths', levelId: ids.level }], teachers: [{ id: ids.teacher, label: 'Professeur' }],
};

const build = () => {
  const repository = { options: vi.fn().mockResolvedValue(options), periodBelongsToYear: vi.fn().mockResolvedValue(true),
    list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    listSpontaneous: vi.fn().mockResolvedValue({ students: [], totalStudents: 0, totalNotes: 0 }) };
  return { service: new EvaluationReviewService(repository as unknown as EvaluationReviewRepository), repository };
};

describe('consultation des évaluations', () => {
  it('refuse une classe, matière ou professeur hors du contexte sélectionné', async () => {
    const { service, repository } = build();
    const base = { schoolYearId: ids.year, gradingPeriodId: ids.period, page: 1, pageSize: 20 };
    await expect(service.list({ ...base, classId: ids.level })).rejects.toMatchObject({ code: 'INVALID_EVALUATION_SCOPE' });
    await expect(service.list({ ...base, subjectId: ids.level })).rejects.toMatchObject({ code: 'INVALID_EVALUATION_SCOPE' });
    await expect(service.list({ ...base, teacherId: ids.level })).rejects.toMatchObject({ code: 'INVALID_EVALUATION_SCOPE' });
    expect(repository.list).not.toHaveBeenCalled();
  });

  it('refuse une période étrangère à l’année et transmet les filtres valides', async () => {
    const { service, repository } = build();
    const query = { schoolYearId: ids.year, gradingPeriodId: ids.period, levelId: ids.level,
      classId: ids.classId, subjectId: ids.subject, teacherId: ids.teacher, page: 2, pageSize: 10 };
    repository.periodBelongsToYear.mockResolvedValueOnce(false);
    await expect(service.list(query)).rejects.toMatchObject({ code: 'INVALID_EVALUATION_SCOPE' });
    await service.list(query);
    expect(repository.options).toHaveBeenCalledWith({ schoolYearId: ids.year, gradingPeriodId: ids.period,
      levelId: ids.level, classId: ids.classId, subjectId: ids.subject });
    expect(repository.list).toHaveBeenCalledWith(query);
    await service.listSpontaneous(query);
    expect(repository.listSpontaneous).toHaveBeenCalledWith(query);
  });

  it('écarte une période étrangère à l’année lors du chargement des filtres', async () => {
    const { service, repository } = build();
    repository.periodBelongsToYear.mockResolvedValue(false);
    await expect(service.options({ schoolYearId: ids.year, gradingPeriodId: ids.period })).rejects.toMatchObject({
      code: 'INVALID_EVALUATION_SCOPE',
    });
    expect(repository.options).not.toHaveBeenCalled();
  });
});
