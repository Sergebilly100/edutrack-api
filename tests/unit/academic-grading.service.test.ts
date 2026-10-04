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
  nextPeriod: '550e8400-e29b-41d4-a716-446655440008',
  level: '550e8400-e29b-41d4-a716-446655440006',
  schoolYear: '550e8400-e29b-41d4-a716-446655440007',
};

const repository = {
  transaction: vi.fn(),
  findTeacherByUserId: vi.fn(),
  lockClassPeriod: vi.fn(),
  findSubject: vi.fn(),
  findGradingPeriod: vi.fn(),
  getSchoolYear: vi.fn(),
  listGradingPeriods: vi.fn(),
  hasGeneratedCards: vi.fn(),
  updateGradingPeriod: vi.fn(),
  findNextGradingPeriod: vi.fn(),
  getClassScope: vi.fn(),
  getLessonSlotScope: vi.fn(),
  hasTeacherSubjectAssignment: vi.fn(),
  getSubjectCompletion: vi.fn(),
  countScheduledEvaluations: vi.fn(),
  countMissingScheduledGrades: vi.fn(),
  upsertCompletion: vi.fn(),
  createEvaluation: vi.fn(),
  findEvaluation: vi.fn(),
  activeCorrectionClaimId: vi.fn(),
  appendAudit: vi.fn(),
  studentBelongsToClass: vi.fn(),
  findGrade: vi.fn(),
  upsertGrade: vi.fn(),
  listStudentPeriodGrades: vi.fn(),
  findConductForAverage: vi.fn(),
  upsertAverage: vi.fn(),
  deleteAverage: vi.fn(),
  markClaimCorrected: vi.fn(),
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
  repository.transaction.mockImplementation(async (work: (repo: AcademicGradingRepository) => Promise<unknown>) =>
    work(repository as unknown as AcademicGradingRepository));
  repository.findTeacherByUserId.mockResolvedValue(ids.teacher);
  repository.findSubject.mockResolvedValue({ id: ids.subject, levelId: ids.level });
  repository.findGradingPeriod.mockResolvedValue({
    id: ids.period,
    schoolYearId: ids.schoolYear,
    isCompleted: false,
    isCurrent: true,
    notesEntryOpen: true,
    closedClassIds: [],
    startDate: '2026-09-01',
    reviewStartDate: '2026-12-01',
    endDate: '2026-12-20',
  });
  repository.findNextGradingPeriod.mockResolvedValue(null);
  repository.getSchoolYear.mockResolvedValue({ startDate: '2026-09-01', endDate: '2027-06-30' });
  repository.hasGeneratedCards.mockResolvedValue(false);
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
  repository.activeCorrectionClaimId.mockResolvedValue(null);
  repository.studentBelongsToClass.mockResolvedValue(true);
  repository.findGrade.mockResolvedValue(null);
  repository.upsertGrade.mockResolvedValue({ score: 12, maxScore: 20, comment: null });
  repository.listStudentPeriodGrades.mockResolvedValue([]);
  repository.findConductForAverage.mockResolvedValue(null);
});

describe('AcademicGradingService.updateGradingPeriod', () => {
  const legacyPeriods = [
    { id: ids.period, schoolYearId: ids.schoolYear, type: 'trimester', orderIndex: 1, label: 'T1', startDate: '2026-09-01', reviewStartDate: '2026-12-15', endDate: '2026-12-15' },
    { id: ids.nextPeriod, schoolYearId: ids.schoolYear, type: 'trimester', orderIndex: 2, label: 'T2', startDate: '2027-01-01', reviewStartDate: '2027-03-15', endDate: '2027-03-15' },
    { id: '550e8400-e29b-41d4-a716-446655440009', schoolYearId: ids.schoolYear, type: 'trimester', orderIndex: 3, label: 'T3', startDate: '2027-04-01', reviewStartDate: '2027-06-01', endDate: '2027-06-30' },
  ];

  beforeEach(() => {
    repository.findGradingPeriod.mockResolvedValue(legacyPeriods[0]);
    repository.listGradingPeriods.mockResolvedValue(legacyPeriods);
    repository.updateGradingPeriod.mockResolvedValue({ ...legacyPeriods[0], reviewStartDate: '2027-01-01', endDate: '2027-01-15' });
  });

  it('permet de réparer une frontière malgré une autre lacune historique', async () => {
    await expect(service.updateGradingPeriod(ids.period, {
      reviewStartDate: '2027-01-01', endDate: '2027-01-15',
    })).resolves.toMatchObject({ reviewStartDate: '2027-01-01' });
    expect(repository.updateGradingPeriod).toHaveBeenCalledWith(ids.period, {
      reviewStartDate: '2027-01-01', endDate: '2027-01-15',
    });
  });

  it('refuse une modification qui laisse la frontière voisine incohérente', async () => {
    await expect(service.updateGradingPeriod(ids.period, {
      reviewStartDate: '2026-12-10', endDate: '2026-12-20',
    })).rejects.toMatchObject({ code: 'GRADING_PERIOD_SEQUENCE_INVALID', statusCode: 409 });
    expect(repository.updateGradingPeriod).not.toHaveBeenCalled();
  });
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
    repository.getSubjectCompletion.mockImplementation(
      async (_classId: string, _subjectId: string, periodId: string) =>
        periodId === ids.period ? { status: 'in_progress' } : null
    );
    repository.countMissingScheduledGrades.mockResolvedValue(1);

    await expect(service.updateCompletion({ ...completionInput, status: 'completed' }, ids.user)).rejects.toMatchObject<
      Partial<AcademicGradingError>
    >({ code: 'GRADES_INCOMPLETE', statusCode: 409 });
    expect(repository.upsertCompletion).not.toHaveBeenCalled();
  });
});

