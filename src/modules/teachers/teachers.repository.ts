import argon2 from 'argon2';
import { sql, type SQL } from 'drizzle-orm';

import { generateUsername } from '../../shared/utils/username.js';

import type { CreateTeacherInput, TeachersListQuery, UpdateTeacherInput } from './teachers.types.js';

export type QueryExecutor = {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
};

type TeacherRow = {
  id: string;
  name: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  type: 'vacataire' | 'permanent';
  subjects: string[];
  hourly_rate: number | null;
  is_active: boolean;
  username: string;
  user_id: string;
  created_at: Date;
};

type TotalRow = { total: string | number };

type IdRow = { id: string };
type CountRow = { count: string | number };

const getRows = <T>(result: unknown): T[] => {
  if (typeof result !== 'object' || result === null || !('rows' in result)) {
    return [];
  }

  const rows = (result as { rows?: T[] }).rows;
  return Array.isArray(rows) ? rows : [];
};

const toTotal = (row: TotalRow | undefined): number => {
  if (!row) return 0;
  const value = typeof row.total === 'string' ? Number(row.total) : row.total;
  return Number.isFinite(value) ? value : 0;
};

const buildWhere = (query: TeachersListQuery): SQL[] => {
  const where: SQL[] = [];

  if (query.type) {
    where.push(sql`t.type = ${query.type}`);
  }

  if (typeof query.is_active === 'boolean') {
    where.push(sql`u.is_active = ${query.is_active}`);
  }

  if (query.subject) {
    where.push(
      sql`EXISTS (
        SELECT 1
        FROM unnest(t.subjects) AS subj
        WHERE subj ILIKE ${`%${query.subject}%`}
      )`
    );
  }

  if (query.search) {
    where.push(
      sql`(
        u.name ILIKE ${`%${query.search}%`}
        OR t.username ILIKE ${`%${query.search}%`}
      )`
    );
  }

  return where;
};

const makeWhereClause = (conditions: SQL[]): SQL => {
  if (conditions.length === 0) return sql``;
  return sql`WHERE ${sql.join(conditions, sql` AND `)}`;
};

export class TeachersRepository {
  constructor(private readonly db: QueryExecutor) {}

  async countActiveUsers(): Promise<number> {
    const result = await this.db.execute(sql`
      SELECT COUNT(*) AS count
      FROM users
      WHERE is_active = true
    `);

    const [row] = getRows<CountRow>(result);
    return toTotal({ total: row?.count ?? 0 });
  }

  async listTeachers(query: TeachersListQuery): Promise<{ rows: TeacherRow[]; total: number }> {
    const offset = (query.page - 1) * query.limit;
    const where = makeWhereClause(buildWhere(query));

    const [items, total] = await Promise.all([
      this.db.execute(sql`
        SELECT
          t.id,
          u.name,
          split_part(u.name, ' ', 1) AS first_name,
          trim(substring(u.name FROM length(split_part(u.name, ' ', 1)) + 1)) AS last_name,
          u.phone,
          t.type::text AS type,
          t.subjects,
          t.hourly_rate,
          u.is_active,
          t.username,
          t.user_id,
          t.created_at
        FROM teachers t
        INNER JOIN users u ON u.id = t.user_id
        ${where}
        ORDER BY t.created_at DESC
        LIMIT ${query.limit}
        OFFSET ${offset}
      `),
      this.db.execute(sql`
        SELECT COUNT(*) AS total
        FROM teachers t
        INNER JOIN users u ON u.id = t.user_id
        ${where}
      `),
    ]);

    return {
      rows: getRows<TeacherRow>(items),
      total: toTotal(getRows<TotalRow>(total)[0]),
    };
  }

  async getTeacherById(teacherId: string): Promise<TeacherRow | null> {
    const result = await this.db.execute(sql`
      SELECT
        t.id,
        u.name,
        split_part(u.name, ' ', 1) AS first_name,
        trim(substring(u.name FROM length(split_part(u.name, ' ', 1)) + 1)) AS last_name,
        u.phone,
        t.type::text AS type,
        t.subjects,
        t.hourly_rate,
        u.is_active,
        t.username,
        t.user_id,
        t.created_at
      FROM teachers t
      INNER JOIN users u ON u.id = t.user_id
      WHERE t.id = ${teacherId}
      LIMIT 1
    `);

    return getRows<TeacherRow>(result)[0] ?? null;
  }

