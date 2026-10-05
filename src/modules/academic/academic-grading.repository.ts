import { sql } from 'drizzle-orm';
import { confirmedSchoolStudent } from '../../shared/database/confirmed-school-membership.js';
import { teacherClassRelation } from '../../shared/database/teacher-class-relation.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { QueryResult, QueryResultRow } from 'pg';
import { getPeriodCapabilities } from './grading-period-capabilities.js';

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
  abbreviation: string | null;
  coefficient: string | number;
};

type PeriodRow = {
  id: string;
  school_year_id: string;
  type: 'trimester' | 'semester';
  order_index: number;
  label: string;
  start_date: string;
  review_start_date: string;
  end_date: string;
  is_completed?: boolean;
};

const mapSubject = (row: SubjectRow): SubjectItem => ({
  id: row.id,
  levelId: row.level_id,
  levelName: row.level_name,
  name: row.name,
  abbreviation: row.abbreviation,
  coefficient: decimal(row.coefficient),
});

const mapPeriod = (row: PeriodRow): GradingPeriodItem => ({
  id: row.id,
  schoolYearId: row.school_year_id,
  type: row.type,
  orderIndex: row.order_index,
  label: row.label,
  startDate: row.start_date,
  reviewStartDate: row.review_start_date,
  endDate: row.end_date,
  ...getPeriodCapabilities({ startDate: row.start_date, reviewStartDate: row.review_start_date, endDate: row.end_date }, null, row.is_completed ?? false),
  closedClassIds: [],
  hasGeneratedCards: false,
  isCompleted: row.is_completed ?? false,
  isCurrent: false,
});

export type EvaluationItem = {
  id: string;
  lessonSlotId: string | null;
  subjectId: string;
  classId: string;
  gradingPeriodId: string;
  teacherId: string;
  type: 'scheduled' | 'spontaneous';
  coefficient: number;
  label: string;
  evaluationDate: string | null;
};

type EvaluationRow = {
  id: string;
  lesson_slot_id: string | null;
  subject_id: string;
  class_id: string;
  grading_period_id: string;
  teacher_id: string;
  type: 'scheduled' | 'spontaneous';
  coefficient: string | number;
  label: string;
  evaluation_date: string | null;
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
  evaluationDate: row.evaluation_date,
});

export class AcademicGradingRepository {
  constructor(private readonly db: AcademicGradingQueryExecutor) {}

