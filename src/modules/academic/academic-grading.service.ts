import { canonicalizeSubject, normalizeSubjectKey } from '../../shared/utils/subject-normalization.js';
import {
  calculateGeneralAverage,
  calculateSubjectAverage,
} from './academic-grading.calculations.js';
import { AcademicGradingRepository } from './academic-grading.repository.js';
import { validatePeriodChange, validatePeriodSequence } from './grading-period-capabilities.js';
import type {
  CompletionInput,
  CreateEvaluationInput,
  CreateGradingPeriodInput,
  CreateSubjectInput,
  CreateSubjectsBulkInput,
  UpdateSubjectsBulkInput,
  UpdateGradingPeriodInput,
  UpdateSubjectInput,
  UpsertEvaluationGradeInput,
  SpontaneousGradeInput,
} from './academic-grading.types.js';

export class AcademicGradingError extends Error {
  constructor(message: string, public readonly statusCode: number, public readonly code: string) {
    super(message);
    this.name = 'AcademicGradingError';
  }
}

const dbCode = (error: unknown): string => {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== 'object') return '';
    if ('code' in current && typeof current.code === 'string') return current.code;
    current = 'cause' in current ? current.cause : undefined;
  }
  return '';
};

export type PreparationReason = 'PERIOD_CLOSED' | 'SCHOOL_YEAR_CLOSED' | 'CLASS_INACTIVE' | 'NO_EVALUATIONS' | 'GRADES_INCOMPLETE' | 'SUBJECT_COMPLETED';

export function subjectPreparation(input: {
  evaluationCount: number; expectedGrades: number; enteredGrades: number;
  calculationStarted: boolean; status: 'in_progress' | 'completed'; periodClosed: boolean;
  closureReason?: 'SCHOOL_YEAR_CLOSED' | 'CLASS_INACTIVE' | 'PERIOD_CLOSED' | null;
}) {
  const missingGrades = Math.max(0, input.expectedGrades - input.enteredGrades);
  const reasons: PreparationReason[] = [];
  if (input.periodClosed) reasons.push(input.closureReason ?? 'PERIOD_CLOSED');
  if (input.status === 'completed' && input.calculationStarted) reasons.push('SUBJECT_COMPLETED');
  if (input.evaluationCount === 0) reasons.push('NO_EVALUATIONS');
  if (missingGrades > 0) reasons.push('GRADES_INCOMPLETE');
  const ready = reasons.length === 0;
  return {
    evaluationCount: input.evaluationCount,
    expectedGrades: input.expectedGrades,
    enteredGrades: input.enteredGrades,
    missingGrades,
    reasons,
    canStartCalculation: ready && !input.calculationStarted,
    canRecalculate: ready && input.calculationStarted,
    canFinalize: ready && input.calculationStarted,
  };
}

const assertPeriodOrder = (type: 'trimester' | 'semester', orderIndex: number): void => {
  const maximum = type === 'trimester' ? 3 : 2;
  if (orderIndex > maximum) {
    throw new AcademicGradingError(
      `${type === 'trimester' ? 'Trimester' : 'Semester'} order must be between 1 and ${maximum}`,
      400,
      'INVALID_GRADING_PERIOD_ORDER'
    );
  }
};

const toSlotDateTime = (date: string, time: string): Date =>
  new Date(`${date}T${time.slice(0, 5)}:00.000Z`);

const dayOfWeekFromIsoDate = (date: string): number => {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return day === 0 ? 7 : day;
};

export const isWithinSpontaneousGradeWindow = (
  evaluationDate: string,
  slotStartTime: string,
  slotEndTime: string,
  now = new Date()
): boolean => {
  const slotStart = toSlotDateTime(evaluationDate, slotStartTime);
  const slotEnd = toSlotDateTime(evaluationDate, slotEndTime);
  const deadline = new Date(slotEnd.getTime() + 24 * 60 * 60 * 1000);
  return now >= slotStart && now <= deadline;
};

export class AcademicGradingService {
  constructor(private readonly repository: AcademicGradingRepository) {}

  private async syncAssignmentsFromSchedule(subject: { id: string; levelId: string; name: string }): Promise<void> {
    const candidates = await this.repository.listScheduleAssignmentsForLevel(subject.levelId);
    const subjectKey = normalizeSubjectKey(subject.name);
    for (const candidate of candidates) {
      if (normalizeSubjectKey(candidate.subjectName) === subjectKey) {
        await this.repository.ensureTeacherSubjectAssignment(
          candidate.teacherId,
          subject.id,
          candidate.classId
        );
      }
    }
  }

  async listSubjects(levelId?: string) {
    return { subjects: await this.repository.listSubjects(levelId) };
  }

  async createSubject(input: CreateSubjectInput) {
    const name = canonicalizeSubject(input.name);
    try {
      const subject = await this.repository.createSubject({ ...input, name });
      await this.syncAssignmentsFromSchedule(subject);
      return subject;
    } catch (error) {
      if (dbCode(error) === '23503') {
        throw new AcademicGradingError('Level not found', 400, 'SUBJECT_LEVEL_NOT_FOUND');
      }
      if (dbCode(error) === '23505') {
        throw new AcademicGradingError('Subject already exists for this level', 409, 'SUBJECT_CONFLICT');
      }
      throw error;
    }
  }

