import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AcademicGradingRepository } from '../../src/modules/academic/academic-grading.repository.js';
import {
  AcademicGradingError,
  AcademicGradingService,
  subjectPreparation,
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
  findTeacherClassScope: vi.fn(),
  listTeacherLessonSlotsForClass: vi.fn(),
  listTeacherAssignedSubjectsForClass: vi.fn(),
  listTeacherScheduleSubjects: vi.fn(),
  listSubjects: vi.fn(),
  listEvaluationsWithGrades: vi.fn(),
  getCompletion: vi.fn(),
  listCorrectionStatuses: vi.fn(),
  getScheduledGradeProgress: vi.fn(),
  getLessonSlotScope: vi.fn(),
  repairUnambiguousLessonSubject: vi.fn(),
  isLessonSlotOccurrence: vi.fn(),
  hasValidatedTeacherAttendance: vi.fn(),
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
  repository.listGradingPeriods.mockResolvedValue([
    {
      id: ids.period, schoolYearId: ids.schoolYear, type: 'trimester', orderIndex: 1,
      label: 'T1', startDate: '2026-09-01', reviewStartDate: '2026-12-01', endDate: '2026-12-20',
      isCompleted: false, closedClassIds: [],
    },
    {
      id: ids.nextPeriod, schoolYearId: ids.schoolYear, type: 'trimester', orderIndex: 2,
      label: 'T2', startDate: '2026-12-01', reviewStartDate: '2027-03-01', endDate: '2027-03-31',
      isCompleted: false, closedClassIds: [],
    },
    {
      id: '550e8400-e29b-41d4-a716-446655440009', schoolYearId: ids.schoolYear,
      type: 'trimester', orderIndex: 3, label: 'T3',
      startDate: '2027-03-01', reviewStartDate: '2027-05-31', endDate: '2027-06-30',
      isCompleted: false, closedClassIds: [],
    },
  ]);
  repository.getSchoolYear.mockResolvedValue({ startDate: '2026-09-01', endDate: '2027-06-30', status: 'active' });
  repository.hasGeneratedCards.mockResolvedValue(false);
  repository.getClassScope.mockResolvedValue({
    id: ids.schoolClass,
    levelId: ids.level,
    schoolYearId: ids.schoolYear,
    schoolYearStatus: 'active',
    isActive: true,
  });
  repository.findTeacherClassScope.mockResolvedValue({ levelId: ids.level });
  repository.listTeacherLessonSlotsForClass.mockResolvedValue([]);
  repository.listTeacherAssignedSubjectsForClass.mockResolvedValue([{ id: ids.subject, name: 'Mathématiques' }]);
  repository.listTeacherScheduleSubjects.mockResolvedValue([]);
  repository.listSubjects.mockResolvedValue([{ id: ids.subject, name: 'Mathématiques' }]);
  repository.listEvaluationsWithGrades.mockResolvedValue([]);
  repository.getCompletion.mockResolvedValue([{ subjectId: ids.subject, status: 'in_progress', calculationStarted: false }]);
  repository.listCorrectionStatuses.mockResolvedValue([]);
  repository.getScheduledGradeProgress.mockResolvedValue([]);
  repository.hasTeacherSubjectAssignment.mockResolvedValue(true);
  repository.isLessonSlotOccurrence.mockResolvedValue(true);
  repository.hasValidatedTeacherAttendance.mockResolvedValue(true);
  repository.repairUnambiguousLessonSubject.mockResolvedValue(true);
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

  it('refuse une revue hors de la période avec un 400 avant toute écriture', async () => {
    await expect(service.updateGradingPeriod(ids.period, {
      reviewStartDate: '2026-12-16',
    })).rejects.toMatchObject({ code: 'INVALID_GRADING_PERIOD_DATES', statusCode: 400 });
    expect(repository.updateGradingPeriod).not.toHaveBeenCalled();
  });
});

