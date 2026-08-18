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
      SELECT id, label, start_date::text, end_date::text, status, created_at, updated_at
      FROM school_years
      ORDER BY start_date DESC, created_at DESC
    `);
    return getRows(result).map(mapSchoolYear);
  }

  async findSchoolYearById(id: string): Promise<SchoolYearItem | null> {
    const result = await this.db.execute<SchoolYearRow>(sql`
      SELECT id, label, start_date::text, end_date::text, status, created_at, updated_at
      FROM school_years
      WHERE id = ${id}::uuid
      LIMIT 1
    `);
    const row = getRows(result)[0];
    return row ? mapSchoolYear(row) : null;
  }

  async getActiveSchoolYear(): Promise<SchoolYearItem | null> {
    const result = await this.db.execute<SchoolYearRow>(sql`
      SELECT id, label, start_date::text, end_date::text, status, created_at, updated_at
      FROM school_years
      WHERE status = 'active'
      LIMIT 1
    `);
    const row = getRows(result)[0];
    return row ? mapSchoolYear(row) : null;
  }

  async createSchoolYear(input: CreateSchoolYearInput): Promise<SchoolYearItem> {
    const result = await this.db.execute<SchoolYearRow>(sql`
      INSERT INTO school_years (label, start_date, end_date, status)
      VALUES (${input.label}, ${input.startDate}::date, ${input.endDate}::date, ${input.status}::school_year_status)
      RETURNING id, label, start_date::text, end_date::text, status, created_at, updated_at
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
        label = CASE WHEN ${input.label !== undefined} THEN ${input.label ?? null} ELSE label END,
        start_date = CASE WHEN ${input.startDate !== undefined} THEN ${input.startDate ?? null}::date ELSE start_date END,
        end_date = CASE WHEN ${input.endDate !== undefined} THEN ${input.endDate ?? null}::date ELSE end_date END,
        status = CASE WHEN ${input.status !== undefined} THEN ${input.status ?? null}::school_year_status ELSE status END,
        updated_at = now()
      WHERE id = ${id}::uuid
      RETURNING id, label, start_date::text, end_date::text, status, created_at, updated_at
    `);
    const row = getRows(result)[0];
    return row ? mapSchoolYear(row) : null;
  }

  async deleteSchoolYear(id: string): Promise<SchoolYearItem | null> {
    const result = await this.db.execute<SchoolYearRow>(sql`
      DELETE FROM school_years
      WHERE id = ${id}::uuid
        AND status <> 'active'
      RETURNING id, label, start_date::text, end_date::text, status, created_at, updated_at
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

  async listClassesBySchoolYear(schoolYearId: string): Promise<ClassItem[]> {
    const result = await this.db.execute<ClassRow>(sql`
      SELECT
        c.id,
        c.name,
        c.student_count,
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
        c.student_count,
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
        c.student_count,
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
        c.student_count,
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