  async createSubjectsBulk(input: CreateSubjectsBulkInput) {
    const name = canonicalizeSubject(input.name);
    const levelIds = input.assignments.map((assignment) => assignment.levelId);
    const conflicts = await this.repository.listSubjectConflicts(levelIds, name);
    if (conflicts.length > 0) {
      throw new AcademicGradingError(
        `Cette matière existe déjà pour : ${conflicts.map((item) => item.levelName).join(', ')}`,
        409,
        'SUBJECT_BATCH_CONFLICT'
      );
    }

    try {
      const subjects = [];
      for (const assignment of input.assignments) {
        const subject = await this.repository.createSubject({
          levelId: assignment.levelId,
          name,
          abbreviation: input.abbreviation,
          coefficient: assignment.coefficient,
        });
        await this.syncAssignmentsFromSchedule(subject);
        subjects.push(subject);
      }
      return subjects;
    } catch (error) {
      if (dbCode(error) === '23503') {
        throw new AcademicGradingError('Level not found', 400, 'SUBJECT_LEVEL_NOT_FOUND');
      }
      if (dbCode(error) === '23505') {
        throw new AcademicGradingError('Subject already exists for one of the selected levels', 409, 'SUBJECT_BATCH_CONFLICT');
      }
      throw error;
    }
  }

  async updateSubjectsBulk(input: UpdateSubjectsBulkInput) {
    const name = canonicalizeSubject(input.name);
    const existingAssignments = input.assignments.filter((assignment) => assignment.subjectId !== undefined);
    const newAssignments = input.assignments.filter((assignment) => assignment.subjectId === undefined);
    const currentSubjects = await Promise.all(
      existingAssignments.map(async (assignment) => ({
        assignment,
        subject: await this.repository.findSubject(assignment.subjectId!),
      }))
    );
    const missingSubject = currentSubjects.find((item) => !item.subject);
    if (missingSubject) {
      throw new AcademicGradingError('Subject not found', 404, 'SUBJECT_NOT_FOUND');
    }

    const originalNameKeys = new Set(
      currentSubjects.map((item) => normalizeSubjectKey(item.subject!.name))
    );
    if (originalNameKeys.size !== 1) {
      throw new AcademicGradingError(
        'Les matières sélectionnées ne forment pas un même groupe',
        400,
        'SUBJECT_BATCH_GROUP_MISMATCH'
      );
    }

    const levelMismatch = currentSubjects.find(
      (item) => item.subject!.levelId !== item.assignment.levelId
    );
    if (levelMismatch) {
      throw new AcademicGradingError(
        'Le niveau d’une matière existante ne peut pas être modifié',
        400,
        'SUBJECT_LEVEL_IMMUTABLE'
      );
    }

    const selectedSubjectIds = new Set(existingAssignments.map((assignment) => assignment.subjectId));
    const conflicts = (await this.repository.listSubjectConflicts(
      input.assignments.map((assignment) => assignment.levelId),
      name
    )).filter((conflict) => !selectedSubjectIds.has(conflict.id));
    if (conflicts.length > 0) {
      throw new AcademicGradingError(
        `Cette matière existe déjà pour : ${conflicts.map((item) => item.levelName).join(', ')}`,
        409,
        'SUBJECT_BATCH_CONFLICT'
      );
    }

    try {
      const subjects = [];
      for (const { assignment } of currentSubjects) {
        const subject = await this.repository.updateSubject(assignment.subjectId!, {
          name,
          abbreviation: input.abbreviation,
          coefficient: assignment.coefficient,
        });
        if (!subject) throw new AcademicGradingError('Subject not found', 404, 'SUBJECT_NOT_FOUND');
        await this.syncAssignmentsFromSchedule(subject);
        subjects.push(subject);
      }
      for (const assignment of newAssignments) {
        const subject = await this.repository.createSubject({
          levelId: assignment.levelId,
          name,
          abbreviation: input.abbreviation,
          coefficient: assignment.coefficient,
        });
        await this.syncAssignmentsFromSchedule(subject);
        subjects.push(subject);
      }
      return subjects;
    } catch (error) {
      if (error instanceof AcademicGradingError) throw error;
      if (dbCode(error) === '23503') {
        throw new AcademicGradingError('Level not found', 400, 'SUBJECT_LEVEL_NOT_FOUND');
      }
      if (dbCode(error) === '23505') {
        throw new AcademicGradingError('Subject already exists for one of the selected levels', 409, 'SUBJECT_BATCH_CONFLICT');
      }
      throw error;
    }
  }