  async createTeacher(input: CreateTeacherInput): Promise<TeacherRow> {
    const existingUsernamesResult = await this.db.execute(sql`
      SELECT username FROM teachers
    `);
    const existingUsernames = getRows<{ username: string }>(existingUsernamesResult).map(
      (row) => row.username
    );

    const username = generateUsername(input.last_name, input.first_name, existingUsernames);
    const password = process.env.IMPORT_TEACHER_DEFAULT_PASSWORD ?? 'Test1234!';
    const passwordHash = await argon2.hash(password);

    const userResult = await this.db.execute(sql`
      INSERT INTO users (role, name, phone, email, password_hash, is_active)
      VALUES (
        'teacher',
        ${input.name},
        ${input.phone},
        null,
        ${passwordHash},
        true
      )
      RETURNING id
    `);

    const user = getRows<IdRow>(userResult)[0];
    if (!user) {
      throw new Error('Failed to create teacher user');
    }

    const teacherResult = await this.db.execute(sql`
      INSERT INTO teachers (user_id, username, type, subjects, hourly_rate)
      VALUES (
        ${user.id},
        ${username},
        ${input.type},
        ${input.subjects},
        ${input.hourly_rate}
      )
      RETURNING id
    `);

    const teacher = getRows<IdRow>(teacherResult)[0];
    if (!teacher) {
      throw new Error('Failed to create teacher');
    }

    const created = await this.getTeacherById(teacher.id);
    if (!created) {
      throw new Error('Failed to load created teacher');
    }

    return created;
  }

  async updateTeacher(teacherId: string, input: UpdateTeacherInput): Promise<TeacherRow | null> {
    const current = await this.getTeacherById(teacherId);
    if (!current) return null;

    const nextFirstName = input.first_name ?? current.first_name;
    const nextLastName = input.last_name ?? current.last_name ?? '';
    const nextFullName = `${nextFirstName} ${nextLastName}`.trim();

    await this.db.execute(sql`
      UPDATE users
      SET
        name = ${nextFullName},
        phone = ${input.phone === undefined ? current.phone : input.phone},
        is_active = ${input.is_active ?? current.is_active}
      WHERE id = ${current.user_id}
    `);

    await this.db.execute(sql`
      UPDATE teachers
      SET
        type = ${input.type ?? current.type},
        subjects = ${input.subjects ?? current.subjects},
        hourly_rate = ${
          input.hourly_rate === undefined ? current.hourly_rate : input.hourly_rate
        }
      WHERE id = ${teacherId}
    `);

    return this.getTeacherById(teacherId);
  }

  async softDeleteTeacher(teacherId: string): Promise<TeacherRow | null> {
    const current = await this.getTeacherById(teacherId);
    if (!current) return null;

    await this.db.execute(sql`
      UPDATE users
      SET is_active = false
      WHERE id = ${current.user_id}
    `);

    return this.getTeacherById(teacherId);
  }

  async getTeacherStats(
    teacherId: string,
    dateFrom: string,
    dateTo: string
  ): Promise<{ attendance_rate: number; hours_worked: number; amount_due: number } | null> {
    const teacher = await this.getTeacherById(teacherId);
    if (!teacher) return null;

    const result = await this.db.execute(sql`
      SELECT
        COALESCE(
          SUM(CASE WHEN at.status IN ('present', 'late', 'excused') THEN 1 ELSE 0 END),
          0
        )::int AS present_count,
        COUNT(*)::int AS total_count,
        COALESCE(
          SUM(
            CASE
              WHEN at.status IN ('present', 'late', 'excused')
              THEN EXTRACT(EPOCH FROM (ts.end_time - ts.start_time)) / 3600.0
              ELSE 0
            END
          ),
          0
        )::float AS hours_worked,
        COALESCE(
          SUM(
            CASE
              WHEN at.status IN ('present', 'late', 'excused') THEN
                (EXTRACT(EPOCH FROM (ts.end_time - ts.start_time)) / 3600.0) * COALESCE(t.hourly_rate, 0)
              ELSE 0
            END
          ),
          0
        )::float AS amount_due
      FROM attendances_teacher at
      INNER JOIN schedules s ON s.id = at.schedule_id
      INNER JOIN time_slots ts ON ts.id = s.time_slot_id
      INNER JOIN teachers t ON t.id = at.teacher_id
      WHERE at.teacher_id = ${teacherId}
        AND at.date >= ${dateFrom}
        AND at.date <= ${dateTo}
    `);

    const row = getRows<{
      present_count: number;
      total_count: number;
      hours_worked: number;
      amount_due: number;
    }>(result)[0];

    const present = row?.present_count ?? 0;
    const total = row?.total_count ?? 0;
    const attendance_rate = total > 0 ? Number(((present / total) * 100).toFixed(2)) : 0;

    return {
      attendance_rate,
      hours_worked: row?.hours_worked ?? 0,
      amount_due: row?.amount_due ?? 0,
    };
  }
}
