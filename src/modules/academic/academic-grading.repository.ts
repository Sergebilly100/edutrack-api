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
  SpontaneousGradeInput,
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
  is_completed?: boolean;
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
  isCompleted: row.is_completed ?? false,
  isCurrent: false,
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

  private async withPeriodStates(periods: PeriodRow[]): Promise<GradingPeriodItem[]> {
    if (periods.length === 0) return [];
    const periodIds = periods.map((period) => period.id);
    const result = await this.db.execute<{ grading_period_id: string; is_completed: boolean }>(sql`
      WITH class_progress AS (
        SELECT gp.id AS grading_period_id,
               c.id AS class_id,
               COUNT(s.id)::int AS student_count,
               COUNT(rc.id) FILTER (WHERE rc.status IN ('generated', 'published'))::int AS card_count
        FROM grading_periods gp
        INNER JOIN classes c ON c.school_year_id = gp.school_year_id AND c.is_active = true
        LEFT JOIN students s ON s.class_id = c.id AND s.is_active = true
        LEFT JOIN report_cards rc ON rc.student_id = s.id AND rc.grading_period_id = gp.id
        WHERE gp.id = ANY(ARRAY[${sql.join(periodIds.map((id) => sql`${id}::uuid`), sql`, `)}]::uuid[])
        GROUP BY gp.id, c.id
      )
      SELECT grading_period_id::text,
             COALESCE(BOOL_AND(student_count > 0 AND card_count >= student_count), false) AS is_completed
      FROM class_progress
      GROUP BY grading_period_id
    `);
    const completionById = new Map(rows(result).map((row) => [row.grading_period_id, row.is_completed]));
    const mapped = periods.map((period) => mapPeriod({ ...period, is_completed: completionById.get(period.id) ?? false }));
    const byYear = new Map<string, GradingPeriodItem[]>();
    for (const period of mapped) {
      const items = byYear.get(period.schoolYearId) ?? [];
      items.push(period);
      byYear.set(period.schoolYearId, items);
    }
    for (const yearPeriods of byYear.values()) {
      const current = [...yearPeriods].sort((left, right) => left.orderIndex - right.orderIndex).find((period) => !period.isCompleted);
      if (current) current.isCurrent = true;
    }
    return mapped;
  }

  async listGradingPeriods(schoolYearId?: string): Promise<GradingPeriodItem[]> {
    const result = await this.db.execute<PeriodRow>(sql`
      SELECT id, school_year_id, type, order_index, label, start_date::text, end_date::text
      FROM grading_periods
      WHERE (${schoolYearId ?? null}::uuid IS NULL OR school_year_id = ${schoolYearId ?? null}::uuid)
      ORDER BY school_year_id, order_index
    `);
    return this.withPeriodStates(rows(result));
  }

  async findGradingPeriod(id: string): Promise<GradingPeriodItem | null> {
    const result = await this.db.execute<PeriodRow>(sql`
      SELECT id, school_year_id, type, order_index, label, start_date::text, end_date::text
      FROM grading_periods WHERE id = ${id}::uuid LIMIT 1
    `);
    const row = rows(result)[0];
    if (!row) return null;
    const periodsInYear = await this.db.execute<PeriodRow>(sql`
      SELECT id, school_year_id, type, order_index, label, start_date::text, end_date::text
      FROM grading_periods
      WHERE school_year_id = ${row.school_year_id}::uuid
      ORDER BY order_index
    `);
    return (await this.withPeriodStates(rows(periodsInYear))).find((period) => period.id === id) ?? null;
  }

  async getSchoolYear(id: string): Promise<{ id: string; startDate: string; endDate: string; gradingPeriodType: 'trimester' | 'semester' } | null> {
    const result = await this.db.execute<{ id: string; start_date: string; end_date: string; grading_period_type: 'trimester' | 'semester' }>(sql`
      SELECT id, start_date::text, end_date::text, grading_period_type FROM school_years WHERE id = ${id}::uuid LIMIT 1
    `);
    const row = rows(result)[0];
    return row ? { id: row.id, startDate: row.start_date, endDate: row.end_date, gradingPeriodType: row.grading_period_type } : null;
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

  async listTeacherAcademicClasses(teacherId: string): Promise<Array<{
    id: string;
    name: string;
    levelId: string;
    levelName: string;
    schoolYearId: string;
    schoolYearLabel: string;
  }>> {
    const result = await this.db.execute<{
      id: string; name: string; level_id: string; level_name: string;
      school_year_id: string; school_year_label: string;
    }>(sql`
      SELECT DISTINCT c.id::text, c.name, l.id::text AS level_id, l.name AS level_name,
             sy.id::text AS school_year_id, sy.label AS school_year_label
      FROM schedules sch
      INNER JOIN classes c ON c.id = sch.class_id AND c.is_active = true
      INNER JOIN levels l ON l.id = c.level_id
      INNER JOIN school_years sy ON sy.id = c.school_year_id
      WHERE sch.teacher_id = ${teacherId}::uuid AND sch.is_active = true
      ORDER BY sy.label DESC, l.name, c.name
    `);
    return rows(result).map((row) => ({
      id: row.id,
      name: row.name,
      levelId: row.level_id,
      levelName: row.level_name,
      schoolYearId: row.school_year_id,
      schoolYearLabel: row.school_year_label,
    }));
  }

  async listTeacherGradingPeriods(teacherId: string): Promise<GradingPeriodItem[]> {
    const result = await this.db.execute<PeriodRow>(sql`
      SELECT DISTINCT gp.id, gp.school_year_id, gp.type, gp.order_index, gp.label,
             gp.start_date::text, gp.end_date::text
      FROM grading_periods gp
      WHERE EXISTS (
        SELECT 1
        FROM schedules sch
        INNER JOIN classes c ON c.id = sch.class_id
        WHERE sch.teacher_id = ${teacherId}::uuid
          AND sch.is_active = true
          AND c.school_year_id = gp.school_year_id
      )
      ORDER BY gp.start_date::text DESC, gp.order_index
    `);
    return this.withPeriodStates(rows(result));
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

  async createSpontaneousEvaluation(input: SpontaneousGradeInput, teacherId: string): Promise<EvaluationItem> {
    return this.createEvaluation({
      lessonSlotId: input.lessonSlotId,
      subjectId: input.subjectId,
      classId: input.classId,
      gradingPeriodId: input.gradingPeriodId,
      type: 'spontaneous',
      coefficient: 1,
      label: `Note spontanée ${input.adjustment > 0 ? '+' : ''}${input.adjustment}`,
    }, teacherId);
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
    evaluationType: 'scheduled' | 'spontaneous'; adjustment: number;
  }>> {
    const result = await this.db.execute<{
      subject_id: string; subject_coefficient: string | number; score: string | number;
      max_score: string | number; evaluation_coefficient: string | number; type: 'scheduled' | 'spontaneous'; label: string;
    }>(sql`
      SELECT e.subject_id, s.coefficient AS subject_coefficient, eg.score, eg.max_score,
             e.coefficient AS evaluation_coefficient, e.type, e.label
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
      evaluationType: row.type,
      adjustment: row.type === 'spontaneous' && row.label.startsWith('Note spontanée -')
        ? -decimal(row.score)
        : decimal(row.score),
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

  async getSubjectCompletion(classId: string, subjectId: string, gradingPeriodId: string): Promise<{
    status: 'in_progress' | 'completed';
  } | null> {
    const result = await this.db.execute<{ status: 'in_progress' | 'completed' }>(sql`
      SELECT status
      FROM class_subject_completion
      WHERE class_id = ${classId}::uuid
        AND subject_id = ${subjectId}::uuid
        AND grading_period_id = ${gradingPeriodId}::uuid
      LIMIT 1
    `);
    return rows(result)[0] ?? null;
  }

  async countMissingScheduledGrades(
    teacherId: string,
    classId: string,
    subjectId: string,
    gradingPeriodId: string
  ): Promise<number> {
    const result = await this.db.execute<{ missing_count: string }>(sql`
      SELECT COUNT(*)::text AS missing_count
      FROM evaluations e
      CROSS JOIN students s
      LEFT JOIN evaluation_grades eg
        ON eg.evaluation_id = e.id AND eg.student_id = s.id
      WHERE e.teacher_id = ${teacherId}::uuid
        AND e.class_id = ${classId}::uuid
        AND e.subject_id = ${subjectId}::uuid
        AND e.grading_period_id = ${gradingPeriodId}::uuid
        AND e.type = 'scheduled'
        AND s.class_id = ${classId}::uuid
        AND s.is_active = true
        AND eg.id IS NULL
    `);
    return Number(rows(result)[0]?.missing_count ?? 0);
  }

  async getCompletion(classId: string, gradingPeriodId: string) {
    const result = await this.db.execute<{
      subject_id: string; subject_name: string; subject_coefficient: string | number;
      teacher_id: string | null; teacher_name: string | null;
      status: 'in_progress' | 'completed'; completed_at: Date | string | null;
      calculation_started: boolean;
    }>(sql`
      SELECT s.id AS subject_id, s.name AS subject_name, s.coefficient AS subject_coefficient,
             tsa.teacher_id, u.name AS teacher_name,
             COALESCE(csc.status, 'in_progress'::class_subject_completion_status) AS status,
             csc.completed_at,
             csc.id IS NOT NULL AS calculation_started
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
      calculationStarted: row.calculation_started,
    }));
  }

  /** Créneaux de cours du prof pour une classe (base des évaluations rattachées). */
  async listTeacherLessonSlotsForClass(teacherId: string, classId: string): Promise<
    Array<{ id: string; dayOfWeek: number; startTime: string; endTime: string; subjectName: string }>
  > {
    const result = await this.db.execute<{
      id: string; day_of_week: number; start_time: string; end_time: string; subject: string;
    }>(sql`
      SELECT sch.id::text, sch.day_of_week, ts.start_time::text, ts.end_time::text, sch.subject
      FROM schedules sch
      INNER JOIN time_slots ts ON ts.id = sch.time_slot_id
      WHERE sch.teacher_id = ${teacherId}::uuid AND sch.class_id = ${classId}::uuid
      ORDER BY sch.day_of_week, ts.start_time
    `);
    return rows(result).map((row) => ({
      id: row.id,
      dayOfWeek: row.day_of_week,
      startTime: row.start_time.slice(0, 5),
      endTime: row.end_time.slice(0, 5),
      subjectName: row.subject,
    }));
  }

  async findTeacherClassScope(teacherId: string, classId: string): Promise<{ levelId: string | null } | null> {
    const result = await this.db.execute<{ level_id: string | null }>(sql`
      SELECT c.level_id::text AS level_id
      FROM classes c
      WHERE c.id = ${classId}::uuid
        AND EXISTS (
          SELECT 1 FROM schedules sch
          WHERE sch.teacher_id = ${teacherId}::uuid AND sch.class_id = c.id
        )
      LIMIT 1
    `);
    const row = rows(result)[0];
    return row ? { levelId: row.level_id } : null;
  }

  /** Évaluations du prof pour une classe/période, avec les notes saisies. */
  async listEvaluationsWithGrades(
    teacherId: string,
    classId: string,
    gradingPeriodId: string
  ): Promise<Array<{
    id: string; label: string; type: 'scheduled' | 'spontaneous'; coefficient: number;
    subjectId: string | null; subjectName: string | null;
    grades: Array<{ studentId: string; score: number; maxScore: number; comment: string | null }>;
  }>> {
    const evaluationRows = rows(await this.db.execute<{
      id: string; label: string; type: string; coefficient: string;
      subject_id: string | null; subject_name: string | null;
    }>(sql`
      SELECT e.id::text, e.label, e.type::text, e.coefficient::text,
             sub.id::text AS subject_id, sub.name AS subject_name
      FROM evaluations e
      LEFT JOIN subjects sub ON sub.id = e.subject_id
      WHERE e.teacher_id = ${teacherId}::uuid
        AND e.class_id = ${classId}::uuid
        AND e.grading_period_id = ${gradingPeriodId}::uuid
      ORDER BY e.created_at DESC
    `));

    if (evaluationRows.length === 0) return [];

    const gradeRows = rows(await this.db.execute<{
      evaluation_id: string; student_id: string; score: string; max_score: string; comment: string | null;
    }>(sql`
      SELECT eg.evaluation_id::text, eg.student_id::text, eg.score::text, eg.max_score::text, eg.comment
      FROM evaluation_grades eg
      INNER JOIN evaluations e ON e.id = eg.evaluation_id
      WHERE e.teacher_id = ${teacherId}::uuid
        AND e.class_id = ${classId}::uuid
        AND e.grading_period_id = ${gradingPeriodId}::uuid
    `));
    const gradesByEvaluation = new Map<string, Array<{ studentId: string; score: number; maxScore: number; comment: string | null }>>();
    for (const grade of gradeRows) {
      const list = gradesByEvaluation.get(grade.evaluation_id) ?? [];
      list.push({ studentId: grade.student_id, score: decimal(grade.score), maxScore: decimal(grade.max_score), comment: grade.comment });
      gradesByEvaluation.set(grade.evaluation_id, list);
    }

    return evaluationRows.map((row) => ({
      id: row.id,
      label: row.label,
      type: row.type as 'scheduled' | 'spontaneous',
      coefficient: decimal(row.coefficient),
      subjectId: row.subject_id,
      subjectName: row.subject_name,
      grades: gradesByEvaluation.get(row.id) ?? [],
    }));
  }
}