  async updateSubject(id: string, input: UpdateSubjectInput) {
    try {
      const subject = await this.repository.updateSubject(id, {
        ...input,
        ...(input.name ? { name: canonicalizeSubject(input.name) } : {}),
      });
      if (!subject) throw new AcademicGradingError('Subject not found', 404, 'SUBJECT_NOT_FOUND');
      await this.syncAssignmentsFromSchedule(subject);
      return subject;
    } catch (error) {
      if (error instanceof AcademicGradingError) throw error;
      if (dbCode(error) === '23505') {
        throw new AcademicGradingError('Subject already exists for this level', 409, 'SUBJECT_CONFLICT');
      }
      throw error;
    }
  }

  async deleteSubject(id: string) {
    try {
      if (!(await this.repository.deleteSubject(id))) {
        throw new AcademicGradingError('Subject not found', 404, 'SUBJECT_NOT_FOUND');
      }
    } catch (error) {
      if (error instanceof AcademicGradingError) throw error;
      if (dbCode(error) === '23503') {
        throw new AcademicGradingError('Subject is in use and cannot be deleted', 409, 'SUBJECT_IN_USE');
      }
      throw error;
    }
  }

  async listGradingPeriods(schoolYearId?: string) {
    return { gradingPeriods: await this.repository.listGradingPeriods(schoolYearId) };
  }

  private async assertPeriod(input: CreateGradingPeriodInput): Promise<void> {
    assertPeriodOrder(input.type, input.orderIndex);
    const schoolYear = await this.repository.getSchoolYear(input.schoolYearId);
    if (!schoolYear) {
      throw new AcademicGradingError('School year not found', 400, 'GRADING_PERIOD_SCHOOL_YEAR_NOT_FOUND');
    }
    if (input.startDate < schoolYear.startDate || input.endDate > schoolYear.endDate) {
      throw new AcademicGradingError('Grading period must be within its school year', 400, 'GRADING_PERIOD_OUTSIDE_SCHOOL_YEAR');
    }
    if (schoolYear.gradingPeriodType !== input.type) {
      throw new AcademicGradingError('The grading period must match the school year cycle', 409, 'GRADING_PERIOD_TYPE_CONFLICT');
    }
    const existing = await this.repository.listGradingPeriods(input.schoolYearId);
    const error = validatePeriodSequence([...existing.filter((period) => period.orderIndex !== input.orderIndex), input]);
    if (error) throw new AcademicGradingError(error, 409, 'GRADING_PERIOD_SEQUENCE_INVALID');
  }

  async createGradingPeriod(input: CreateGradingPeriodInput) {
    await this.assertPeriod(input);
    try {
      return await this.repository.createGradingPeriod(input);
    } catch (error) {
      if (dbCode(error) === '23505') {
        throw new AcademicGradingError('Grading period already exists', 409, 'GRADING_PERIOD_CONFLICT');
      }
      throw error;
    }
  }

  async updateGradingPeriod(id: string, input: UpdateGradingPeriodInput) {
    const current = await this.repository.findGradingPeriod(id);
    if (!current) throw new AcademicGradingError('Grading period not found', 404, 'GRADING_PERIOD_NOT_FOUND');
    if (await this.repository.hasGeneratedCards(id)) {
      throw new AcademicGradingError('Le calendrier est figé depuis la génération des bulletins', 409, 'GRADING_PERIOD_CARDS_EXIST');
    }
    const merged = {
      schoolYearId: current.schoolYearId,
      type: current.type,
      orderIndex: input.orderIndex ?? current.orderIndex,
      label: input.label ?? current.label,
      startDate: input.startDate ?? current.startDate,
      reviewStartDate: input.reviewStartDate ?? current.reviewStartDate,
      endDate: input.endDate ?? current.endDate,
    };
    if (merged.startDate > merged.endDate) {
      throw new AcademicGradingError('Period start date must be before or equal to end date', 400, 'INVALID_GRADING_PERIOD_DATES');
    }
    assertPeriodOrder(merged.type, merged.orderIndex);
    const schoolYear = await this.repository.getSchoolYear(merged.schoolYearId);
    if (!schoolYear || merged.startDate < schoolYear.startDate || merged.endDate > schoolYear.endDate) {
      throw new AcademicGradingError('Grading period must be within its school year', 400, 'GRADING_PERIOD_OUTSIDE_SCHOOL_YEAR');
    }
    const periods = await this.repository.listGradingPeriods(merged.schoolYearId);
    const error = validatePeriodChange([...periods.filter((period) => period.id !== id), merged], merged.orderIndex);
    if (error) throw new AcademicGradingError(error, 409, 'GRADING_PERIOD_SEQUENCE_INVALID');
    try {
      return await this.repository.updateGradingPeriod(id, input);
    } catch (error) {
      if (dbCode(error) === '23505') {
        throw new AcademicGradingError('Grading period already exists', 409, 'GRADING_PERIOD_CONFLICT');
      }
      throw error;
    }
  }

