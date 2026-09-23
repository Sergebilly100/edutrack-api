import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AcademicGradingRepository } from '../../src/modules/academic/academic-grading.repository.js';
import {
  AcademicGradingError,
  AcademicGradingService,
} from '../../src/modules/academic/academic-grading.service.js';

const ids = {
  user: '550e8400-e29b-41d4-a716-446655440001',
  teacher: '550e8400-e29b-41d4-a716-446655440002',
  subject: '550e8400-e29b-41d4-a716-446655440003',
  schoolClass: '550e8400-e29b-41d4-a716-446655440004',
  period: '550e8400-e29b-41d4-a716-446655440005',
  level: '550e8400-e29b-41d4-a716-446655440006',
  schoolYear: '550e8400-e29b-41d4-a716-446655440007',
};

const repository = {
  findTeacherByUserId: vi.fn(),
  findSubject: vi.fn(),
  findGradingPeriod: vi.fn(),
  getClassScope: vi.fn(),
  getLessonSlotScope: vi.fn(),
  hasTeacherSubjectAssignment: vi.fn(),
  getSubjectCompletion: vi.fn(),
  countScheduledEvaluations: vi.fn(),
  countMissingScheduledGrades: vi.fn(),
  upsertCompletion: vi.fn(),
  createEvaluation: vi.fn(),
} as unknown as Record<keyof AcademicGradingRepository, ReturnType<typeof vi.fn>>;

const service = new AcademicGradingService(
  repository as unknown as AcademicGradingRepository,
);

const completionInput = {
  classId: ids.schoolClass,
  subjectId: ids.subject,
  gradingPeriodId: ids.period,
  status: 'in_progress' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  repository.findTeacherByUserId.mockResolvedValue(ids.teacher);
  repository.findSubject.mockResolvedValue({ id: ids.subject, levelId: ids.level });
  repository.findGradingPeriod.mockResolvedValue({
    id: ids.period,
    schoolYearId: ids.schoolYear,
    isCompleted: false,
    isCurrent: true,
  });
  repository.getClassScope.mockResolvedValue({
    id: ids.schoolClass,
    levelId: ids.level,
    schoolYearId: ids.schoolYear,
  });
  repository.hasTeacherSubjectAssignment.mockResolvedValue(true);
  repository.getSubjectCompletion.mockResolvedValue(null);
  repository.countScheduledEvaluations.mockResolvedValue(1);
  repository.countMissingScheduledGrades.mockResolvedValue(0);
  repository.upsertCompletion.mockResolvedValue({ status: 'in_progress' });
});

describe('AcademicGradingService.updateCompletion', () => {
  it('refuse le calcul lorsqu’aucune évaluation programmée n’existe', async () => {
    repository.countScheduledEvaluations.mockResolvedValue(0);

    await expect(service.updateCompletion(completionInput, ids.user)).rejects.toMatchObject<
      Partial<AcademicGradingError>
    >({ code: 'EVALUATIONS_REQUIRED', statusCode: 409 });
    expect(repository.upsertCompletion).not.toHaveBeenCalled();
  });

  it('vérifie de nouveau les notes avant la clôture après un calcul lancé', async () => {
    repository.getSubjectCompletion.mockResolvedValue({ status: 'in_progress' });
    repository.countMissingScheduledGrades.mockResolvedValue(1);

    await expect(service.updateCompletion({ ...completionInput, status: 'completed' }, ids.user)).rejects.toMatchObject<
      Partial<AcademicGradingError>
    >({ code: 'GRADES_INCOMPLETE', statusCode: 409 });
    expect(repository.upsertCompletion).not.toHaveBeenCalled();
  });
});

describe('AcademicGradingService.createEvaluation', () => {
  it('autorise une évaluation sans créneau EDT pour une affectation professeur-matière-classe', async () => {
    repository.createEvaluation.mockResolvedValue({ id: 'evaluation-1' });

    await expect(service.createEvaluation({
      classId: ids.schoolClass,
      subjectId: ids.subject,
      gradingPeriodId: ids.period,
      type: 'scheduled',
      coefficient: 1,
      label: 'Devoir sans EDT',
      evaluationDate: '2026-09-21',
    }, ids.user)).resolves.toEqual({ id: 'evaluation-1' });

    expect(repository.getLessonSlotScope).not.toHaveBeenCalled();
    expect(repository.createEvaluation).toHaveBeenCalledWith(expect.objectContaining({
      classId: ids.schoolClass,
      subjectId: ids.subject,
    }), ids.teacher);
  });
});
