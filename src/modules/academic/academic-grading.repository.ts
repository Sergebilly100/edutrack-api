import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { QueryResult, QueryResultRow } from 'pg';

import type {
  CompletionInput,
  CreateEvaluationInput,
  CreateGradingPeriodInput,
  CreateSubjectInput,
  GradingPeriodItem,
  SubjectItem,
  UpdateGradingPeriodInput,
  UpdateSubjectInput,
  UpsertEvaluationGradeInput,
} from './academic-grading.types.js';

export type AcademicGradingQueryExecutor = NodePgDatabase<Record<string, unknown>>;

const rows = <TRow extends QueryResultRow>(result: QueryResult<TRow>): TRow[] => result.rows;
const decimal = (value: string | number): number => Number(value);

type SubjectRow = {
  id: string;
  level_id: string;
  level_name: string;
  name: string;
  coefficient: string | number;
};

type PeriodRow = {
  id: string;
  school_year_id: string;
  type: 'trimester' | 'semester';
  order_index: number;
  label: string;
  start_date: string;
  end_date: string;
};

const mapSubject = (row: SubjectRow): SubjectItem => ({
  id: row.id,
  levelId: row.level_id,
  levelName: row.level_name,
  name: row.name,
  coefficient: decimal(row.coefficient),
});

const mapPeriod = (row: PeriodRow): GradingPeriodItem => ({
  id: row.id,
  schoolYearId: row.school_year_id,
  type: row.type,
  orderIndex: row.order_index,
  label: row.label,
  startDate: row.start_date,
  endDate: row.end_date,
});

export type EvaluationItem = {
  id: string;
  lessonSlotId: string;
  subjectId: string;
  classId: string;
  gradingPeriodId: string;
  teacherId: string;
  type: 'scheduled' | 'spontaneous';
  coefficient: number;
  label: string;
};

type EvaluationRow = {
  id: string;
  lesson_slot_id: string;
  subject_id: string;
  class_id: string;
  grading_period_id: string;
  teacher_id: string;
  type: 'scheduled' | 'spontaneous';
  coefficient: string | number;
  label: string;
};

const mapEvaluation = (row: EvaluationRow): EvaluationItem => ({
  id: row.id,
  lessonSlotId: row.lesson_slot_id,
  subjectId: row.subject_id,
  classId: row.class_id,
  gradingPeriodId: row.grading_period_id,
  teacherId: row.teacher_id,
  type: row.type,
  coefficient: decimal(row.coefficient),
  label: row.label,
});

export class AcademicGradingRepository {
  constructor(private readonly db: AcademicGradingQueryExecutor) {}

  async listSubjects(levelId?: string): Promise<SubjectItem[]> {
    const result = await this.db.execute<SubjectRow>(sql`
      SELECT s.id, s.level_id, l.name AS level_name, s.name, s.coefficient
      FROM subjects s
      INNER JOIN levels l ON l.id = s.level_id
      WHERE (${levelId ?? null}::uuid IS NULL OR s.level_id = ${levelId ?? null}::uuid)
      ORDER BY l.order_index, s.name
    `);
    return rows(result).map(mapSubject);
  }

  async findSubject(id: string): Promise<SubjectItem | null> {
    const result = await this.db.execute<SubjectRow>(sql`
      SELECT s.id, s.level_id, l.name AS level_name, s.name, s.coefficient
      FROM subjects s INNER JOIN levels l ON l.id = s.level_id
      WHERE s.id = ${id}::uuid LIMIT 1
    `);
    const row = rows(result)[0];
    return row ? mapSubject(row) : null;
  }

  async createSubject(input: CreateSubjectInput & { name: string }): Promise<SubjectItem> {
    const result = await this.db.execute<SubjectRow>(sql`
      WITH inserted AS (
        INSERT INTO subjects (level_id, name, coefficient)
        VALUES (${input.levelId}::uuid, ${input.name}, ${input.coefficient})
        RETURNING *
      )
      SELECT s.id, s.level_id, l.name AS level_name, s.name, s.coefficient
      FROM inserted s INNER JOIN levels l ON l.id = s.level_id
    `);
    const row = rows(result)[0];
    if (!row) throw new Error('Failed to create subject');
    return mapSubject(row);
  }