  async deleteGradingPeriod(id: string) {
    try {
      if (!(await this.repository.deleteGradingPeriod(id))) {
        throw new AcademicGradingError('Grading period not found', 404, 'GRADING_PERIOD_NOT_FOUND');
      }
    } catch (error) {
      if (error instanceof AcademicGradingError) throw error;
      if (dbCode(error) === '23503') {
        throw new AcademicGradingError('Grading period is in use and cannot be deleted', 409, 'GRADING_PERIOD_IN_USE');
      }
      throw error;
    }
  }

  private async teacherIdForUser(userId: string): Promise<string> {
    const teacherId = await this.repository.findTeacherByUserId(userId);
    if (!teacherId) throw new AcademicGradingError('Teacher profile not found', 403, 'TEACHER_PROFILE_NOT_FOUND');
    return teacherId;
  }

  private async assertSubjectOpen(
    classId: string,
    subjectId: string,
    gradingPeriodId: string,
  ): Promise<void> {
    await this.repository.lockClassPeriod(classId, gradingPeriodId);
    const [period, schoolClass] = await Promise.all([
      this.repository.findGradingPeriod(gradingPeriodId),
      this.repository.getClassScope(classId),
    ]);
    if (!period) {
      throw new AcademicGradingError('Grading period not found', 400, 'GRADING_PERIOD_NOT_FOUND');
    }
    if (schoolClass?.schoolYearStatus === 'closed') {
      throw new AcademicGradingError('L’année scolaire est clôturée', 409, 'SCHOOL_YEAR_CLOSED');
    }
    if (schoolClass?.isActive === false) {
      throw new AcademicGradingError('La classe est inactive', 409, 'CLASS_INACTIVE');
    }
    if (period.isCompleted || period.closedClassIds.includes(classId)) {
      throw new AcademicGradingError(
        'Cette période est finalisée : ses bulletins ont déjà été générés',
        409,
        'GRADING_PERIOD_COMPLETED'
      );
    }
    const completion = await this.repository.getSubjectCompletion(classId, subjectId, gradingPeriodId);
    if (completion?.status === 'completed') {
      throw new AcademicGradingError(
        'La saisie est clôturée pour cette classe, cette matière et cette période',
        409,
        'SUBJECT_AVERAGES_VALIDATED'
      );
    }
  }

  async getTeacherAcademicContext(userId: string) {
    const teacherId = await this.teacherIdForUser(userId);
    const [classes, gradingPeriods] = await Promise.all([
      this.repository.listTeacherAcademicClasses(teacherId),
      this.repository.listTeacherGradingPeriods(teacherId),
    ]);
    return { classes, gradingPeriods };
  }

  /** Espace de saisie prof : créneaux, matières et évaluations d'une classe/période. */
  async listEvaluationsForTeacher(classId: string, gradingPeriodId: string, userId: string) {
    const teacherId = await this.teacherIdForUser(userId);
    const scope = await this.repository.findTeacherClassScope(teacherId, classId);
    if (!scope) {
      throw new AcademicGradingError('Class is outside the teacher scope', 403, 'EVALUATION_SCOPE_FORBIDDEN');
    }
    const [schoolClass, period] = await Promise.all([
      this.repository.getClassScope(classId),
      this.repository.findGradingPeriod(gradingPeriodId),
    ]);
    if (!schoolClass || !period || schoolClass.schoolYearId !== period.schoolYearId) {
      throw new AcademicGradingError('Period is outside the teacher class scope', 403, 'EVALUATION_PERIOD_FORBIDDEN');
    }
    const [rawLessonSlots, assignedSubjects, scheduledSubjectNames, levelSubjects, evaluations, completion, correctionStatuses, gradeProgress] = await Promise.all([
      this.repository.listTeacherLessonSlotsForClass(teacherId, classId),
      this.repository.listTeacherAssignedSubjectsForClass(teacherId, classId),
      this.repository.listTeacherScheduleSubjects(teacherId, classId),
      scope.levelId ? this.repository.listSubjects(scope.levelId) : Promise.resolve([]),
      this.repository.listEvaluationsWithGrades(teacherId, classId, gradingPeriodId),
      this.repository.getCompletion(classId, gradingPeriodId),
      this.repository.listCorrectionStatuses(classId, gradingPeriodId),
      this.repository.getScheduledGradeProgress(teacherId, classId, gradingPeriodId),
    ]);
    const assignedSubjectIds = new Set(assignedSubjects.map((subject) => subject.id));
    const scheduledSubjectKeys = new Set(scheduledSubjectNames.map(normalizeSubjectKey));
    const subjects = levelSubjects.filter(
      (subject) => assignedSubjectIds.has(subject.id) || scheduledSubjectKeys.has(normalizeSubjectKey(subject.name))
    );
    const lessonSlots = rawLessonSlots.map((slot) => ({
      ...slot,
      subjectId: subjects.find(
        (subject) => normalizeSubjectKey(subject.name) === normalizeSubjectKey(slot.subjectName)
      )?.id ?? null,
    }));
    const subjectIds = new Set(subjects.map((subject) => subject.id));
    const progressBySubject = new Map(gradeProgress.map((item) => [item.subjectId, item]));
    const closureReason = schoolClass.schoolYearStatus === 'closed' ? 'SCHOOL_YEAR_CLOSED'
      : schoolClass.isActive === false ? 'CLASS_INACTIVE'
        : period.isCompleted || period.closedClassIds.includes(classId) ? 'PERIOD_CLOSED' : null;
    const periodClosed = closureReason !== null;
    return {
      lessonSlots,
      subjects,
      evaluations,
      completion: completion.filter((item) => subjectIds.has(item.subjectId)),
      correctionStatuses: correctionStatuses.filter((item) => subjectIds.has(item.subjectId)),
      periodState: {
        isClosed: periodClosed,
        schoolYearStatus: schoolClass.schoolYearStatus,
        classActive: schoolClass.isActive,
        notesEntryOpen: period.notesEntryOpen,
        reviewOpen: period.conductReviewOpen,
        reason: closureReason,
      },
      preparation: subjects.map((subject) => {
        const state = completion.find((item) => item.subjectId === subject.id);
        const counts = progressBySubject.get(subject.id);
        const correction = correctionStatuses.find((item) => item.subjectId === subject.id);
        return {
          subjectId: subject.id,
          subjectName: subject.name,
          status: state?.status ?? 'in_progress',
          calculationStarted: state?.calculationStarted ?? false,
          correctionStatus: correction?.status ?? null,
          ...subjectPreparation({
            evaluationCount: counts?.evaluationCount ?? 0,
            expectedGrades: counts?.expectedGrades ?? 0,
            enteredGrades: counts?.enteredGrades ?? 0,
            calculationStarted: state?.calculationStarted ?? false,
            status: state?.status ?? 'in_progress',
            periodClosed,
            closureReason,
          }),
        };
      }),
    };
  }