describe('AcademicGradingService.createEvaluation', () => {
  it('autorise une évaluation T1 pendant la revue', async () => {
    repository.findGradingPeriod.mockResolvedValue({
      id: ids.period, schoolYearId: ids.schoolYear, startDate: '2026-09-01',
      reviewStartDate: '2026-11-15', endDate: '2026-12-20',
      notesEntryOpen: false, conductReviewOpen: true, isCompleted: false, closedClassIds: [],
    });
    repository.createEvaluation.mockResolvedValue({ id: 'evaluation-review' });
    await expect(service.createEvaluation({
      classId: ids.schoolClass, subjectId: ids.subject, gradingPeriodId: ids.period,
      type: 'scheduled', coefficient: 1, label: 'Devoir tardif', evaluationDate: '2026-11-10',
    }, ids.user)).resolves.toMatchObject({ evaluation: { id: 'evaluation-review' } });
    expect(repository.appendAudit).toHaveBeenCalledWith(expect.objectContaining({ operation: 'evaluation_created' }));
  });

  it('autorise une note T1 pendant sa revue et trace la création', async () => {
    repository.findEvaluation.mockResolvedValue({
      id: 'evaluation-1', teacherId: ids.teacher, classId: ids.schoolClass,
      subjectId: ids.subject, gradingPeriodId: ids.period,
    });
    repository.findGradingPeriod.mockResolvedValue({
      id: ids.period, schoolYearId: ids.schoolYear, startDate: '2026-09-01',
      reviewStartDate: '2026-11-15', endDate: '2026-12-20',
      notesEntryOpen: false, conductReviewOpen: true, isCompleted: false, closedClassIds: [],
    });
    await expect(service.upsertGrade('evaluation-1', {
      studentId: ids.user, score: 12, maxScore: 20,
    }, ids.user)).resolves.toMatchObject({ grade: { score: 12 } });
    expect(repository.appendAudit).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'grade_created', oldValue: null, studentId: ids.user,
    }));
  });
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
    }, ids.user)).resolves.toEqual({
      evaluation: { id: 'evaluation-1' },
      routedToPeriod: null,
    });

    expect(repository.getLessonSlotScope).not.toHaveBeenCalled();
    expect(repository.createEvaluation).toHaveBeenCalledWith(expect.objectContaining({
      classId: ids.schoolClass,
      subjectId: ids.subject,
    }), ids.teacher);
  });

  it('accepte la période suivante explicitement sélectionnée pendant la revue de la précédente', async () => {
    repository.getSubjectCompletion.mockImplementation(
      async (_classId: string, _subjectId: string, periodId: string) =>
        periodId === ids.period ? { status: 'in_progress' } : null
    );
    repository.findNextGradingPeriod.mockResolvedValue({
      id: ids.nextPeriod,
      schoolYearId: ids.schoolYear,
      label: 'Deuxième trimestre',
      startDate: '2027-01-01',
      endDate: '2027-03-31',
      isCompleted: false,
      isCurrent: false,
      notesEntryOpen: true,
      closedClassIds: [],
    });
    repository.findGradingPeriod.mockImplementation(async (id: string) => id === ids.nextPeriod
      ? {
          id: ids.nextPeriod,
          schoolYearId: ids.schoolYear,
          label: 'Deuxième trimestre',
          startDate: '2027-01-01',
          endDate: '2027-03-31',
          isCompleted: false,
          isCurrent: false,
          notesEntryOpen: true,
          closedClassIds: [],
        }
      : {
          id: ids.period,
          schoolYearId: ids.schoolYear,
          startDate: '2026-09-01',
          endDate: '2026-12-20',
          isCompleted: false,
          isCurrent: true,
          notesEntryOpen: false,
          closedClassIds: [],
        });
    repository.createEvaluation.mockResolvedValue({ id: 'evaluation-2' });

    await expect(service.createEvaluation({
      classId: ids.schoolClass,
      subjectId: ids.subject,
      gradingPeriodId: ids.nextPeriod,
      type: 'scheduled',
      coefficient: 1,
      label: 'Devoir suivant',
      evaluationDate: '2027-01-15',
    }, ids.user)).resolves.toEqual({
      evaluation: { id: 'evaluation-2' },
      routedToPeriod: null,
    });
    expect(repository.createEvaluation).toHaveBeenCalledWith(
      expect.objectContaining({ gradingPeriodId: ids.nextPeriod }),
      ids.teacher
    );
  });

  it('refuse une évaluation dont la date appartient à une autre période sans la rediriger', async () => {
    repository.getSubjectCompletion.mockResolvedValue({ status: 'in_progress' });

    await expect(service.createEvaluation({
      classId: ids.schoolClass,
      subjectId: ids.subject,
      gradingPeriodId: ids.period,
      type: 'scheduled',
      coefficient: 1,
      label: 'Devoir suivant',
      evaluationDate: '2027-01-15',
    }, ids.user)).rejects.toMatchObject<Partial<AcademicGradingError>>({
      code: 'EVALUATION_DATE_OUTSIDE_PERIOD',
      statusCode: 400,
    });
    expect(repository.createEvaluation).not.toHaveBeenCalled();
  });
});