  async updateSubject(id: string, input: UpdateSubjectInput & { name?: string }): Promise<SubjectItem | null> {
    const result = await this.db.execute<SubjectRow>(sql`
      WITH updated AS (
        UPDATE subjects
        SET name = CASE WHEN ${input.name !== undefined} THEN ${input.name ?? null} ELSE name END,
            coefficient = CASE WHEN ${input.coefficient !== undefined} THEN ${input.coefficient ?? null} ELSE coefficient END,
            updated_at = now()
        WHERE id = ${id}::uuid
        RETURNING *
      )
      SELECT s.id, s.level_id, l.name AS level_name, s.name, s.coefficient
      FROM updated s INNER JOIN levels l ON l.id = s.level_id
    `);
    const row = rows(result)[0];
    return row ? mapSubject(row) : null;
  }

  async deleteSubject(id: string): Promise<boolean> {
    const result = await this.db.execute<{ id: string }>(sql`
      DELETE FROM subjects WHERE id = ${id}::uuid RETURNING id
    `);
    return rows(result).length > 0;
  }

  async listGradingPeriods(schoolYearId?: string): Promise<GradingPeriodItem[]> {
    const result = await this.db.execute<PeriodRow>(sql`
      SELECT id, school_year_id, type, order_index, label, start_date::text, end_date::text
      FROM grading_periods
      WHERE (${schoolYearId ?? null}::uuid IS NULL OR school_year_id = ${schoolYearId ?? null}::uuid)
      ORDER BY start_date DESC, order_index
    `);
    return rows(result).map(mapPeriod);
  }

  async findGradingPeriod(id: string): Promise<GradingPeriodItem | null> {
    const result = await this.db.execute<PeriodRow>(sql`
      SELECT id, school_year_id, type, order_index, label, start_date::text, end_date::text
      FROM grading_periods WHERE id = ${id}::uuid LIMIT 1
    `);
    const row = rows(result)[0];
    return row ? mapPeriod(row) : null;
  }

  async getSchoolYear(id: string): Promise<{ id: string; startDate: string; endDate: string } | null> {
    const result = await this.db.execute<{ id: string; start_date: string; end_date: string }>(sql`
      SELECT id, start_date::text, end_date::text FROM school_years WHERE id = ${id}::uuid LIMIT 1
    `);
    const row = rows(result)[0];
    return row ? { id: row.id, startDate: row.start_date, endDate: row.end_date } : null;
  }

  async getPeriodTypeForYear(schoolYearId: string, excludedId?: string): Promise<'trimester' | 'semester' | null> {
    const result = await this.db.execute<{ type: 'trimester' | 'semester' }>(sql`
      SELECT type FROM grading_periods
      WHERE school_year_id = ${schoolYearId}::uuid
        AND (${excludedId ?? null}::uuid IS NULL OR id <> ${excludedId ?? null}::uuid)
      LIMIT 1
    `);
    return rows(result)[0]?.type ?? null;
  }

  async createGradingPeriod(input: CreateGradingPeriodInput): Promise<GradingPeriodItem> {
    const result = await this.db.execute<PeriodRow>(sql`
      INSERT INTO grading_periods (school_year_id, type, order_index, label, start_date, end_date)
      VALUES (${input.schoolYearId}::uuid, ${input.type}::grading_period_type, ${input.orderIndex}, ${input.label}, ${input.startDate}::date, ${input.endDate}::date)
      RETURNING id, school_year_id, type, order_index, label, start_date::text, end_date::text
    `);
    const row = rows(result)[0];
    if (!row) throw new Error('Failed to create grading period');
    return mapPeriod(row);
  }

