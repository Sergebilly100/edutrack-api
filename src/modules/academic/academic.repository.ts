import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { QueryResult, QueryResultRow } from 'pg';

import type {
  ClassItem,
  ClassRow,
  CreateClassInput,
  CreateLevelInput,
  CreateSchoolYearInput,
  LevelItem,
  LevelRow,
  SchoolYearItem,
  SchoolYearRow,
  UpdateClassInput,
  UpdateLevelInput,
  UpdateSchoolYearInput,
} from './academic.types.js';

export type AcademicQueryExecutor = NodePgDatabase<Record<string, unknown>>;

const getRows = <TRow extends QueryResultRow>(result: QueryResult<TRow>): TRow[] => result.rows;

const toIsoDateTime = (value: Date | string): string => {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid timestamp value: ${String(value)}`);
  }
  return parsed.toISOString();
};

export const mapSchoolYear = (row: SchoolYearRow): SchoolYearItem => ({
  id: row.id,
  label: row.label,
  startDate: row.start_date,
  endDate: row.end_date,
  endOfYearReviewStartDate: row.end_of_year_review_start_date,
  gradingPeriodType: row.grading_period_type,
  status: row.status,
  createdAt: toIsoDateTime(row.created_at),
  updatedAt: toIsoDateTime(row.updated_at),
});

export const mapLevel = (row: LevelRow): LevelItem => ({
  id: row.id,
  name: row.name,
  orderIndex: row.order_index,
  isExamClass: row.is_exam_class,
  createdAt: toIsoDateTime(row.created_at),
  updatedAt: toIsoDateTime(row.updated_at),
});

export const mapClass = (row: ClassRow): ClassItem => ({
  id: row.id,
  name: row.name,
  studentCount: row.student_count,
  isActive: row.is_active,
  level: {
    id: row.level_id,
    name: row.level_name,
    orderIndex: row.level_order_index,
  },
  schoolYear: {
    id: row.school_year_id,
    label: row.school_year_label,
  },
  homeroomTeacher:
    row.homeroom_teacher_id && row.homeroom_teacher_name
      ? { id: row.homeroom_teacher_id, name: row.homeroom_teacher_name }
      : null,
  createdAt: toIsoDateTime(row.created_at),
  updatedAt: toIsoDateTime(row.updated_at),
});

export class AcademicRepository {
  constructor(private readonly db: AcademicQueryExecutor) {}

  async listSchoolYears(): Promise<SchoolYearItem[]> {
    const result = await this.db.execute<SchoolYearRow>(sql`
      SELECT id, label, start_date::text, end_date::text, end_of_year_review_start_date::text, grading_period_type, status, created_at, updated_at
      FROM school_years
      ORDER BY start_date DESC, created_at DESC
    `);
    return getRows(result).map(mapSchoolYear);
  }

  async findSchoolYearById(id: string): Promise<SchoolYearItem | null> {
    const result = await this.db.execute<SchoolYearRow>(sql`
      SELECT id, label, start_date::text, end_date::text, end_of_year_review_start_date::text, grading_period_type, status, created_at, updated_at
      FROM school_years
      WHERE id = ${id}::uuid
      LIMIT 1
    `);
    const row = getRows(result)[0];
    return row ? mapSchoolYear(row) : null;
  }

  async getActiveSchoolYear(): Promise<SchoolYearItem | null> {
    const result = await this.db.execute<SchoolYearRow>(sql`
      SELECT id, label, start_date::text, end_date::text, end_of_year_review_start_date::text, grading_period_type, status, created_at, updated_at
      FROM school_years
      WHERE status = 'active'
      LIMIT 1
    `);
    const row = getRows(result)[0];
    return row ? mapSchoolYear(row) : null;
  }

  async createSchoolYear(input: CreateSchoolYearInput): Promise<SchoolYearItem> {
    const result = await this.db.execute<SchoolYearRow>(sql`
      INSERT INTO school_years (label, start_date, end_date, end_of_year_review_start_date, status)
      VALUES (${input.label}, ${input.startDate}::date, ${input.endDate}::date, ${input.endOfYearReviewStartDate ?? null}::date, ${input.status}::school_year_status)
      RETURNING id, label, start_date::text, end_date::text, end_of_year_review_start_date::text, grading_period_type, status, created_at, updated_at
    `);
    const row = getRows(result)[0];
    if (!row) {
      throw new Error('Failed to create school year');
    }
    return mapSchoolYear(row);
  }

  async updateSchoolYear(
    id: string,
    input: UpdateSchoolYearInput
  ): Promise<SchoolYearItem | null> {
    const result = await this.db.execute<SchoolYearRow>(sql`
      UPDATE school_years
      SET
        end_of_year_review_start_date = ${input.endOfYearReviewStartDate}::date,
        updated_at = now()
      WHERE id = ${id}::uuid
      RETURNING id, label, start_date::text, end_date::text, end_of_year_review_start_date::text, grading_period_type, status, created_at, updated_at
    `);
    const row = getRows(result)[0];
    return row ? mapSchoolYear(row) : null;
  }

  async deleteSchoolYear(id: string): Promise<SchoolYearItem | null> {
    const result = await this.db.execute<SchoolYearRow>(sql`
      DELETE FROM school_years
      WHERE id = ${id}::uuid
        AND status <> 'active'
      RETURNING id, label, start_date::text, end_date::text, end_of_year_review_start_date::text, grading_period_type, status, created_at, updated_at
    `);
    const row = getRows(result)[0];
    return row ? mapSchoolYear(row) : null;
  }

  async listLevels(): Promise<LevelItem[]> {
    const result = await this.db.execute<LevelRow>(sql`
      SELECT id, name, order_index, is_exam_class, created_at, updated_at
      FROM levels
      ORDER BY order_index ASC, name ASC
    `);
    return getRows(result).map(mapLevel);
  }

  async findLevelById(id: string): Promise<LevelItem | null> {
    const result = await this.db.execute<LevelRow>(sql`
      SELECT id, name, order_index, is_exam_class, created_at, updated_at
      FROM levels
      WHERE id = ${id}::uuid
      LIMIT 1
    `);
    const row = getRows(result)[0];
    return row ? mapLevel(row) : null;
  }

  async createLevel(input: CreateLevelInput): Promise<LevelItem> {
    const result = await this.db.execute<LevelRow>(sql`
      INSERT INTO levels (name, order_index, is_exam_class)
      VALUES (${input.name}, ${input.orderIndex}, ${input.isExamClass})
      RETURNING id, name, order_index, is_exam_class, created_at, updated_at
    `);
    const row = getRows(result)[0];
    if (!row) {
      throw new Error('Failed to create level');
    }
    return mapLevel(row);
  }

  async updateLevel(id: string, input: UpdateLevelInput): Promise<LevelItem | null> {
    const result = await this.db.execute<LevelRow>(sql`
      UPDATE levels
      SET
        name = CASE WHEN ${input.name !== undefined} THEN ${input.name ?? null} ELSE name END,
        order_index = CASE WHEN ${input.orderIndex !== undefined} THEN ${input.orderIndex ?? null}::integer ELSE order_index END,
        is_exam_class = CASE WHEN ${input.isExamClass !== undefined} THEN ${input.isExamClass ?? null}::boolean ELSE is_exam_class END,
        updated_at = now()
      WHERE id = ${id}::uuid
      RETURNING id, name, order_index, is_exam_class, created_at, updated_at
    `);
    const row = getRows(result)[0];
    return row ? mapLevel(row) : null;
  }

  async deleteLevel(id: string): Promise<LevelItem | null> {
    const result = await this.db.execute<LevelRow>(sql`
      DELETE FROM levels
      WHERE id = ${id}::uuid
      RETURNING id, name, order_index, is_exam_class, created_at, updated_at
    `);
    const row = getRows(result)[0];
    return row ? mapLevel(row) : null;
  }

  async teacherExists(id: string): Promise<boolean> {
    const result = await this.db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
        FROM teachers
        WHERE id = ${id}::uuid
      ) AS exists
    `);
    return getRows(result)[0]?.exists ?? false;
  }

  async adoptLegacyClassesForSchoolYear(schoolYearId: string): Promise<void> {
    await this.db.transaction(async (transaction) => {
      await transaction.execute(sql`
        WITH legacy_level_names AS (
          SELECT DISTINCT
            COALESCE(NULLIF(BTRIM(c.level), ''), NULLIF(BTRIM(c.name), '')) AS name
          FROM classes c
          WHERE c.is_active = true
            AND c.school_year_id IS NULL
            AND c.level_id IS NULL
        ),
        missing_level_names AS (
          SELECT legacy.name
          FROM legacy_level_names legacy
          WHERE legacy.name IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM levels existing
              WHERE LOWER(existing.name) = LOWER(legacy.name)
            )
        ),
        ordered_level_names AS (
          SELECT
            name,
            COALESCE((SELECT MAX(order_index) FROM levels), -1)
              + ROW_NUMBER() OVER (ORDER BY name) AS order_index
          FROM missing_level_names
        )
        INSERT INTO levels (name, order_index, is_exam_class)
        SELECT name, order_index::integer, false
        FROM ordered_level_names
        ON CONFLICT (name) DO NOTHING
      `);

      await transaction.execute(sql`
        UPDATE classes legacy
        SET
          level_id = matching_level.id,
          updated_at = now()
        FROM levels matching_level
        WHERE legacy.is_active = true
          AND legacy.school_year_id IS NULL
          AND legacy.level_id IS NULL
          AND LOWER(matching_level.name) = LOWER(
            COALESCE(NULLIF(BTRIM(legacy.level), ''), NULLIF(BTRIM(legacy.name), ''))
          )
      `);

      await transaction.execute(sql`
        UPDATE classes legacy
        SET
          school_year_id = ${schoolYearId}::uuid,
          updated_at = now()
        WHERE legacy.is_active = true
          AND legacy.school_year_id IS NULL
          AND legacy.level_id IS NOT NULL
      `);
    });
  }

  async listClassesBySchoolYear(schoolYearId: string): Promise<ClassItem[]> {
    const result = await this.db.execute<ClassRow>(sql`
      SELECT
        c.id,
        c.name,
        (
          SELECT COUNT(*)::int
          FROM students s
          WHERE s.class_id = c.id
            AND s.is_active = true
        ) AS student_count,
        c.is_active,
        l.id AS level_id,
        l.name AS level_name,
        l.order_index AS level_order_index,
        sy.id AS school_year_id,
        sy.label AS school_year_label,
        t.id AS homeroom_teacher_id,
        u.name AS homeroom_teacher_name,
        c.created_at,
        c.updated_at
      FROM classes c
      INNER JOIN levels l ON l.id = c.level_id
      INNER JOIN school_years sy ON sy.id = c.school_year_id
      LEFT JOIN teachers t ON t.id = c.homeroom_teacher_id
      LEFT JOIN users u ON u.id = t.user_id
      WHERE c.is_active = true
        AND c.school_year_id = ${schoolYearId}::uuid
      ORDER BY l.order_index ASC, c.name ASC
    `);
    return getRows(result).map(mapClass);
  }

  async createClassForActiveYear(input: CreateClassInput): Promise<ClassItem | null> {
    const result = await this.db.execute<ClassRow>(sql`
      WITH inserted AS (
        INSERT INTO classes (name, level_id, school_year_id, homeroom_teacher_id, is_active)
        SELECT
          ${input.name},
          ${input.levelId}::uuid,
          sy.id,
          ${input.homeroomTeacherId ?? null}::uuid,
          true
        FROM school_years sy
        WHERE sy.status = 'active'
        LIMIT 1
        RETURNING *
      )
      SELECT
        c.id,
        c.name,
        (
          SELECT COUNT(*)::int
          FROM students s
          WHERE s.class_id = c.id
            AND s.is_active = true
        ) AS student_count,
        c.is_active,
        l.id AS level_id,
        l.name AS level_name,
        l.order_index AS level_order_index,
        sy.id AS school_year_id,
        sy.label AS school_year_label,
        t.id AS homeroom_teacher_id,
        u.name AS homeroom_teacher_name,
        c.created_at,
        c.updated_at
      FROM inserted c
      INNER JOIN levels l ON l.id = c.level_id
      INNER JOIN school_years sy ON sy.id = c.school_year_id
      LEFT JOIN teachers t ON t.id = c.homeroom_teacher_id
      LEFT JOIN users u ON u.id = t.user_id
    `);
    const row = getRows(result)[0];
    return row ? mapClass(row) : null;
  }

  async updateClassForActiveYear(id: string, input: UpdateClassInput): Promise<ClassItem | null> {
    const result = await this.db.execute<ClassRow>(sql`
      WITH updated AS (
        UPDATE classes c
        SET
          name = CASE WHEN ${input.name !== undefined} THEN ${input.name ?? null} ELSE c.name END,
          level_id = CASE WHEN ${input.levelId !== undefined} THEN ${input.levelId ?? null}::uuid ELSE c.level_id END,
          homeroom_teacher_id = CASE
            WHEN ${input.homeroomTeacherId !== undefined}
              THEN ${input.homeroomTeacherId ?? null}::uuid
            ELSE c.homeroom_teacher_id
          END,
          updated_at = now()
        FROM school_years active_year
        WHERE c.id = ${id}::uuid
          AND c.school_year_id = active_year.id
          AND active_year.status = 'active'
          AND c.is_active = true
        RETURNING c.*
      )
      SELECT
        c.id,
        c.name,
        (
          SELECT COUNT(*)::int
          FROM students s
          WHERE s.class_id = c.id
            AND s.is_active = true
        ) AS student_count,
        c.is_active,
        l.id AS level_id,
        l.name AS level_name,
        l.order_index AS level_order_index,
        sy.id AS school_year_id,
        sy.label AS school_year_label,
        t.id AS homeroom_teacher_id,
        u.name AS homeroom_teacher_name,
        c.created_at,
        c.updated_at
      FROM updated c
      INNER JOIN levels l ON l.id = c.level_id
      INNER JOIN school_years sy ON sy.id = c.school_year_id
      LEFT JOIN teachers t ON t.id = c.homeroom_teacher_id
      LEFT JOIN users u ON u.id = t.user_id
    `);
    const row = getRows(result)[0];
    return row ? mapClass(row) : null;
  }

  async archiveClassForActiveYear(id: string): Promise<ClassItem | null> {
    const result = await this.db.execute<ClassRow>(sql`
      WITH archived AS (
        UPDATE classes c
        SET is_active = false, updated_at = now()
        FROM school_years active_year
        WHERE c.id = ${id}::uuid
          AND c.school_year_id = active_year.id
          AND active_year.status = 'active'
          AND c.is_active = true
        RETURNING c.*
      )
      SELECT
        c.id,
        c.name,
        (
          SELECT COUNT(*)::int
          FROM students s
          WHERE s.class_id = c.id
            AND s.is_active = true
        ) AS student_count,
        c.is_active,
        l.id AS level_id,
        l.name AS level_name,
        l.order_index AS level_order_index,
        sy.id AS school_year_id,
        sy.label AS school_year_label,
        t.id AS homeroom_teacher_id,
        u.name AS homeroom_teacher_name,
        c.created_at,
        c.updated_at
      FROM archived c
      INNER JOIN levels l ON l.id = c.level_id
      INNER JOIN school_years sy ON sy.id = c.school_year_id
      LEFT JOIN teachers t ON t.id = c.homeroom_teacher_id
      LEFT JOIN users u ON u.id = t.user_id
    `);
    const row = getRows(result)[0];
    return row ? mapClass(row) : null;
  }
}
