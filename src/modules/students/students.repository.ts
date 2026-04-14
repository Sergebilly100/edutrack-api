import { sql, type SQL } from 'drizzle-orm';

import type {
  AttendanceHistoryQuery,
  AttendanceStudentRecord,
  BulkAttendanceInput,
  CreateStudentInput,
  StudentRecord,
  StudentsListQuery,
  TodayAbsenceRow,
  UpdateStudentInput,
} from './students.types.js';

export type QueryExecutor = {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
};

type StudentRow = {
  id: string;
  class_id: string;
  class_name: string;
  first_name: string;
  last_name: string;
  parent_phone: string | null;
  parent_phone_2: string | null;
  is_active: boolean;
  created_at: Date;
};

type TotalRow = { total: string | number };

type ExistingStudentRow = {
  id: string;
  class_id: string;
  first_name: string;
  last_name: string;
  parent_phone: string | null;
  parent_phone_2: string | null;
  is_active: boolean;
};

type ScheduleRow = {
  id: string;
  class_id: string;
  subject: string;
};

type StudentAbsenceSourceRow = {
  id: string;
  first_name: string;
  parent_phone: string | null;
};

type AttendanceRow = {
  id: string;
  date: string;
  schedule_id: string | null;
  student_id: string;
  student_first_name: string;
  student_last_name: string;
  class_id: string;
  class_name: string;
  status: 'present' | 'absent' | 'excused';
  marked_by: string | null;
  created_at: Date;
};

type TodayAbsenceDbRow = {
  class_id: string;
  class_name: string;
  student_id: string;
  student_first_name: string;
  student_last_name: string;
  schedule_id: string | null;
  date: string;
};

type TenantIdentityRow = {
  id: string;
};

const getRows = <T>(result: unknown): T[] => {
  if (typeof result !== 'object' || result === null || !('rows' in result)) {
    return [];
  }

  const rows = (result as { rows?: T[] }).rows;
  return Array.isArray(rows) ? rows : [];
};

const mapStudent = (row: StudentRow): StudentRecord => ({
  id: row.id,
  classId: row.class_id,
  className: row.class_name,
  firstName: row.first_name,
  lastName: row.last_name,
  parentPhone: row.parent_phone,
  parentPhone2: row.parent_phone_2,
  isActive: row.is_active,
  createdAt: row.created_at.toISOString(),
});

const mapAttendance = (row: AttendanceRow): AttendanceStudentRecord => ({
  id: row.id,
  date: row.date,
  scheduleId: row.schedule_id,
  studentId: row.student_id,
  studentFirstName: row.student_first_name,
  studentLastName: row.student_last_name,
  classId: row.class_id,
  className: row.class_name,
  status: row.status,
  markedBy: row.marked_by,
  createdAt: row.created_at.toISOString(),
});

const toTotal = (row: TotalRow | undefined): number => {
  if (!row) {
    return 0;
  }

  const value = typeof row.total === 'string' ? Number(row.total) : row.total;
  return Number.isFinite(value) ? value : 0;
};

const buildStudentsWhere = (query: StudentsListQuery): SQL[] => {
  const where: SQL[] = [];

  if (query.class_id) {
    where.push(sql`s.class_id = ${query.class_id}`);
  }

  if (typeof query.is_active === 'boolean') {
    where.push(sql`s.is_active = ${query.is_active}`);
  }

  if (query.search) {
    where.push(sql`(s.first_name ILIKE ${`%${query.search}%`} OR s.last_name ILIKE ${`%${query.search}%`})`);
  }

  return where;
};

const buildAttendanceWhere = (query: AttendanceHistoryQuery): SQL[] => {
  const where: SQL[] = [sql`a.status = 'absent'`];

  if (query.class_id) {
    where.push(sql`c.id = ${query.class_id}`);
  }

  if (query.student_id) {
    where.push(sql`s.id = ${query.student_id}`);
  }

  if (query.date_from) {
    where.push(sql`a.date >= ${query.date_from}`);
  }

  if (query.date_to) {
    where.push(sql`a.date <= ${query.date_to}`);
  }

  return where;
};

const makeWhereClause = (conditions: SQL[]): SQL => {
  if (conditions.length === 0) {
    return sql``;
  }

  return sql`WHERE ${sql.join(conditions, sql` AND `)}`;
};

const deduplicateIds = (ids: string[]): string[] => Array.from(new Set(ids));

export class StudentsRepository {
  constructor(
    private readonly db: QueryExecutor,
    private readonly globalDb: QueryExecutor
  ) {}

  async getTenantIdBySchemaName(schemaName: string): Promise<string | null> {
    const result = await this.globalDb.execute(sql`
      SELECT id
      FROM public.tenants
      WHERE schema_name = ${schemaName}
      LIMIT 1
    `);

    return getRows<TenantIdentityRow>(result)[0]?.id ?? null;
  }