  async updateGradingPeriod(id: string, input: UpdateGradingPeriodInput): Promise<GradingPeriodItem | null> {
    const result = await this.db.execute<PeriodRow>(sql`
      UPDATE grading_periods
      SET order_index = CASE WHEN ${input.orderIndex !== undefined} THEN ${input.orderIndex ?? null} ELSE order_index END,
          label = CASE WHEN ${input.label !== undefined} THEN ${input.label ?? null} ELSE label END,
          start_date = CASE WHEN ${input.startDate !== undefined} THEN ${input.startDate ?? null}::date ELSE start_date END,
          end_date = CASE WHEN ${input.endDate !== undefined} THEN ${input.endDate ?? null}::date ELSE end_date END,
          updated_at = now()
      WHERE id = ${id}::uuid
      RETURNING id, school_year_id, type, order_index, label, start_date::text, end_date::text
    `);
    const row = rows(result)[0];
    return row ? mapPeriod(row) : null;
  }

  async deleteGradingPeriod(id: string): Promise<boolean> {
    const result = await this.db.execute<{ id: string }>(sql`
      DELETE FROM grading_periods WHERE id = ${id}::uuid RETURNING id
    `);
    return rows(result).length > 0;
  }

  async findTeacherByUserId(userId: string): Promise<string | null> {
    const result = await this.db.execute<{ id: string }>(sql`
      SELECT id FROM teachers WHERE user_id = ${userId}::uuid LIMIT 1
    `);
    return rows(result)[0]?.id ?? null;
  }

  async getLessonSlotScope(id: string): Promise<{
    id: string;
    teacherId: string;
    classId: string;
    classLevelId: string | null;
    classSchoolYearId: string | null;
    subjectName: string;
  } | null> {
    const result = await this.db.execute<{
      id: string; teacher_id: string; class_id: string; level_id: string | null;
      school_year_id: string | null; subject: string;
    }>(sql`
      SELECT s.id, s.teacher_id, s.class_id, c.level_id, c.school_year_id, s.subject
      FROM schedules s INNER JOIN classes c ON c.id = s.class_id
      WHERE s.id = ${id}::uuid LIMIT 1
    `);
    const row = rows(result)[0];
    return row ? {
      id: row.id, teacherId: row.teacher_id, classId: row.class_id,
      classLevelId: row.level_id, classSchoolYearId: row.school_year_id, subjectName: row.subject,
    } : null;
  }

  async getClassScope(id: string): Promise<{ levelId: string | null; schoolYearId: string | null } | null> {
    const result = await this.db.execute<{ level_id: string | null; school_year_id: string | null }>(sql`
      SELECT level_id, school_year_id FROM classes WHERE id = ${id}::uuid LIMIT 1
    `);
    const row = rows(result)[0];
    return row ? { levelId: row.level_id, schoolYearId: row.school_year_id } : null;
  }