  private async assertEvaluationScope(
    input: CreateEvaluationInput,
    teacherId: string,
  ): Promise<void> {
    const [slot, subject, period, schoolClass] = await Promise.all([
      input.lessonSlotId ? this.repository.getLessonSlotScope(input.lessonSlotId) : Promise.resolve(null),
      this.repository.findSubject(input.subjectId),
      this.repository.findGradingPeriod(input.gradingPeriodId),
      this.repository.getClassScope(input.classId),
    ]);
    if (!subject) throw new AcademicGradingError('Subject not found', 400, 'SUBJECT_NOT_FOUND');
    if (!period) throw new AcademicGradingError('Grading period not found', 400, 'GRADING_PERIOD_NOT_FOUND');
    if (!schoolClass) throw new AcademicGradingError('Class not found', 400, 'CLASS_NOT_FOUND');
    if (input.evaluationDate && (input.evaluationDate < period.startDate || input.evaluationDate > period.endDate)) {
      throw new AcademicGradingError('Evaluation date must fall within the grading period', 400, 'EVALUATION_DATE_OUTSIDE_PERIOD');
    }
    if (schoolClass.levelId !== subject.levelId || schoolClass.schoolYearId !== period.schoolYearId) {
      throw new AcademicGradingError('Subject or period does not match the lesson class', 400, 'EVALUATION_SCOPE_MISMATCH');
    }
    let assigned = await this.repository.hasTeacherSubjectAssignment(teacherId, subject.id, input.classId);
    if (!assigned) {
      const scheduledSubjectNames = await this.repository.listTeacherScheduleSubjects(teacherId, input.classId);
      assigned = scheduledSubjectNames.some(
        (scheduledSubject) => normalizeSubjectKey(scheduledSubject) === normalizeSubjectKey(subject.name)
      );
      if (assigned) {
        await this.repository.ensureTeacherSubjectAssignment(teacherId, subject.id, input.classId);
      }
    }
    if (!assigned) {
      throw new AcademicGradingError('Subject is outside the teacher scope', 403, 'EVALUATION_SCOPE_FORBIDDEN');
    }
    if (input.lessonSlotId && !slot) throw new AcademicGradingError('Lesson slot not found', 400, 'LESSON_SLOT_NOT_FOUND');
    if (slot && (slot.teacherId !== teacherId || slot.classId !== input.classId)) {
      throw new AcademicGradingError('Lesson slot is outside the teacher scope', 403, 'EVALUATION_SCOPE_FORBIDDEN');
    }
    if (slot && normalizeSubjectKey(slot.subjectName) !== normalizeSubjectKey(subject.name)) {
      throw new AcademicGradingError('Subject does not match the lesson slot', 400, 'EVALUATION_SUBJECT_MISMATCH');
    }

    await this.assertSubjectOpen(input.classId, input.subjectId, input.gradingPeriodId);

  }

  async createEvaluation(input: CreateEvaluationInput, userId: string) {
    return this.repository.transaction((repository) =>
      new AcademicGradingService(repository).createEvaluationInTransaction(input, userId));
  }