  async transaction<T>(work: (repository: AcademicGradingRepository) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => work(new AcademicGradingRepository(tx as AcademicGradingQueryExecutor)));
  }

  async lockClassPeriod(classId: string, gradingPeriodId: string): Promise<void> {
    await this.db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${classId}), hashtext(${gradingPeriodId}))`);
  }

  async listSubjects(levelId?: string): Promise<SubjectItem[]> {
    const result = await this.db.execute<SubjectRow>(sql`
      SELECT s.id, s.level_id, l.name AS level_name, s.name, s.abbreviation, s.coefficient
      FROM subjects s
      INNER JOIN levels l ON l.id = s.level_id
      WHERE (${levelId ?? null}::uuid IS NULL OR s.level_id = ${levelId ?? null}::uuid)
      ORDER BY l.order_index, s.name
    `);
    return rows(result).map(mapSubject);
  }

  async findSubject(id: string): Promise<SubjectItem | null> {
    const result = await this.db.execute<SubjectRow>(sql`
      SELECT s.id, s.level_id, l.name AS level_name, s.name, s.abbreviation, s.coefficient
      FROM subjects s INNER JOIN levels l ON l.id = s.level_id
      WHERE s.id = ${id}::uuid LIMIT 1
    `);
    const row = rows(result)[0];
    return row ? mapSubject(row) : null;
  }

  async createSubject(input: CreateSubjectInput & { name: string }): Promise<SubjectItem> {
    const result = await this.db.execute<SubjectRow>(sql`
      WITH inserted AS (
        INSERT INTO subjects (level_id, name, abbreviation, coefficient)
        VALUES (${input.levelId}::uuid, ${input.name}, ${input.abbreviation ?? null}, ${input.coefficient})
        RETURNING *
      )
      SELECT s.id, s.level_id, l.name AS level_name, s.name, s.abbreviation, s.coefficient
      FROM inserted s INNER JOIN levels l ON l.id = s.level_id
    `);
    const row = rows(result)[0];
    if (!row) throw new Error('Failed to create subject');
    return mapSubject(row);
  }

  async listSubjectConflicts(
    levelIds: string[],
    name: string
  ): Promise<Array<{ id: string; levelId: string; levelName: string }>> {
    if (levelIds.length === 0) return [];
    const result = await this.db.execute<{ id: string; level_id: string; level_name: string }>(sql`
      SELECT s.id::text, s.level_id::text, l.name AS level_name
      FROM subjects s
      INNER JOIN levels l ON l.id = s.level_id
      WHERE s.name = ${name}
        AND s.level_id = ANY(ARRAY[${sql.join(levelIds.map((id) => sql`${id}::uuid`), sql`, `)}]::uuid[])
      ORDER BY l.order_index, l.name
    `);
    return rows(result).map((row) => ({ id: row.id, levelId: row.level_id, levelName: row.level_name }));
  }

  async updateSubject(id: string, input: UpdateSubjectInput & { name?: string }): Promise<SubjectItem | null> {
    const result = await this.db.execute<SubjectRow>(sql`
      WITH updated AS (
        UPDATE subjects
        SET name = CASE WHEN ${input.name !== undefined} THEN ${input.name ?? null} ELSE name END,
            abbreviation = CASE WHEN ${input.abbreviation !== undefined} THEN ${input.abbreviation ?? null} ELSE abbreviation END,
            coefficient = CASE WHEN ${input.coefficient !== undefined} THEN ${input.coefficient ?? null} ELSE coefficient END,
            updated_at = now()
        WHERE id = ${id}::uuid
        RETURNING *
      )
      SELECT s.id, s.level_id, l.name AS level_name, s.name, s.abbreviation, s.coefficient
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
    const result = await this.db.execute<{ grading_period_id: string; class_id: string; class_closed: boolean; has_cards: boolean }>(sql`
      WITH class_progress AS (
        SELECT gp.id AS grading_period_id,
               c.id AS class_id,
               COUNT(s.id)::int AS student_count,
               COUNT(rc.id) FILTER (WHERE rc.status IN ('generated', 'published'))::int AS card_count
        FROM grading_periods gp
        INNER JOIN classes c ON c.school_year_id = gp.school_year_id
          AND (c.is_active = true
            OR EXISTS (SELECT 1 FROM report_cards existing WHERE existing.class_id = c.id AND existing.grading_period_id = gp.id)
            OR EXISTS (SELECT 1 FROM grading_period_class_closures closure WHERE closure.class_id = c.id AND closure.grading_period_id = gp.id))
        LEFT JOIN students s ON ${confirmedSchoolStudent(sql`s.id`, sql`c.school_year_id`, sql`c.id`)}
        LEFT JOIN report_cards rc ON rc.student_id = s.id AND rc.grading_period_id = gp.id
        WHERE gp.id = ANY(ARRAY[${sql.join(periodIds.map((id) => sql`${id}::uuid`), sql`, `)}]::uuid[])
        GROUP BY gp.id, c.id
      )
      SELECT grading_period_id::text, class_id::text,
             (EXISTS (
               SELECT 1 FROM grading_period_class_closures closure
               WHERE closure.grading_period_id = class_progress.grading_period_id
                 AND closure.class_id = class_progress.class_id
             ) OR (student_count > 0 AND card_count >= student_count)) AS class_closed,
             EXISTS (
               SELECT 1 FROM report_cards existing
               WHERE existing.grading_period_id = class_progress.grading_period_id
                 AND existing.class_id = class_progress.class_id
             ) AS has_cards
      FROM class_progress
    `);
    const closedByPeriod = new Map<string, string[]>();
    const cardsByPeriod = new Set<string>();
    const classCountByPeriod = new Map<string, number>();
    for (const row of rows(result)) {
      classCountByPeriod.set(row.grading_period_id, (classCountByPeriod.get(row.grading_period_id) ?? 0) + 1);
      if (row.class_closed) closedByPeriod.set(row.grading_period_id, [...(closedByPeriod.get(row.grading_period_id) ?? []), row.class_id]);
      if (row.has_cards) cardsByPeriod.add(row.grading_period_id);
    }
    const mapped = periods.map((period) => {
      const closedClassIds = closedByPeriod.get(period.id) ?? [];
      const isCompleted = closedClassIds.length > 0 && closedClassIds.length === classCountByPeriod.get(period.id);
      return { ...mapPeriod({ ...period, is_completed: isCompleted }), closedClassIds, hasGeneratedCards: cardsByPeriod.has(period.id) };
    });
    const byYear = new Map<string, GradingPeriodItem[]>();
    for (const period of mapped) {
      const items = byYear.get(period.schoolYearId) ?? [];
      items.push(period);
      byYear.set(period.schoolYearId, items);
    }
    for (const yearPeriods of byYear.values()) {
      const ordered = [...yearPeriods].sort((left, right) => left.orderIndex - right.orderIndex);
      ordered.forEach((period, index) => {
        const previous = ordered[index - 1];
        Object.assign(period, getPeriodCapabilities(period, previous?.reviewStartDate ?? null, period.isCompleted));
        period.isCurrent = period.notesEntryOpen || period.conductReviewOpen;
      });
    }
    return mapped;
  }

  async listGradingPeriods(schoolYearId?: string): Promise<GradingPeriodItem[]> {
    const result = await this.db.execute<PeriodRow>(sql`
      SELECT id, school_year_id, type, order_index, label, start_date::text, review_start_date::text, end_date::text
      FROM grading_periods
      WHERE (${schoolYearId ?? null}::uuid IS NULL OR school_year_id = ${schoolYearId ?? null}::uuid)
      ORDER BY school_year_id, order_index
    `);
    return this.withPeriodStates(rows(result));
  }

  async findGradingPeriod(id: string): Promise<GradingPeriodItem | null> {
    const result = await this.db.execute<PeriodRow>(sql`
      SELECT id, school_year_id, type, order_index, label, start_date::text, review_start_date::text, end_date::text
      FROM grading_periods WHERE id = ${id}::uuid LIMIT 1
    `);
    const row = rows(result)[0];
    if (!row) return null;
    const periodsInYear = await this.db.execute<PeriodRow>(sql`
      SELECT id, school_year_id, type, order_index, label, start_date::text, review_start_date::text, end_date::text
      FROM grading_periods
      WHERE school_year_id = ${row.school_year_id}::uuid
      ORDER BY order_index
    `);
    return (await this.withPeriodStates(rows(periodsInYear))).find((period) => period.id === id) ?? null;
  }

  async findNextGradingPeriod(id: string): Promise<GradingPeriodItem | null> {
    const result = await this.db.execute<PeriodRow>(sql`
      SELECT next_period.id,
             next_period.school_year_id,
             next_period.type,
             next_period.order_index,
             next_period.label,
             next_period.start_date::text,
             next_period.review_start_date::text,
             next_period.end_date::text
      FROM grading_periods current_period
      INNER JOIN grading_periods next_period
        ON next_period.school_year_id = current_period.school_year_id
       AND next_period.order_index > current_period.order_index
      WHERE current_period.id = ${id}::uuid
      ORDER BY next_period.order_index
      LIMIT 1
    `);
    const row = rows(result)[0];
    return row ? mapPeriod(row) : null;
  }

  async hasGeneratedCards(gradingPeriodId: string): Promise<boolean> {
    const result = await this.db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS(SELECT 1 FROM report_cards
        WHERE grading_period_id = ${gradingPeriodId}::uuid AND status IN ('generated', 'published')) AS exists
    `);
    return rows(result)[0]?.exists ?? false;
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
      INSERT INTO grading_periods (school_year_id, type, order_index, label, start_date, review_start_date, end_date)
      VALUES (${input.schoolYearId}::uuid, ${input.type}::grading_period_type, ${input.orderIndex}, ${input.label}, ${input.startDate}::date, ${input.reviewStartDate}::date, ${input.endDate}::date)
      RETURNING id, school_year_id, type, order_index, label, start_date::text, review_start_date::text, end_date::text
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
          review_start_date = CASE WHEN ${input.reviewStartDate !== undefined} THEN ${input.reviewStartDate ?? null}::date ELSE review_start_date END,
          end_date = CASE WHEN ${input.endDate !== undefined} THEN ${input.endDate ?? null}::date ELSE end_date END,
          updated_at = now()
      WHERE id = ${id}::uuid
      RETURNING id, school_year_id, type, order_index, label, start_date::text, review_start_date::text, end_date::text
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
    isHomeroomTeacher: boolean;
  }>> {
    const result = await this.db.execute<{
      id: string; name: string; level_id: string; level_name: string;
      school_year_id: string; school_year_label: string; homeroom_teacher_id: string | null;
    }>(sql`
      SELECT DISTINCT c.id::text, c.name, l.id::text AS level_id, l.name AS level_name,
             sy.id::text AS school_year_id, sy.label AS school_year_label,
             c.homeroom_teacher_id::text
      FROM classes c
      INNER JOIN levels l ON l.id = c.level_id
      INNER JOIN school_years sy ON sy.id = c.school_year_id
      WHERE c.is_active = true AND ${teacherClassRelation(sql`${teacherId}::uuid`, sql`c.id`)}
      ORDER BY sy.label DESC, l.name, c.name
    `);
    return rows(result).map((row) => ({
      id: row.id,
      name: row.name,
      levelId: row.level_id,
      levelName: row.level_name,
      schoolYearId: row.school_year_id,
      schoolYearLabel: row.school_year_label,
      isHomeroomTeacher: row.homeroom_teacher_id === teacherId,
    }));
  }

  async listTeacherGradingPeriods(teacherId: string): Promise<GradingPeriodItem[]> {
    const result = await this.db.execute<PeriodRow>(sql`
      SELECT DISTINCT gp.id, gp.school_year_id, gp.type, gp.order_index, gp.label,
             gp.start_date::text, gp.review_start_date::text, gp.end_date::text
      FROM grading_periods gp
      WHERE EXISTS (
        SELECT 1
        FROM classes c
        WHERE c.school_year_id = gp.school_year_id AND c.is_active = true
          AND ${teacherClassRelation(sql`${teacherId}::uuid`, sql`c.id`)}
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
    dayOfWeek: number;
    subjectName: string;
    startTime: string;
    endTime: string;
  } | null> {
    const result = await this.db.execute<{
      id: string; teacher_id: string; class_id: string; day_of_week: number; level_id: string | null;
      school_year_id: string | null; subject: string; start_time: string; end_time: string;
    }>(sql`
      SELECT s.id, s.teacher_id, s.class_id, s.day_of_week, c.level_id, c.school_year_id, s.subject,
             ts.start_time::text, ts.end_time::text
      FROM schedules s
      INNER JOIN classes c ON c.id = s.class_id
      INNER JOIN time_slots ts ON ts.id = s.time_slot_id
      WHERE s.id = ${id}::uuid LIMIT 1
    `);
    const row = rows(result)[0];
    return row ? {
      id: row.id, teacherId: row.teacher_id, classId: row.class_id,
      classLevelId: row.level_id, classSchoolYearId: row.school_year_id, dayOfWeek: row.day_of_week, subjectName: row.subject,
      startTime: row.start_time, endTime: row.end_time,
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

  async listTeacherAssignedSubjectsForClass(teacherId: string, classId: string): Promise<SubjectItem[]> {
    const result = await this.db.execute<SubjectRow>(sql`
      SELECT s.id, s.level_id, l.name AS level_name, s.name, s.abbreviation, s.coefficient
      FROM teacher_subject_assignments tsa
      INNER JOIN subjects s ON s.id = tsa.subject_id
      INNER JOIN levels l ON l.id = s.level_id
      WHERE tsa.teacher_id = ${teacherId}::uuid
        AND tsa.class_id = ${classId}::uuid
      ORDER BY s.name
    `);
    return rows(result).map(mapSubject);
  }

  async createEvaluation(input: CreateEvaluationInput, teacherId: string): Promise<EvaluationItem> {
    const result = await this.db.execute<EvaluationRow>(sql`
      INSERT INTO evaluations (lesson_slot_id, subject_id, class_id, grading_period_id, teacher_id, type, coefficient, label, evaluation_date)
      VALUES (${input.lessonSlotId ?? null}::uuid, ${input.subjectId}::uuid, ${input.classId}::uuid, ${input.gradingPeriodId}::uuid, ${teacherId}::uuid, ${input.type}::evaluation_type, ${input.coefficient}, ${input.label}, ${input.evaluationDate ?? null}::date)
      RETURNING id, lesson_slot_id, subject_id, class_id, grading_period_id, teacher_id, type, coefficient, label, evaluation_date::text
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
      evaluationDate: input.evaluationDate,
    }, teacherId);
  }

  async findEvaluation(id: string): Promise<EvaluationItem | null> {
    const result = await this.db.execute<EvaluationRow>(sql`
      SELECT id, lesson_slot_id, subject_id, class_id, grading_period_id, teacher_id, type, coefficient, label, evaluation_date::text
      FROM evaluations WHERE id = ${id}::uuid LIMIT 1
    `);
    const row = rows(result)[0];
    return row ? mapEvaluation(row) : null;
  }

  async studentBelongsToClass(studentId: string, classId: string): Promise<boolean> {
    const result = await this.db.execute<{ exists: boolean }>(sql`
      SELECT ${confirmedSchoolStudent(sql`${studentId}::uuid`, sql`c.school_year_id`, sql`c.id`)} AS exists
      FROM classes c WHERE c.id = ${classId}::uuid
    `);
    return rows(result)[0]?.exists ?? false;
  }

  async findGrade(evaluationId: string, studentId: string): Promise<{ score: number; maxScore: number; comment: string | null } | null> {
    const result = await this.db.execute<{ score: string; max_score: string; comment: string | null }>(sql`
      SELECT score::text, max_score::text, comment FROM evaluation_grades
      WHERE evaluation_id = ${evaluationId}::uuid AND student_id = ${studentId}::uuid FOR UPDATE
    `);
    const row = rows(result)[0];
    return row ? { score: Number(row.score), maxScore: Number(row.max_score), comment: row.comment } : null;
  }

  async activeCorrectionClaimId(classId: string, subjectId: string, gradingPeriodId: string): Promise<string | null> {
    const result = await this.db.execute<{ id: string }>(sql`
      SELECT id::text FROM report_card_claims
      WHERE class_id = ${classId}::uuid AND subject_id = ${subjectId}::uuid
        AND grading_period_id = ${gradingPeriodId}::uuid AND status = 'approved'
      LIMIT 1
    `);
    return rows(result)[0]?.id ?? null;
  }

  async listCorrectionStatuses(classId: string, gradingPeriodId: string): Promise<Array<{ subjectId: string; status: string }>> {
    const result = await this.db.execute<{ subject_id: string; status: string }>(sql`
      SELECT DISTINCT ON (subject_id) subject_id::text, status FROM report_card_claims
      WHERE class_id = ${classId}::uuid AND grading_period_id = ${gradingPeriodId}::uuid
        AND status IN ('open', 'pending_exceptional_authorization', 'approved', 'corrected', 'regenerated')
      ORDER BY subject_id, created_at DESC, id DESC
    `);
    return rows(result).map((row) => ({ subjectId: row.subject_id, status: row.status }));
  }

  async markClaimCorrected(claimId: string, userId: string): Promise<void> {
    await this.db.execute(sql`
      WITH changed AS (
        UPDATE report_card_claims SET status = 'corrected', revalidated_at = now()
        WHERE id = ${claimId}::uuid AND status = 'approved'
        RETURNING id, class_id, subject_id, grading_period_id
      )
      INSERT INTO academic_change_audit (actor_user_id, class_id, subject_id, grading_period_id,
        claim_id, operation, old_value, new_value)
      SELECT ${userId}::uuid, class_id, subject_id, grading_period_id, id,
        'claim_corrected', '"approved"'::jsonb, '"corrected"'::jsonb FROM changed
    `);
  }

  async appendAudit(input: {
    actorUserId: string; classId: string; subjectId: string; gradingPeriodId: string;
    evaluationId?: string; studentId?: string; claimId?: string | null;
    operation: string; oldValue: unknown; newValue: unknown;
  }): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO academic_change_audit (actor_user_id, class_id, subject_id, grading_period_id,
        evaluation_id, student_id, claim_id, operation, old_value, new_value)
      VALUES (${input.actorUserId}::uuid, ${input.classId}::uuid, ${input.subjectId}::uuid,
        ${input.gradingPeriodId}::uuid, ${input.evaluationId ?? null}::uuid,
        ${input.studentId ?? null}::uuid, ${input.claimId ?? null}::uuid, ${input.operation},
        ${JSON.stringify(input.oldValue)}::jsonb, ${JSON.stringify(input.newValue)}::jsonb)
    `);
  }

  async upsertGrade(evaluationId: string, input: UpsertEvaluationGradeInput) {
    if (input.score === null) {
      await this.db.execute(sql`DELETE FROM evaluation_grades WHERE evaluation_id = ${evaluationId}::uuid AND student_id = ${input.studentId}::uuid`);
      return null;
    }
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

  async deleteAverage(studentId: string, gradingPeriodId: string, subjectId: string | null): Promise<void> {
    await this.db.execute(sql`
      DELETE FROM student_period_averages WHERE student_id = ${studentId}::uuid
        AND grading_period_id = ${gradingPeriodId}::uuid
        AND subject_id IS NOT DISTINCT FROM ${subjectId}::uuid
    `);
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
      INNER JOIN classes c ON c.id = e.class_id
      INNER JOIN grading_periods gp ON gp.id = e.grading_period_id AND gp.school_year_id = c.school_year_id
      INNER JOIN subjects s ON s.id = e.subject_id
      WHERE eg.student_id = ${studentId}::uuid AND e.grading_period_id = ${gradingPeriodId}::uuid
        AND ${confirmedSchoolStudent(sql`eg.student_id`, sql`c.school_year_id`, sql`c.id`)}
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

  async findConductForAverage(studentId: string, gradingPeriodId: string): Promise<{ note: number; coefficient: number } | null> {
    const result = await this.db.execute<{ note: string; coefficient: string }>(sql`
      SELECT cg.note::text, sy.conduct_coefficient::text AS coefficient
      FROM conduct_grades cg
      INNER JOIN grading_periods gp ON gp.id = cg.grading_period_id
      INNER JOIN school_years sy ON sy.id = gp.school_year_id
      WHERE cg.student_id = ${studentId}::uuid AND cg.grading_period_id = ${gradingPeriodId}::uuid
      LIMIT 1
    `);
    const row = rows(result)[0];
    return row ? { note: Number(row.note), coefficient: Number(row.coefficient) } : null;
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
      INNER JOIN classes c ON c.id = e.class_id
      CROSS JOIN students s
      LEFT JOIN evaluation_grades eg
        ON eg.evaluation_id = e.id AND eg.student_id = s.id
      WHERE e.teacher_id = ${teacherId}::uuid
        AND e.class_id = ${classId}::uuid
        AND e.subject_id = ${subjectId}::uuid
        AND e.grading_period_id = ${gradingPeriodId}::uuid
        AND e.type = 'scheduled'
        AND ${confirmedSchoolStudent(sql`s.id`, sql`c.school_year_id`, sql`c.id`)}
        AND eg.id IS NULL
    `);
    return Number(rows(result)[0]?.missing_count ?? 0);
  }

  async countScheduledEvaluations(
    teacherId: string,
    classId: string,
    subjectId: string,
    gradingPeriodId: string
  ): Promise<number> {
    const result = await this.db.execute<{ evaluation_count: string }>(sql`
      SELECT COUNT(*)::text AS evaluation_count
      FROM evaluations
      WHERE teacher_id = ${teacherId}::uuid
        AND class_id = ${classId}::uuid
        AND subject_id = ${subjectId}::uuid
        AND grading_period_id = ${gradingPeriodId}::uuid
        AND type = 'scheduled'
    `);
    return Number(rows(result)[0]?.evaluation_count ?? 0);
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
    Array<{
      id: string;
      dayOfWeek: number;
      startTime: string;
      endTime: string;
      subjectName: string;
      roomName: string;
    }>
  > {
    const result = await this.db.execute<{
      id: string; day_of_week: number; start_time: string; end_time: string; subject: string; room_name: string;
    }>(sql`
      SELECT sch.id::text, sch.day_of_week, ts.start_time::text, ts.end_time::text, sch.subject,
             r.name AS room_name
      FROM schedules sch
      INNER JOIN time_slots ts ON ts.id = sch.time_slot_id
      INNER JOIN rooms r ON r.id = sch.room_id
      INNER JOIN schedule_periods sp ON sp.id = sch.schedule_period_id
      WHERE sch.teacher_id = ${teacherId}::uuid
        AND sch.class_id = ${classId}::uuid
        AND sch.is_active = true
        AND sp.is_active = true
        AND sp.valid_from <= CURRENT_DATE
        AND sp.valid_to >= CURRENT_DATE
        AND (sch.start_date IS NULL OR sch.start_date <= CURRENT_DATE)
        AND (sch.end_date IS NULL OR sch.end_date > CURRENT_DATE)
      ORDER BY sch.day_of_week, ts.start_time
    `);
    return rows(result).map((row) => ({
      id: row.id,
      dayOfWeek: row.day_of_week,
      startTime: row.start_time.slice(0, 5),
      endTime: row.end_time.slice(0, 5),
      subjectName: row.subject,
      roomName: row.room_name,
    }));
  }

  async findTeacherClassScope(teacherId: string, classId: string): Promise<{ levelId: string | null } | null> {
    const result = await this.db.execute<{ level_id: string | null }>(sql`
      SELECT c.level_id::text AS level_id
      FROM classes c
      WHERE c.id = ${classId}::uuid
        AND c.is_active = true
        AND ${teacherClassRelation(sql`${teacherId}::uuid`, sql`c.id`)}
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
    dayOfWeek: number | null; startTime: string; endTime: string; roomName: string;
    grades: Array<{ studentId: string; score: number; maxScore: number; comment: string | null }>;
  }>> {
    const evaluationRows = rows(await this.db.execute<{
      id: string; label: string; type: string; coefficient: string; evaluation_date: string | null;
      subject_id: string | null; subject_name: string | null;
      day_of_week: number | null; start_time: string | null; end_time: string | null; room_name: string | null;
    }>(sql`
      SELECT e.id::text, e.label, e.type::text, e.coefficient::text, e.evaluation_date::text,
             sub.id::text AS subject_id, sub.name AS subject_name,
             sch.day_of_week, ts.start_time::text, ts.end_time::text, r.name AS room_name
      FROM evaluations e
      LEFT JOIN subjects sub ON sub.id = e.subject_id
      LEFT JOIN schedules sch ON sch.id = e.lesson_slot_id
      LEFT JOIN time_slots ts ON ts.id = sch.time_slot_id
      LEFT JOIN rooms r ON r.id = sch.room_id
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
      dayOfWeek: row.day_of_week,
      startTime: row.start_time?.slice(0, 5) ?? '',
      endTime: row.end_time?.slice(0, 5) ?? '',
      roomName: row.room_name ?? '',
      evaluationDate: row.evaluation_date,
      grades: gradesByEvaluation.get(row.id) ?? [],
    }));
  }
}