  async ensureTeacherSubjectAssignment(teacherId: string, subjectId: string, classId: string): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO teacher_subject_assignments (teacher_id, subject_id, class_id)
      VALUES (${teacherId}::uuid, ${subjectId}::uuid, ${classId}::uuid)
      ON CONFLICT (teacher_id, subject_id, class_id) DO NOTHING
    `);
  }

  async listScheduleAssignmentsForLevel(levelId: string): Promise<Array<{
    teacherId: string;
    teacherName: string;
    classId: string;
    subjectName: string;
  }>> {
    const result = await this.db.execute<{
      teacher_id: string;
      teacher_name: string;
      class_id: string;
      subject: string;
    }>(sql`
      SELECT DISTINCT s.teacher_id, u.name AS teacher_name, s.class_id, s.subject
      FROM schedules s
      INNER JOIN classes c ON c.id = s.class_id
      INNER JOIN teachers t ON t.id = s.teacher_id
      INNER JOIN users u ON u.id = t.user_id
      WHERE c.level_id = ${levelId}::uuid
    `);
    return rows(result).map((row) => ({
      teacherId: row.teacher_id,
      teacherName: row.teacher_name,
      classId: row.class_id,
      subjectName: row.subject,
    }));
  }

  async hasTeacherSubjectAssignment(teacherId: string, subjectId: string, classId: string): Promise<boolean> {
    const result = await this.db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM teacher_subject_assignments
        WHERE teacher_id = ${teacherId}::uuid AND subject_id = ${subjectId}::uuid AND class_id = ${classId}::uuid
      ) AS exists
    `);
    return rows(result)[0]?.exists ?? false;
  }

  async listTeacherScheduleSubjects(teacherId: string, classId: string): Promise<string[]> {
    const result = await this.db.execute<{ subject: string }>(sql`
      SELECT DISTINCT subject FROM schedules
      WHERE teacher_id = ${teacherId}::uuid AND class_id = ${classId}::uuid
    `);
    return rows(result).map((row) => row.subject);
  }

  async createEvaluation(input: CreateEvaluationInput, teacherId: string): Promise<EvaluationItem> {
    const result = await this.db.execute<EvaluationRow>(sql`
      INSERT INTO evaluations (lesson_slot_id, subject_id, class_id, grading_period_id, teacher_id, type, coefficient, label)
      VALUES (${input.lessonSlotId}::uuid, ${input.subjectId}::uuid, ${input.classId}::uuid, ${input.gradingPeriodId}::uuid, ${teacherId}::uuid, ${input.type}::evaluation_type, ${input.coefficient}, ${input.label})
      RETURNING id, lesson_slot_id, subject_id, class_id, grading_period_id, teacher_id, type, coefficient, label
    `);
    const row = rows(result)[0];
    if (!row) throw new Error('Failed to create evaluation');
    return mapEvaluation(row);
  }

  async findEvaluation(id: string): Promise<EvaluationItem | null> {
    const result = await this.db.execute<EvaluationRow>(sql`
      SELECT id, lesson_slot_id, subject_id, class_id, grading_period_id, teacher_id, type, coefficient, label
      FROM evaluations WHERE id = ${id}::uuid LIMIT 1
    `);
    const row = rows(result)[0];
    return row ? mapEvaluation(row) : null;
  }

  async studentBelongsToClass(studentId: string, classId: string): Promise<boolean> {
    const result = await this.db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM students WHERE id = ${studentId}::uuid AND class_id = ${classId}::uuid AND is_active = true) AS exists
    `);
    return rows(result)[0]?.exists ?? false;
  }

  async upsertGrade(evaluationId: string, input: UpsertEvaluationGradeInput) {
    const result = await this.db.execute<{
      id: string; evaluation_id: string; student_id: string; score: string | number;
      max_score: string | number; comment: string | null;
    }>(sql`
      INSERT INTO evaluation_grades (evaluation_id, student_id, score, max_score, comment)
      VALUES (${evaluationId}::uuid, ${input.studentId}::uuid, ${input.score}, ${input.maxScore}, ${input.comment ?? null})
      ON CONFLICT (evaluation_id, student_id) DO UPDATE
      SET score = EXCLUDED.score, max_score = EXCLUDED.max_score, comment = EXCLUDED.comment, updated_at = now()
      RETURNING id, evaluation_id, student_id, score, max_score, comment
    `);
    const row = rows(result)[0];
    if (!row) throw new Error('Failed to save grade');
    return { id: row.id, evaluationId: row.evaluation_id, studentId: row.student_id, score: decimal(row.score), maxScore: decimal(row.max_score), comment: row.comment };
  }

  async listStudentPeriodGrades(studentId: string, gradingPeriodId: string): Promise<Array<{
    subjectId: string; subjectCoefficient: number; score: number; maxScore: number; evaluationCoefficient: number;
  }>> {
    const result = await this.db.execute<{
      subject_id: string; subject_coefficient: string | number; score: string | number;
      max_score: string | number; evaluation_coefficient: string | number;
    }>(sql`
      SELECT e.subject_id, s.coefficient AS subject_coefficient, eg.score, eg.max_score,
             e.coefficient AS evaluation_coefficient
      FROM evaluation_grades eg
      INNER JOIN evaluations e ON e.id = eg.evaluation_id
      INNER JOIN subjects s ON s.id = e.subject_id
      WHERE eg.student_id = ${studentId}::uuid AND e.grading_period_id = ${gradingPeriodId}::uuid
      ORDER BY e.subject_id, e.created_at
    `);
    return rows(result).map((row) => ({
      subjectId: row.subject_id,
      subjectCoefficient: decimal(row.subject_coefficient),
      score: decimal(row.score),
      maxScore: decimal(row.max_score),
      evaluationCoefficient: decimal(row.evaluation_coefficient),
    }));
  }

  async upsertAverage(studentId: string, gradingPeriodId: string, subjectId: string | null, average: number): Promise<void> {
    if (subjectId) {
      await this.db.execute(sql`
        INSERT INTO student_period_averages (student_id, subject_id, grading_period_id, average, computed_at)
        VALUES (${studentId}::uuid, ${subjectId}::uuid, ${gradingPeriodId}::uuid, ${average}, now())
        ON CONFLICT (student_id, subject_id, grading_period_id) WHERE subject_id IS NOT NULL
        DO UPDATE SET average = EXCLUDED.average, rank = NULL, computed_at = now()
      `);
      return;
    }

    await this.db.execute(sql`
      INSERT INTO student_period_averages (student_id, subject_id, grading_period_id, average, computed_at)
      VALUES (${studentId}::uuid, NULL, ${gradingPeriodId}::uuid, ${average}, now())
      ON CONFLICT (student_id, grading_period_id) WHERE subject_id IS NULL
      DO UPDATE SET average = EXCLUDED.average, rank = NULL, computed_at = now()
    `);
  }

  async upsertCompletion(input: CompletionInput) {
    const result = await this.db.execute<{
      id: string; class_id: string; subject_id: string; grading_period_id: string;
      status: 'in_progress' | 'completed'; completed_at: Date | string | null;
    }>(sql`
      INSERT INTO class_subject_completion (class_id, subject_id, grading_period_id, status, completed_at)
      VALUES (${input.classId}::uuid, ${input.subjectId}::uuid, ${input.gradingPeriodId}::uuid,
              ${input.status}::class_subject_completion_status,
              CASE WHEN ${input.status} = 'completed' THEN now() ELSE NULL END)
      ON CONFLICT (class_id, subject_id, grading_period_id) DO UPDATE
      SET status = EXCLUDED.status,
          completed_at = CASE WHEN EXCLUDED.status = 'completed' THEN COALESCE(class_subject_completion.completed_at, now()) ELSE NULL END,
          updated_at = now()
      RETURNING id, class_id, subject_id, grading_period_id, status, completed_at
    `);
    const row = rows(result)[0];
    if (!row) throw new Error('Failed to save completion status');
    return { ...row, completed_at: row.completed_at ? new Date(row.completed_at).toISOString() : null };
  }

  async getCompletion(classId: string, gradingPeriodId: string) {
    const result = await this.db.execute<{
      subject_id: string; subject_name: string; subject_coefficient: string | number;
      teacher_id: string | null; teacher_name: string | null;
      status: 'in_progress' | 'completed'; completed_at: Date | string | null;
    }>(sql`
      SELECT s.id AS subject_id, s.name AS subject_name, s.coefficient AS subject_coefficient,
             tsa.teacher_id, u.name AS teacher_name,
             COALESCE(csc.status, 'in_progress'::class_subject_completion_status) AS status,
             csc.completed_at
      FROM classes c
      INNER JOIN subjects s ON s.level_id = c.level_id
      LEFT JOIN teacher_subject_assignments tsa ON tsa.class_id = c.id AND tsa.subject_id = s.id
      LEFT JOIN teachers t ON t.id = tsa.teacher_id
      LEFT JOIN users u ON u.id = t.user_id
      LEFT JOIN class_subject_completion csc
        ON csc.class_id = c.id AND csc.subject_id = s.id AND csc.grading_period_id = ${gradingPeriodId}::uuid
      WHERE c.id = ${classId}::uuid
      ORDER BY s.name, u.name
    `);
    return rows(result).map((row) => ({
      subjectId: row.subject_id,
      subjectName: row.subject_name,
      subjectCoefficient: decimal(row.subject_coefficient),
      teacher: row.teacher_id ? { id: row.teacher_id, name: row.teacher_name } : null,
      status: row.status,
      completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    }));
  }
}