  private async createEvaluationInTransaction(input: CreateEvaluationInput, userId: string) {
    const teacherId = await this.teacherIdForUser(userId);
    await this.assertEvaluationScope(input, teacherId);
    const evaluation = await this.repository.createEvaluation(input, teacherId);
    await this.repository.appendAudit({
      actorUserId: userId, classId: input.classId, subjectId: input.subjectId,
      gradingPeriodId: input.gradingPeriodId, evaluationId: evaluation.id,
      claimId: await this.repository.activeCorrectionClaimId(input.classId, input.subjectId, input.gradingPeriodId),
      operation: 'evaluation_created', oldValue: null, newValue: evaluation,
    });
    return { evaluation, routedToPeriod: null };
  }

  async upsertGrade(evaluationId: string, input: UpsertEvaluationGradeInput, userId: string) {
    return this.repository.transaction((repository) =>
      new AcademicGradingService(repository).upsertGradeInTransaction(evaluationId, input, userId));
  }

  private async upsertGradeInTransaction(evaluationId: string, input: UpsertEvaluationGradeInput, userId: string) {
    const teacherId = await this.teacherIdForUser(userId);
    const evaluation = await this.repository.findEvaluation(evaluationId);
    if (!evaluation) throw new AcademicGradingError('Evaluation not found', 404, 'EVALUATION_NOT_FOUND');
    if (evaluation.teacherId !== teacherId) {
      throw new AcademicGradingError('Evaluation is outside the teacher scope', 403, 'EVALUATION_SCOPE_FORBIDDEN');
    }
    const period = await this.repository.findGradingPeriod(evaluation.gradingPeriodId);
    if (!period) throw new AcademicGradingError('Grading period not found', 400, 'GRADING_PERIOD_NOT_FOUND');
    await this.assertSubjectOpen(evaluation.classId, evaluation.subjectId, evaluation.gradingPeriodId);
    if (!(await this.repository.studentBelongsToClass(input.studentId, evaluation.classId))) {
      throw new AcademicGradingError('Student is not enrolled in the evaluation class', 400, 'STUDENT_CLASS_MISMATCH');
    }

    const oldValue = await this.repository.findGrade(evaluationId, input.studentId);
    const grade = await this.repository.upsertGrade(evaluationId, input);
    const claimId = await this.repository.activeCorrectionClaimId(evaluation.classId, evaluation.subjectId, evaluation.gradingPeriodId);
    await this.repository.appendAudit({
      actorUserId: userId, classId: evaluation.classId, subjectId: evaluation.subjectId,
      gradingPeriodId: evaluation.gradingPeriodId, evaluationId, studentId: input.studentId,
      claimId,
      operation: input.score === null ? 'grade_deleted' : oldValue ? 'grade_updated' : 'grade_created',
      oldValue, newValue: grade ? { score: grade.score, maxScore: grade.maxScore, comment: grade.comment } : null,
    });
    const averages = await this.recalculateStudentPeriod(input.studentId, evaluation.gradingPeriodId, evaluation.subjectId);
    if (claimId) await this.repository.appendAudit({
      actorUserId: userId, classId: evaluation.classId, subjectId: evaluation.subjectId,
      gradingPeriodId: evaluation.gradingPeriodId, evaluationId, studentId: input.studentId,
      claimId, operation: 'averages_recalculated', oldValue: null, newValue: averages,
    });
    return { grade, averages };
  }

  async createSpontaneousGrade(input: SpontaneousGradeInput, userId: string) {
    return this.repository.transaction((repository) =>
      new AcademicGradingService(repository).createSpontaneousGradeInTransaction(input, userId));
  }

  private async createSpontaneousGradeInTransaction(input: SpontaneousGradeInput, userId: string) {
    const teacherId = await this.teacherIdForUser(userId);
    const slot = await this.repository.getLessonSlotScope(input.lessonSlotId);
    if (!slot || slot.teacherId !== teacherId || slot.classId !== input.classId) {
      throw new AcademicGradingError('Lesson slot is outside the teacher scope', 403, 'EVALUATION_SCOPE_FORBIDDEN');
    }
    if (
      dayOfWeekFromIsoDate(input.evaluationDate) !== slot.dayOfWeek ||
      !isWithinSpontaneousGradeWindow(input.evaluationDate, slot.startTime, slot.endTime)
    ) {
      throw new AcademicGradingError(
        'La note spontanée est disponible pendant le cours et pendant les 24 heures qui suivent',
        409,
        'SPONTANEOUS_GRADE_WINDOW_CLOSED'
      );
    }
    await this.assertEvaluationScope({
      lessonSlotId: input.lessonSlotId,
      subjectId: input.subjectId,
      classId: input.classId,
      gradingPeriodId: input.gradingPeriodId,
      type: 'spontaneous',
      coefficient: 1,
      label: 'Participation spontanée',
      evaluationDate: input.evaluationDate,
    }, teacherId);
    if (!(await this.repository.studentBelongsToClass(input.studentId, input.classId))) {
      throw new AcademicGradingError('Student is not enrolled in the lesson class', 400, 'STUDENT_CLASS_MISMATCH');
    }
    const evaluation = await this.repository.createSpontaneousEvaluation(input, teacherId);
    const claimId = await this.repository.activeCorrectionClaimId(input.classId, input.subjectId, input.gradingPeriodId);
    await this.repository.appendAudit({
      actorUserId: userId, classId: input.classId, subjectId: input.subjectId,
      gradingPeriodId: input.gradingPeriodId, evaluationId: evaluation.id, claimId,
      operation: 'evaluation_created', oldValue: null, newValue: evaluation,
    });
    const grade = await this.repository.upsertGrade(evaluation.id, {
      studentId: input.studentId,
      score: Math.abs(input.adjustment),
      maxScore: 20,
      comment: input.comment,
    });
    await this.repository.appendAudit({
      actorUserId: userId, classId: input.classId, subjectId: input.subjectId,
      gradingPeriodId: input.gradingPeriodId, evaluationId: evaluation.id, studentId: input.studentId, claimId,
      operation: 'grade_created', oldValue: null,
      newValue: { score: Math.abs(input.adjustment), maxScore: 20, comment: input.comment },
    });
    const averages = await this.recalculateStudentPeriod(input.studentId, input.gradingPeriodId);
    if (claimId) await this.repository.appendAudit({
      actorUserId: userId, classId: input.classId, subjectId: input.subjectId,
      gradingPeriodId: input.gradingPeriodId, evaluationId: evaluation.id, studentId: input.studentId,
      claimId, operation: 'averages_recalculated', oldValue: null, newValue: averages,
    });
    return { evaluation, grade: { ...grade!, score: input.adjustment }, averages };
  }