  async listStudents(
    query: StudentsListQuery
  ): Promise<{ rows: StudentRecord[]; total: number }> {
    const offset = (query.page - 1) * query.limit;
    const where = makeWhereClause(buildStudentsWhere(query));

    const [items, total] = await Promise.all([
      this.db.execute(sql`
        SELECT
          s.id,
          s.class_id,
          c.name AS class_name,
          s.first_name,
          s.last_name,
          s.parent_phone,
          s.parent_phone_2,
          s.is_active,
          s.created_at
        FROM students s
        INNER JOIN classes c ON c.id = s.class_id
        ${where}
        ORDER BY s.created_at DESC
        LIMIT ${query.limit}
        OFFSET ${offset}
      `),
      this.db.execute(sql`
        SELECT COUNT(*) AS total
        FROM students s
        INNER JOIN classes c ON c.id = s.class_id
        ${where}
      `),
    ]);

    return {
      rows: getRows<StudentRow>(items).map(mapStudent),
      total: toTotal(getRows<TotalRow>(total)[0]),
    };
  }

  async createStudent(input: CreateStudentInput): Promise<StudentRecord> {
    const result = await this.db.execute(sql`
      INSERT INTO students (
        class_id,
        first_name,
        last_name,
        parent_phone,
        parent_phone_2,
        is_active
      )
      VALUES (
        ${input.class_id},
        ${input.first_name},
        ${input.last_name},
        ${input.parent_phone},
        ${input.parent_phone_2},
        ${input.is_active}
      )
      RETURNING
        id,
        class_id,
        (SELECT name FROM classes WHERE id = class_id) AS class_name,
        first_name,
        last_name,
        parent_phone,
        parent_phone_2,
        is_active,
        created_at
    `);

    const created = getRows<StudentRow>(result)[0];
    if (!created) {
      throw new Error('Unable to create student');
    }

    if (!created.class_name) {
      throw new Error('Class not found');
    }

    if (created.is_active) {
      await this.adjustClassStudentCount(created.class_id, 1);
    }

    return mapStudent(created);
  }

  async findStudentById(studentId: string): Promise<StudentRecord | null> {
    const result = await this.db.execute(sql`
      SELECT
        s.id,
        s.class_id,
        c.name AS class_name,
        s.first_name,
        s.last_name,
        s.parent_phone,
        s.parent_phone_2,
        s.is_active,
        s.created_at
      FROM students s
      INNER JOIN classes c ON c.id = s.class_id
      WHERE s.id = ${studentId}
      LIMIT 1
    `);

    const row = getRows<StudentRow>(result)[0];
    return row ? mapStudent(row) : null;
  }

  async updateStudent(studentId: string, input: UpdateStudentInput): Promise<StudentRecord | null> {
    const currentResult = await this.db.execute(sql`
      SELECT
        id,
        class_id,
        first_name,
        last_name,
        parent_phone,
        parent_phone_2,
        is_active
      FROM students
      WHERE id = ${studentId}
      LIMIT 1
    `);

    const current = getRows<ExistingStudentRow>(currentResult)[0];
    if (!current) {
      return null;
    }

    const nextClassId = input.class_id ?? current.class_id;
    const nextIsActive = input.is_active ?? current.is_active;
    const nextParentPhone =
      input.parent_phone !== undefined ? input.parent_phone : current.parent_phone;
    const nextParentPhone2 =
      input.parent_phone_2 !== undefined ? input.parent_phone_2 : current.parent_phone_2;

    const updateResult = await this.db.execute(sql`
      UPDATE students
      SET
        class_id = ${nextClassId},
        first_name = ${input.first_name ?? current.first_name},
        last_name = ${input.last_name ?? current.last_name},
        parent_phone = ${nextParentPhone},
        parent_phone_2 = ${nextParentPhone2},
        is_active = ${nextIsActive}
      WHERE id = ${studentId}
      RETURNING id
    `);

    if (!getRows<{ id: string }>(updateResult)[0]) {
      return null;
    }

    if (current.class_id !== nextClassId) {
      if (current.is_active) {
        await this.adjustClassStudentCount(current.class_id, -1);
      }
      if (nextIsActive) {
        await this.adjustClassStudentCount(nextClassId, 1);
      }
    } else if (current.is_active !== nextIsActive) {
      await this.adjustClassStudentCount(nextClassId, nextIsActive ? 1 : -1);
    }

    return this.findStudentById(studentId);
  }

  async softDeleteStudent(studentId: string): Promise<StudentRecord | null> {
    const result = await this.db.execute(sql`
      UPDATE students s
      SET is_active = false
      FROM classes c
      WHERE s.id = ${studentId}
        AND s.is_active = true
        AND c.id = s.class_id
      RETURNING
        s.id,
        s.class_id,
        c.name AS class_name,
        s.first_name,
        s.last_name,
        s.parent_phone,
        s.parent_phone_2,
        s.is_active,
        s.created_at
    `);

    const row = getRows<StudentRow>(result)[0];
    if (!row) {
      return null;
    }

    await this.adjustClassStudentCount(row.class_id, -1);
    return mapStudent(row);
  }

