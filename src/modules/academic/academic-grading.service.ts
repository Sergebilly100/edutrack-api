import { canonicalizeSubject, normalizeSubjectKey } from '../../shared/utils/subject-normalization.js';
import {
  calculateGeneralAverage,
  calculateSubjectAverage,
} from './academic-grading.calculations.js';
import { AcademicGradingRepository } from './academic-grading.repository.js';
import type {
  CompletionInput,
  CreateEvaluationInput,
  CreateGradingPeriodInput,
  CreateSubjectInput,
  UpdateGradingPeriodInput,
  UpdateSubjectInput,
  UpsertEvaluationGradeInput,
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
    const existingType = await this.repository.getPeriodTypeForYear(input.schoolYearId);
    if (existingType && existingType !== input.type) {
      throw new AcademicGradingError('A school year cannot mix trimesters and semesters', 409, 'GRADING_PERIOD_TYPE_CONFLICT');
    }
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
    const merged = {
      schoolYearId: current.schoolYearId,
      type: current.type,
      orderIndex: input.orderIndex ?? current.orderIndex,
      label: input.label ?? current.label,
      startDate: input.startDate ?? current.startDate,
      endDate: input.endDate ?? current.endDate,
    };
    if (merged.startDate > merged.endDate) {
      throw new AcademicGradingError('Period start date must be before or equal to end date', 400, 'INVALID_GRADING_PERIOD_DATES');
    }
    await this.assertPeriod(merged);
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

  async createEvaluation(input: CreateEvaluationInput, userId: string) {
    const teacherId = await this.teacherIdForUser(userId);
    const [slot, subject, period] = await Promise.all([
      this.repository.getLessonSlotScope(input.lessonSlotId),
      this.repository.findSubject(input.subjectId),
      this.repository.findGradingPeriod(input.gradingPeriodId),
    ]);
    if (!slot) throw new AcademicGradingError('Lesson slot not found', 400, 'LESSON_SLOT_NOT_FOUND');
    if (!subject) throw new AcademicGradingError('Subject not found', 400, 'SUBJECT_NOT_FOUND');
    if (!period) throw new AcademicGradingError('Grading period not found', 400, 'GRADING_PERIOD_NOT_FOUND');
    if (slot.teacherId !== teacherId || slot.classId !== input.classId) {
      throw new AcademicGradingError('Lesson slot is outside the teacher scope', 403, 'EVALUATION_SCOPE_FORBIDDEN');
    }
    if (slot.classLevelId !== subject.levelId || slot.classSchoolYearId !== period.schoolYearId) {
      throw new AcademicGradingError('Subject or period does not match the lesson class', 400, 'EVALUATION_SCOPE_MISMATCH');
    }
    if (normalizeSubjectKey(slot.subjectName) !== normalizeSubjectKey(subject.name)) {
      throw new AcademicGradingError('Subject does not match the lesson slot', 400, 'EVALUATION_SUBJECT_MISMATCH');
    }

    await this.repository.ensureTeacherSubjectAssignment(teacherId, subject.id, input.classId);
    return this.repository.createEvaluation(input, teacherId);
  }

  async upsertGrade(evaluationId: string, input: UpsertEvaluationGradeInput, userId: string) {
    const teacherId = await this.teacherIdForUser(userId);
    const evaluation = await this.repository.findEvaluation(evaluationId);
    if (!evaluation) throw new AcademicGradingError('Evaluation not found', 404, 'EVALUATION_NOT_FOUND');
    if (evaluation.teacherId !== teacherId) {
      throw new AcademicGradingError('Evaluation is outside the teacher scope', 403, 'EVALUATION_SCOPE_FORBIDDEN');
    }
    if (!(await this.repository.studentBelongsToClass(input.studentId, evaluation.classId))) {
      throw new AcademicGradingError('Student is not enrolled in the evaluation class', 400, 'STUDENT_CLASS_MISMATCH');
    }

    const grade = await this.repository.upsertGrade(evaluationId, input);
    const averages = await this.recalculateStudentPeriod(input.studentId, evaluation.gradingPeriodId);
    return { grade, averages };
  }

  private async recalculateStudentPeriod(studentId: string, gradingPeriodId: string) {
    const gradeRows = await this.repository.listStudentPeriodGrades(studentId, gradingPeriodId);
    const groups = new Map<string, { subjectCoefficient: number; grades: Array<{ score: number; maxScore: number; coefficient: number }> }>();
    for (const row of gradeRows) {
      const group = groups.get(row.subjectId) ?? { subjectCoefficient: row.subjectCoefficient, grades: [] };
      group.grades.push({ score: row.score, maxScore: row.maxScore, coefficient: row.evaluationCoefficient });
      groups.set(row.subjectId, group);
    }

    const subjects: Array<{ subjectId: string; average: number; coefficient: number }> = [];
    for (const [subjectId, group] of groups) {
      const average = calculateSubjectAverage(group.grades);
      if (average === null) continue;
      await this.repository.upsertAverage(studentId, gradingPeriodId, subjectId, average);
      subjects.push({ subjectId, average, coefficient: group.subjectCoefficient });
    }
    const generalAverage = calculateGeneralAverage(subjects);
    if (generalAverage !== null) {
      await this.repository.upsertAverage(studentId, gradingPeriodId, null, generalAverage);
    }
    return { subjects, generalAverage };
  }

  async updateCompletion(input: CompletionInput, userId: string) {
    const teacherId = await this.teacherIdForUser(userId);
    const [subject, period, schoolClass] = await Promise.all([
      this.repository.findSubject(input.subjectId),
      this.repository.findGradingPeriod(input.gradingPeriodId),
      this.repository.getClassScope(input.classId),
    ]);
    if (!subject || !period || !schoolClass || subject.levelId !== schoolClass.levelId || period.schoolYearId !== schoolClass.schoolYearId) {
      throw new AcademicGradingError('Completion scope is invalid', 400, 'COMPLETION_SCOPE_MISMATCH');
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
    return this.repository.upsertCompletion(input);
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