  /**
   * Cascade de calcul à DEUX niveaux de coefficient :
   * 1. Moyenne par matière = moyenne pondérée des notes par coefficient
   *    d'ÉVALUATION (score/max_score × coef évaluation).
   * 2. Moyenne générale = moyenne des moyennes de matières pondérée par le
   *    coefficient de MATIÈRE (défini au niveau, partagé par toutes les classes).
   * Chaque upsert de note déclenche un recalcul complet de l'élève/période.
   */
  private async recalculateStudentPeriod(studentId: string, gradingPeriodId: string, changedSubjectId?: string) {
    const gradeRows = await this.repository.listStudentPeriodGrades(studentId, gradingPeriodId);
    const groups = new Map<string, {
      subjectCoefficient: number;
      grades: Array<{ score: number; maxScore: number; coefficient: number }>;
      adjustments: number[];
    }>();
    for (const row of gradeRows) {
      const group = groups.get(row.subjectId) ?? { subjectCoefficient: row.subjectCoefficient, grades: [], adjustments: [] };
      if (row.evaluationType === 'spontaneous') {
        group.adjustments.push(row.adjustment);
      } else {
        group.grades.push({ score: row.score, maxScore: row.maxScore, coefficient: row.evaluationCoefficient });
      }
      groups.set(row.subjectId, group);
    }

    const subjects: Array<{ subjectId: string; average: number; coefficient: number }> = [];
    for (const [subjectId, group] of groups) {
      const baseAverage = calculateSubjectAverage(group.grades);
      if (baseAverage === null) continue;
      const average = Math.max(0, Math.min(20, baseAverage + group.adjustments.reduce((sum, adjustment) => sum + adjustment, 0)));
      await this.repository.upsertAverage(studentId, gradingPeriodId, subjectId, average);
      subjects.push({ subjectId, average, coefficient: group.subjectCoefficient });
    }
    if (changedSubjectId && !subjects.some((subject) => subject.subjectId === changedSubjectId)) {
      await this.repository.deleteAverage(studentId, gradingPeriodId, changedSubjectId);
    }
    const conduct = await this.repository.findConductForAverage(studentId, gradingPeriodId);
    const generalAverage = calculateGeneralAverage(conduct
      ? [...subjects, { average: conduct.note, coefficient: conduct.coefficient }]
      : subjects);
    if (generalAverage !== null) {
      await this.repository.upsertAverage(studentId, gradingPeriodId, null, generalAverage);
    } else {
      await this.repository.deleteAverage(studentId, gradingPeriodId, null);
    }
    return { subjects, generalAverage };
  }

  async updateCompletion(input: CompletionInput, userId: string) {
    return this.repository.transaction((repository) =>
      new AcademicGradingService(repository).updateCompletionInTransaction(input, userId));
  }

