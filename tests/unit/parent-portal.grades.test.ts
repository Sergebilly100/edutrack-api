import { describe, expect, it, vi } from 'vitest';

import { ParentPortalError, ParentPortalService } from '../../src/modules/parent-portal/parent-portal.service.js';

const activeContext = {
  schoolYearId: 'year-active',
  schoolYearLabel: '2026-2027',
  classId: 'class-one',
};

const periods = [
  { id: 'period-two', label: 'Trimestre 2', orderIndex: 2, isCurrent: true },
  { id: 'period-one', label: 'Trimestre 1', orderIndex: 1, isCurrent: false },
];

const subjectRows = [{
  id: 'subject-math',
  name: 'Mathématiques',
  average: 14.25,
  evaluationId: 'evaluation-one',
  evaluationLabel: 'Devoir surveillé',
  evaluationDate: '2026-10-15',
  evaluationType: 'scheduled' as const,
  coefficient: 2,
  score: 8.5,
  maxScore: 10,
}];

const createRepository = (overrides: Record<string, unknown> = {}) => ({
  parentCanAccessStudent: vi.fn().mockResolvedValue(true),
  getStudentActiveGradeContext: vi.fn().mockResolvedValue(activeContext),
  listGradePeriods: vi.fn().mockResolvedValue(periods),
  listAvailableSubjectGrades: vi.fn().mockResolvedValue(subjectRows),
  getStudentConductGrade: vi.fn().mockResolvedValue(14.5),
  hasApprovedGradeRevision: vi.fn().mockResolvedValue(false),
  ...overrides,
});

describe('ParentPortalService.getStudentGrades', () => {
  it('préfère la période active et ne retourne que les champs parent autorisés', async () => {
    const repository = createRepository();
    const service = new ParentPortalService(repository as never);

    const result = await service.getStudentGrades(
      { studentId: 'student-one' },
      { parentId: 'parent-one', allowedStudentIds: ['student-one', 'student-two'] },
    );

    expect(result.selectedGradingPeriodId).toBe('period-two');
    expect(result.periods).toEqual([
      { id: 'period-two', label: 'Trimestre 2', isCurrent: true },
      { id: 'period-one', label: 'Trimestre 1', isCurrent: false },
    ]);
    expect(repository.listAvailableSubjectGrades).toHaveBeenCalledWith({
      studentId: 'student-one',
      classId: 'class-one',
      schoolYearId: 'year-active',
      gradingPeriodId: 'period-two',
    });
    expect(repository.getStudentConductGrade).toHaveBeenCalledWith({
      studentId: 'student-one',
      classId: 'class-one',
      schoolYearId: 'year-active',
      gradingPeriodId: 'period-two',
    });
    expect(result.conductGrade).toBe(14.5);
    expect(result.subjects).toEqual([{
      id: 'subject-math',
      name: 'Mathématiques',
      average: 14.25,
      evaluations: [{
        id: 'evaluation-one',
        label: 'Devoir surveillé',
        date: '2026-10-15',
        type: 'scheduled',
        coefficient: 2,
        score: 8.5,
        maxScore: 10,
      }],
    }]);
    expect(JSON.stringify(result)).not.toMatch(/comment|rank|student-two/i);
  });

  it('choisit la période la plus récente lorsque aucune période ne couvre la date actuelle', async () => {
    const repository = createRepository({
      listGradePeriods: vi.fn().mockResolvedValue(periods.map((period) => ({ ...period, isCurrent: false }))),
    });
    const service = new ParentPortalService(repository as never);

    const result = await service.getStudentGrades(
      { studentId: 'student-one' },
      { parentId: 'parent-one', allowedStudentIds: ['student-one'] },
    );

    expect(result.selectedGradingPeriodId).toBe('period-two');
  });

  it('retourne les évaluations complètes sans exposer une moyenne encore non validée', async () => {
    const repository = createRepository({
      listAvailableSubjectGrades: vi.fn().mockResolvedValue([{
        ...subjectRows[0],
        average: null,
      }]),
    });
    const service = new ParentPortalService(repository as never);

    const result = await service.getStudentGrades(
      { studentId: 'student-one' },
      { parentId: 'parent-one', allowedStudentIds: ['student-one'] },
    );

    expect(result.subjects).toEqual([{
      id: 'subject-math',
      name: 'Mathématiques',
      average: null,
      evaluations: [{
        id: 'evaluation-one',
        label: 'Devoir surveillé',
        date: '2026-10-15',
        type: 'scheduled',
        coefficient: 2,
        score: 8.5,
        maxScore: 10,
      }],
    }]);
  });

  it('refuse une période hors de l’année active avant de lire les notes', async () => {
    const repository = createRepository();
    const service = new ParentPortalService(repository as never);

    await expect(service.getStudentGrades(
      { studentId: 'student-one', gradingPeriodId: 'period-foreign' },
      { parentId: 'parent-one', allowedStudentIds: ['student-one'] },
    )).rejects.toMatchObject<Partial<ParentPortalError>>({
      code: 'GRADING_PERIOD_NOT_FOUND',
      statusCode: 404,
    });
    expect(repository.listAvailableSubjectGrades).not.toHaveBeenCalled();
  });

  it('refuse un enfant absent des autorisations même si la relation parent existe', async () => {
    const repository = createRepository();
    const service = new ParentPortalService(repository as never);

    await expect(service.getStudentGrades(
      { studentId: 'student-other' },
      { parentId: 'parent-one', allowedStudentIds: ['student-one'] },
    )).rejects.toMatchObject<Partial<ParentPortalError>>({
      code: 'STUDENT_ACCESS_DENIED',
      statusCode: 403,
    });
    expect(repository.getStudentActiveGradeContext).not.toHaveBeenCalled();
  });

  it('retourne un état neutre de révision sans nommer la matière', async () => {
    const repository = createRepository({
      listAvailableSubjectGrades: vi.fn().mockResolvedValue([]),
      hasApprovedGradeRevision: vi.fn().mockResolvedValue(true),
    });
    const service = new ParentPortalService(repository as never);

    const result = await service.getStudentGrades(
      { studentId: 'student-one' },
      { parentId: 'parent-one', allowedStudentIds: ['student-one'] },
    );

    expect(result).toMatchObject({ subjects: [], resultsInRevision: true });
  });
});