describe('AcademicGradingService.updateCompletion', () => {
  it('refuse le calcul après clôture de l’année scolaire', async () => {
    repository.getClassScope.mockResolvedValue({ levelId: ids.level, schoolYearId: ids.schoolYear, schoolYearStatus: 'closed', isActive: true });
    await expect(service.updateCompletion(completionInput, ids.user)).rejects.toMatchObject({ code: 'SCHOOL_YEAR_CLOSED', statusCode: 409 });
    expect(repository.upsertCompletion).not.toHaveBeenCalled();
  });
  it('refuse un démarrage avec des notes manquantes', async () => {
    repository.countMissingScheduledGrades.mockResolvedValue(2);
    await expect(service.updateCompletion(completionInput, ids.user)).rejects.toMatchObject({ code: 'GRADES_INCOMPLETE', statusCode: 409 });
    expect(repository.upsertCompletion).not.toHaveBeenCalled();
  });
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

describe('subjectPreparation', () => {
  const base = { evaluationCount: 1, expectedGrades: 3, enteredGrades: 3, calculationStarted: false, status: 'in_progress' as const, periodClosed: false };

  it('distingue absence d’évaluation, notes manquantes et matière prête', () => {
    expect(subjectPreparation({ ...base, evaluationCount: 0 }).reasons).toContain('NO_EVALUATIONS');
    expect(subjectPreparation({ ...base, enteredGrades: 1 })).toMatchObject({ missingGrades: 2, canStartCalculation: false, reasons: ['GRADES_INCOMPLETE'] });
    expect(subjectPreparation(base)).toMatchObject({ canStartCalculation: true, canFinalize: false });
  });

  it('autorise la révision en cours et verrouille la validation définitive', () => {
    expect(subjectPreparation({ ...base, calculationStarted: true })).toMatchObject({ canRecalculate: true, canFinalize: true });
    expect(subjectPreparation({ ...base, calculationStarted: true, status: 'completed' })).toMatchObject({ canRecalculate: false, canFinalize: false, reasons: ['SUBJECT_COMPLETED'] });
    expect(subjectPreparation({ ...base, periodClosed: true }).reasons).toContain('PERIOD_CLOSED');
    expect(subjectPreparation({ ...base, periodClosed: true, closureReason: 'SCHOOL_YEAR_CLOSED' }).reasons).toContain('SCHOOL_YEAR_CLOSED');
  });
});

describe('AcademicGradingService.listEvaluationsForTeacher', () => {
  it('reconnaît la matière officielle du créneau même si son libellé EDT diffère', async () => {
    repository.listTeacherAssignedSubjectsForClass.mockResolvedValue([]);
    repository.listTeacherScheduleSubjects.mockResolvedValue([{ subjectId: ids.subject, subjectName: 'Maths EDT' }]);
    const result = await service.listEvaluationsForTeacher(ids.schoolClass, ids.period, ids.user, '2026-10-15');
    expect(result.subjects).toEqual([expect.objectContaining({ id: ids.subject })]);
    expect(repository.listTeacherLessonSlotsForClass).toHaveBeenCalledWith(ids.teacher, ids.schoolClass, '2026-10-15');
  });

  it('fournit les compteurs et permissions de la matière affectée', async () => {
    repository.getScheduledGradeProgress.mockResolvedValue([{ subjectId: ids.subject, evaluationCount: 2, expectedGrades: 4, enteredGrades: 3 }]);
    const result = await service.listEvaluationsForTeacher(ids.schoolClass, ids.period, ids.user);
    expect(result.preparation).toEqual([expect.objectContaining({ subjectId: ids.subject, evaluationCount: 2, expectedGrades: 4, enteredGrades: 3, missingGrades: 1, canStartCalculation: false, reasons: ['GRADES_INCOMPLETE'] })]);
    expect(result.periodState).toMatchObject({ isClosed: false, notesEntryOpen: true });
  });

  it('refuse une période forgée hors de l’année scolaire de la classe', async () => {
    repository.findGradingPeriod.mockResolvedValue({ id: ids.period, schoolYearId: ids.nextPeriod, closedClassIds: [], isCompleted: false });
    await expect(service.listEvaluationsForTeacher(ids.schoolClass, ids.period, ids.user)).rejects.toMatchObject({ code: 'EVALUATION_PERIOD_FORBIDDEN', statusCode: 403 });
  });
});

describe('AcademicGradingService.createEvaluation', () => {
  it('refuse une évaluation pour une année active qui n’a pas encore commencé', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T09:00:00.000Z'));
    try {
      await expect(service.createEvaluation({
        classId: ids.schoolClass, subjectId: ids.subject, gradingPeriodId: ids.period,
        type: 'scheduled', coefficient: 1, label: 'Devoir futur', evaluationDate: '2026-09-21',
      }, ids.user)).rejects.toMatchObject({ code: 'SCHOOL_YEAR_NOT_STARTED', statusCode: 409 });
      expect(repository.createEvaluation).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('refuse toute nouvelle évaluation après le début du calcul de la dernière période, même antidatée', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-05-31T09:00:00.000Z'));
    try {
      const lastPeriodId = '550e8400-e29b-41d4-a716-446655440009';
      repository.findGradingPeriod.mockResolvedValue({
        id: lastPeriodId, schoolYearId: ids.schoolYear, startDate: '2027-03-01',
        reviewStartDate: '2027-05-31', endDate: '2027-06-30',
        isCompleted: false, closedClassIds: [],
      });
      await expect(service.createEvaluation({
        classId: ids.schoolClass, subjectId: ids.subject, gradingPeriodId: lastPeriodId,
        type: 'scheduled', coefficient: 1, label: 'Devoir tardif', evaluationDate: '2027-05-30',
      }, ids.user)).rejects.toMatchObject({ code: 'FINAL_PERIOD_CALCULATION_STARTED', statusCode: 409 });
      expect(repository.createEvaluation).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuse une évaluation pour une année préparée mais non ouverte par le support', async () => {
    repository.getClassScope.mockResolvedValue({
      levelId: ids.level, schoolYearId: ids.schoolYear, schoolYearStatus: 'draft', isActive: true,
    });
    await expect(service.createEvaluation({
      classId: ids.schoolClass, subjectId: ids.subject, gradingPeriodId: ids.period,
      type: 'scheduled', coefficient: 1, label: 'Devoir futur', evaluationDate: '2026-09-21',
    }, ids.user)).rejects.toMatchObject({ code: 'CLASS_OR_YEAR_NOT_OPEN', statusCode: 409 });
    expect(repository.createEvaluation).not.toHaveBeenCalled();
  });

  it('autorise une évaluation T1 datée avant la revue', async () => {
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

describe('AcademicGradingService.createSpontaneousGrade', () => {
  it('refuse de deviner une matière historique ambiguë', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T10:30:00.000Z'));
    try {
      const lessonSlotId = '550e8400-e29b-41d4-a716-446655440010';
      repository.getLessonSlotScope.mockResolvedValue({
        id: lessonSlotId, teacherId: ids.teacher, classId: ids.schoolClass,
        dayOfWeek: 1, startTime: '10:00', endTime: '11:00', subjectId: null,
      });
      repository.repairUnambiguousLessonSubject.mockResolvedValue(false);
      await expect(service.createSpontaneousGrade({
        lessonSlotId, classId: ids.schoolClass, subjectId: ids.subject,
        gradingPeriodId: ids.period, evaluationDate: '2026-09-07',
        studentId: ids.user, adjustment: 1, comment: 'Participation',
      }, ids.user)).rejects.toMatchObject({ code: 'SCHEDULE_SUBJECT_REPAIR_REQUIRED' });
      expect(repository.createEvaluation).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('rattache une ancienne matière unique après présence validée, sans appel des élèves', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T10:30:00.000Z'));
    try {
      const lessonSlotId = '550e8400-e29b-41d4-a716-446655440010';
      const slot = { id: lessonSlotId, teacherId: ids.teacher, classId: ids.schoolClass,
        dayOfWeek: 1, startTime: '10:00', endTime: '11:00' };
      repository.getLessonSlotScope
        .mockResolvedValueOnce({ ...slot, subjectId: null })
        .mockResolvedValueOnce({ ...slot, subjectId: null })
        .mockResolvedValue({ ...slot, subjectId: ids.subject });
      repository.studentBelongsToClass.mockResolvedValue(false);
      await expect(service.createSpontaneousGrade({
        lessonSlotId, classId: ids.schoolClass, subjectId: ids.subject,
        gradingPeriodId: ids.period, evaluationDate: '2026-09-07',
        studentId: ids.user, adjustment: 1, comment: 'Participation',
      }, ids.user)).rejects.toMatchObject({ code: 'STUDENT_CLASS_MISMATCH' });
      expect(repository.repairUnambiguousLessonSubject).toHaveBeenCalledWith(
        lessonSlotId, ids.teacher, ids.schoolClass, ids.subject,
      );
    } finally { vi.useRealTimers(); }
  });

  it('refuse aussi la grâce de 24 heures si le professeur était absent de ce cours', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T10:59:00.000Z'));
    try {
      const lessonSlotId = '550e8400-e29b-41d4-a716-446655440010';
      repository.getLessonSlotScope.mockResolvedValue({
        id: lessonSlotId, teacherId: ids.teacher, classId: ids.schoolClass,
        dayOfWeek: 1, startTime: '10:00', endTime: '11:00', subjectId: ids.subject,
      });
      repository.hasValidatedTeacherAttendance.mockResolvedValue(false);
      await expect(service.createSpontaneousGrade({
        lessonSlotId, classId: ids.schoolClass, subjectId: ids.subject,
        gradingPeriodId: ids.period, evaluationDate: '2026-09-07',
        studentId: ids.user, adjustment: 1, comment: 'Participation',
      }, ids.user)).rejects.toMatchObject({ code: 'TEACHER_ATTENDANCE_NOT_VALIDATED' });
      expect(repository.createEvaluation).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('refuse une note pendant le cours sans présence confirmée et validée', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T10:30:00.000Z'));
    try {
      const lessonSlotId = '550e8400-e29b-41d4-a716-446655440010';
      repository.getLessonSlotScope.mockResolvedValue({
        id: lessonSlotId, teacherId: ids.teacher, classId: ids.schoolClass,
        dayOfWeek: 1, startTime: '10:00', endTime: '11:00', subjectId: ids.subject,
      });
      repository.hasValidatedTeacherAttendance.mockResolvedValue(false);
      await expect(service.createSpontaneousGrade({
        lessonSlotId, classId: ids.schoolClass, subjectId: ids.subject,
        gradingPeriodId: ids.period, evaluationDate: '2026-09-07',
        studentId: ids.user, adjustment: 1, comment: 'Participation',
      }, ids.user)).rejects.toMatchObject({ code: 'TEACHER_ATTENDANCE_NOT_VALIDATED', statusCode: 409 });
      expect(repository.hasValidatedTeacherAttendance).toHaveBeenCalledWith(lessonSlotId, ids.teacher, '2026-09-07');
      expect(repository.createEvaluation).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuse une note spontanée dès le début du calcul de la dernière période', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-05-31T10:30:00.000Z'));
    try {
      const lastPeriodId = '550e8400-e29b-41d4-a716-446655440009';
      const lessonSlotId = '550e8400-e29b-41d4-a716-446655440010';
      repository.getLessonSlotScope.mockResolvedValue({
        id: lessonSlotId, teacherId: ids.teacher, classId: ids.schoolClass,
        dayOfWeek: 1, startTime: '10:00', endTime: '11:00', subjectId: ids.subject,
      });
      repository.findGradingPeriod.mockResolvedValue({
        id: lastPeriodId, schoolYearId: ids.schoolYear, startDate: '2027-03-01',
        reviewStartDate: '2027-05-31', endDate: '2027-06-30',
        isCompleted: false, closedClassIds: [],
      });
      await expect(service.createSpontaneousGrade({
        lessonSlotId, classId: ids.schoolClass, subjectId: ids.subject,
        gradingPeriodId: lastPeriodId, evaluationDate: '2027-05-31',
        studentId: ids.user, adjustment: 1, comment: 'Participation',
      }, ids.user)).rejects.toMatchObject({ code: 'FINAL_PERIOD_CALCULATION_STARTED', statusCode: 409 });
      expect(repository.createEvaluation).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