  private async updateCompletionInTransaction(input: CompletionInput, userId: string) {
    await this.repository.lockClassPeriod(input.classId, input.gradingPeriodId);
    const teacherId = await this.teacherIdForUser(userId);
    const subject = await this.repository.findSubject(input.subjectId);
    const period = await this.repository.findGradingPeriod(input.gradingPeriodId);
    const schoolClass = await this.repository.getClassScope(input.classId);
    if (!subject || !period || !schoolClass || subject.levelId !== schoolClass.levelId || period.schoolYearId !== schoolClass.schoolYearId) {
      throw new AcademicGradingError('Completion scope is invalid', 400, 'COMPLETION_SCOPE_MISMATCH');
    }
    if (schoolClass.schoolYearStatus === 'closed') {
      throw new AcademicGradingError('L’année scolaire est clôturée', 409, 'SCHOOL_YEAR_CLOSED');
    }
    if (schoolClass.isActive === false) {
      throw new AcademicGradingError('La classe est inactive', 409, 'CLASS_INACTIVE');
    }
    const classClosed = period.isCompleted || period.closedClassIds.includes(input.classId);
    if (classClosed) {
      throw new AcademicGradingError(
        'Cette période est finalisée : ses bulletins ont déjà été générés',
        409,
        'GRADING_PERIOD_COMPLETED'
      );
    }
    let assigned = await this.repository.hasTeacherSubjectAssignment(teacherId, input.subjectId, input.classId);
    if (!assigned) {
      const scheduledSubjects = await this.repository.listTeacherScheduleSubjects(teacherId, input.classId);
      assigned = scheduledSubjects.some(
        (scheduledSubject) => normalizeSubjectKey(scheduledSubject) === normalizeSubjectKey(subject.name)
      );
      if (assigned) {
        await this.repository.ensureTeacherSubjectAssignment(teacherId, input.subjectId, input.classId);
      }
    }
    if (!assigned) {
      throw new AcademicGradingError('Subject is outside the teacher scope', 403, 'COMPLETION_SCOPE_FORBIDDEN');
    }
    const current = await this.repository.getSubjectCompletion(
      input.classId,
      input.subjectId,
      input.gradingPeriodId
    );
    if (!current && input.status !== 'in_progress') {
      throw new AcademicGradingError(
        'Calculez d’abord les moyennes avant de les valider définitivement',
        409,
        'AVERAGE_CALCULATION_NOT_STARTED'
      );
    }
    if (current?.status === 'completed') {
      throw new AcademicGradingError(
        'Les moyennes de cette matière sont déjà validées',
        409,
        'SUBJECT_AVERAGES_VALIDATED'
      );
    }
    const evaluationCount = await this.repository.countScheduledEvaluations(
      teacherId, input.classId, input.subjectId, input.gradingPeriodId
    );
    const missingGrades = await this.repository.countMissingScheduledGrades(
      teacherId, input.classId, input.subjectId, input.gradingPeriodId
    );
    if (evaluationCount === 0) {
      throw new AcademicGradingError(
        'Créez au moins une évaluation avant de calculer ou de clôturer les moyennes',
        409,
        'EVALUATIONS_REQUIRED'
      );
    }
    if (missingGrades > 0) {
      throw new AcademicGradingError(
        `${missingGrades} note(s) d’évaluation restent à saisir avant le calcul ou la validation`,
        409,
        'GRADES_INCOMPLETE'
      );
    }
    const claimId = await this.repository.activeCorrectionClaimId(input.classId, input.subjectId, input.gradingPeriodId);
    const result = await this.repository.upsertCompletion(input);
    await this.repository.appendAudit({
      actorUserId: userId, classId: input.classId, subjectId: input.subjectId,
      gradingPeriodId: input.gradingPeriodId, claimId,
      operation: input.status === 'completed' ? 'averages_validated' : 'averages_recalculated',
      oldValue: current?.status ?? null, newValue: input.status,
    });
    if (claimId && input.status === 'completed') await this.repository.markClaimCorrected(claimId, userId);
    return result;
  }

  async getCompletion(classId: string, gradingPeriodId: string) {
    const [schoolClass, period] = await Promise.all([
      this.repository.getClassScope(classId),
      this.repository.findGradingPeriod(gradingPeriodId),
    ]);
    if (!schoolClass) throw new AcademicGradingError('Class not found', 404, 'CLASS_NOT_FOUND');
    if (!period) throw new AcademicGradingError('Grading period not found', 404, 'GRADING_PERIOD_NOT_FOUND');
    if (schoolClass.schoolYearId !== period.schoolYearId) {
      throw new AcademicGradingError('Class and grading period do not belong to the same school year', 400, 'COMPLETION_SCOPE_MISMATCH');
    }
    const subjects = await this.repository.getCompletion(classId, gradingPeriodId);
    const scheduleAssignments = schoolClass.levelId
      ? await this.repository.listScheduleAssignmentsForLevel(schoolClass.levelId)
      : [];
    return {
      classId,
      gradingPeriodId,
      subjects: subjects.map((subject) => {
        if (subject.teacher) return subject;
        const scheduled = scheduleAssignments.find(
          (candidate) =>
            candidate.classId === classId &&
            normalizeSubjectKey(candidate.subjectName) === normalizeSubjectKey(subject.subjectName)
        );
        return scheduled
          ? { ...subject, teacher: { id: scheduled.teacherId, name: scheduled.teacherName } }
          : subject;
      }),
    };
  }
}

export const buildAcademicGradingService = (
  db: ConstructorParameters<typeof AcademicGradingRepository>[0]
): AcademicGradingService => new AcademicGradingService(new AcademicGradingRepository(db));