  async findScheduleById(scheduleId: string): Promise<{ id: string; classId: string; subject: string } | null> {
    const result = await this.db.execute(sql`
      SELECT id, class_id, subject
      FROM schedules
      WHERE id = ${scheduleId}
      LIMIT 1
    `);

    const row = getRows<ScheduleRow>(result)[0];
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      classId: row.class_id,
      subject: row.subject,
    };
  }

  async findStudentsForAbsence(classId: string, studentIds: string[]): Promise<
    Array<{
      id: string;
      firstName: string;
      parentPhone: string | null;
    }>
  > {
    const ids = deduplicateIds(studentIds);
    if (ids.length === 0) {
      return [];
    }

    const placeholders = sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `
    );

    const result = await this.db.execute(sql`
      SELECT id, first_name, parent_phone
      FROM students
      WHERE class_id = ${classId}
        AND is_active = true
        AND id IN (${placeholders})
    `);

    return getRows<StudentAbsenceSourceRow>(result).map((row) => ({
      id: row.id,
      firstName: row.first_name,
      parentPhone: row.parent_phone,
    }));
  }

  async upsertStudentAbsences(input: {
    scheduleId: BulkAttendanceInput['scheduleId'];
    date: BulkAttendanceInput['date'];
    studentIds: string[];
    markedBy: string;
  }): Promise<number> {
    // Deduplication defensive: le service deduplique deja en amont.
    const ids = deduplicateIds(input.studentIds);
    if (ids.length === 0) {
      return 0;
    }

    const values = sql.join(
      ids.map((id) => sql`(${id}, ${input.scheduleId}, ${input.date}, 'absent', ${input.markedBy})`),
      sql`, `
    );

    const result = await this.db.execute(sql`
      INSERT INTO attendances_student (student_id, schedule_id, date, status, marked_by)
      VALUES ${values}
      ON CONFLICT (student_id, schedule_id, date)
      DO UPDATE SET
        status = EXCLUDED.status,
        marked_by = EXCLUDED.marked_by
      RETURNING id
    `);

    return getRows<{ id: string }>(result).length;
  }

  async getSchoolPhone(): Promise<string | null> {
    const result = await this.db.execute(sql`
      SELECT phone
      FROM users
      WHERE role = 'director'
        AND phone IS NOT NULL
      ORDER BY created_at ASC
      LIMIT 1
    `);

    return getRows<{ phone: string | null }>(result)[0]?.phone ?? null;
  }

  async listAttendanceHistory(
    query: AttendanceHistoryQuery
  ): Promise<{ rows: AttendanceStudentRecord[]; total: number }> {
    const offset = (query.page - 1) * query.limit;
    const where = makeWhereClause(buildAttendanceWhere(query));

    const [items, total] = await Promise.all([
      this.db.execute(sql`
        SELECT
          a.id,
          a.date,
          a.schedule_id,
          a.student_id,
          s.first_name AS student_first_name,
          s.last_name AS student_last_name,
          c.id AS class_id,
          c.name AS class_name,
          a.status,
          a.marked_by,
          a.created_at
        FROM attendances_student a
        INNER JOIN students s ON s.id = a.student_id
        INNER JOIN classes c ON c.id = s.class_id
        ${where}
        ORDER BY a.date DESC, a.created_at DESC
        LIMIT ${query.limit}
        OFFSET ${offset}
      `),
      this.db.execute(sql`
        SELECT COUNT(*) AS total
        FROM attendances_student a
        INNER JOIN students s ON s.id = a.student_id
        INNER JOIN classes c ON c.id = s.class_id
        ${where}
      `),
    ]);

    return {
      rows: getRows<AttendanceRow>(items).map(mapAttendance),
      total: toTotal(getRows<TotalRow>(total)[0]),
    };
  }

  async listTodayAbsences(date?: string): Promise<TodayAbsenceRow[]> {
    const result = await this.db.execute(sql`
      SELECT
        c.id AS class_id,
        c.name AS class_name,
        s.id AS student_id,
        s.first_name AS student_first_name,
        s.last_name AS student_last_name,
        a.schedule_id,
        a.date
      FROM attendances_student a
      INNER JOIN students s ON s.id = a.student_id
      INNER JOIN classes c ON c.id = s.class_id
      WHERE a.status = 'absent'
        AND a.date = COALESCE(${date ?? null}, CURRENT_DATE::text)
      ORDER BY c.name ASC, s.last_name ASC, s.first_name ASC
    `);

    return getRows<TodayAbsenceDbRow>(result).map((row) => ({
      classId: row.class_id,
      className: row.class_name,
      studentId: row.student_id,
      studentFirstName: row.student_first_name,
      studentLastName: row.student_last_name,
      scheduleId: row.schedule_id,
      date: row.date,
    }));
  }

  private async adjustClassStudentCount(classId: string, delta: number): Promise<void> {
    await this.db.execute(sql`
      UPDATE classes
      SET student_count = GREATEST(student_count + ${delta}, 0)
      WHERE id = ${classId}
    `);
  }
}
