import argon2 from 'argon2';
import { sql } from 'drizzle-orm';

import { generateUsername } from '../../shared/utils/username.js';

import type {
  CreateTeacherInput,
  TeacherAttendanceStatsQuery,
  TeachersListQuery,
  UpdateTeacherInput,
} from './teachers.types.js';

export type QueryExecutor = {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
};

// Forme brute renvoyée par PostgreSQL (snake_case).
// is_blocked, blocked_reason et blocked_at sont sur la table teachers.
// is_active est sur la table users (accès au compte).
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
  is_blocked: boolean;
  blocked_reason: string | null;
  blocked_at: Date | null;
  username: string;
  user_id: string;
  created_at: Date;
};

type TotalRow = { total: string | number };
type IdRow = { id: string };
type CountRow = { count: string | number };
type TeacherAttendanceStatsRow = {
  teacher_id: string;
  teacher_name: string;
  teacher_type: 'vacataire' | 'permanent' | string;
  subjects: string[] | null;
  total_scheduled: string | number;
  present_count: string | number;
  absent_count: string | number;
  late_count: string | number;
  room_mismatch_count: string | number;
  rollcall_done_count: string | number;
  rollcall_missing_count: string | number;
  attendance_rate: string | number | null;
  hours_scheduled: string | number;
  hours_done: string | number;
};

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

const toNumber = (value: string | number | null | undefined): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
};

const buildWhere = (query: TeachersListQuery): ReturnType<typeof sql>[] => {
  const where: ReturnType<typeof sql>[] = [];

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

const makeWhereClause = (conditions: ReturnType<typeof sql>[]): ReturnType<typeof sql> => {
  if (conditions.length === 0) return sql``;
  return sql`WHERE ${sql.join(conditions, sql` AND `)}`;
};

// Fragment SELECT partagé — liste tous les champs utiles de teachers + users.
// Centralise la sélection pour éviter toute désynchronisation entre les méthodes.
const TEACHER_SELECT = sql`
  SELECT
    t.id,
    u.name,
    split_part(u.name, ' ', 1)                                               AS first_name,
    trim(substring(u.name FROM length(split_part(u.name, ' ', 1)) + 1))     AS last_name,
    u.phone,
    t.type::text                                                              AS type,
    t.subjects,
    t.hourly_rate,
    u.is_active,
    t.is_blocked,
    t.blocked_reason,
    t.blocked_at,
    t.username,
    t.user_id,
    t.created_at
  FROM teachers t
  INNER JOIN users u ON u.id = t.user_id
`;

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
        ${TEACHER_SELECT}
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

  // Route dédiée — ne dépend pas du filtre is_active, retourne toujours le prof
  // qu'il soit actif ou bloqué. Indispensable pour rafraîchir la page de détail
  // après un blocage sans déclencher TEACHER_NOT_FOUND.
  async getTeacherById(teacherId: string): Promise<TeacherRow | null> {
    const result = await this.db.execute(sql`
      ${TEACHER_SELECT}
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
      VALUES ('teacher', ${input.name}, ${input.phone}, null, ${passwordHash}, true)
      RETURNING id
    `);

    const user = getRows<IdRow>(userResult)[0];
    if (!user) throw new Error('Failed to create teacher user');

    const teacherResult = await this.db.execute(sql`
      INSERT INTO teachers (user_id, username, type, subjects, hourly_rate, is_blocked)
      VALUES (${user.id}, ${username}, ${input.type}, ${input.subjects}, ${input.hourly_rate}, false)
      RETURNING id
    `);

    const teacher = getRows<IdRow>(teacherResult)[0];
    if (!teacher) throw new Error('Failed to create teacher');

    const created = await this.getTeacherById(teacher.id);
    if (!created) throw new Error('Failed to load created teacher');

    return created;
  }

  async updateTeacher(teacherId: string, input: UpdateTeacherInput): Promise<TeacherRow | null> {
    const current = await this.getTeacherById(teacherId);
    if (!current) return null;

    // ── Mise à jour users (infos personnelles + is_active) ────────────────────
    const nextFirstName = input.first_name ?? current.first_name;
    const nextLastName = input.last_name ?? current.last_name ?? '';
    const nextFullName = `${nextFirstName} ${nextLastName}`.trim();

    await this.db.execute(sql`
      UPDATE users
      SET
        name      = ${nextFullName},
        phone     = ${input.phone === undefined ? current.phone : input.phone},
        is_active = ${input.is_active ?? current.is_active}
      WHERE id = ${current.user_id}
    `);

    // ── Mise à jour teachers (données pédagogiques + blocage métier) ──────────
    //
    // Logique blocage :
    //   is_blocked = true  → stocker blocked_reason + horodatage NOW()
    //   is_blocked = false → effacer blocked_reason et blocked_at
    //   is_blocked absent  → conserver l'état courant
    const nextIsBlocked = input.is_blocked ?? current.is_blocked;

    let blockedReasonSql: ReturnType<typeof sql>;
    let blockedAtSql: ReturnType<typeof sql>;

    if (input.is_blocked === true) {
      // Blocage : persiste le motif (peut être null si absent)
      blockedReasonSql = sql`${input.blocked_reason ?? null}`;
      blockedAtSql = sql`NOW()`;
    } else if (input.is_blocked === false) {
      // Déblocage : efface le motif et l'horodatage
      blockedReasonSql = sql`NULL`;
      blockedAtSql = sql`NULL`;
    } else {
      // Pas de changement de statut de blocage :
      // si blocked_reason est fourni on le met à jour, sinon on conserve
      blockedReasonSql =
        input.blocked_reason !== undefined
          ? sql`${input.blocked_reason}`
          : sql`${current.blocked_reason}`;
      blockedAtSql = sql`${current.blocked_at}`;
    }
    // concertis la matière en un tableau pour ne pas bloquer la requête
    const pgArrayFormat = `{${(input.subjects ?? current.subjects ?? []).join(',')}}`;

    await this.db.execute(sql`
      UPDATE teachers
      SET
        type           = ${input.type ?? current.type},
        subjects       = ${pgArrayFormat},
        hourly_rate    = ${input.hourly_rate === undefined ? current.hourly_rate : input.hourly_rate},
        is_blocked     = ${nextIsBlocked},
        blocked_reason = ${blockedReasonSql},
        blocked_at     = ${blockedAtSql}
      WHERE id = ${teacherId}
    `);

    return this.getTeacherById(teacherId);
  }

  // softDeleteTeacher : désactivation de compte (users.is_active → false).
  // N'est pas la même opération que le blocage métier (teachers.is_blocked).
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
                (EXTRACT(EPOCH FROM (ts.end_time - ts.start_time)) / 3600.0)
                * COALESCE(t.hourly_rate, 0)
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

  async getAttendanceStats(params: TeacherAttendanceStatsQuery): Promise<
    Array<{
      teacher_id: string;
      teacher_name: string;
      teacher_type: 'vacataire' | 'permanent';
      subjects: string[];
      total_scheduled: number;
      present_count: number;
      absent_count: number;
      late_count: number;
      room_mismatch_count: number;
      rollcall_done_count: number;
      rollcall_missing_count: number;
      attendance_rate: number;
      hours_scheduled: number;
      hours_done: number;
    }>
  > {
    const subjectFilter = params.subject ? sql`AND s.subject = ${params.subject}` : sql``;
    const classFilter = params.class_id ? sql`AND s.class_id = ${params.class_id}::uuid` : sql``;
    const teacherFilter = params.teacher_id ? sql`AND s.teacher_id = ${params.teacher_id}::uuid` : sql``;
    const statusFilter = params.status_filter ?? null;

    const result = await this.db.execute(sql`
      WITH active_period AS (
        SELECT id
        FROM schedule_periods
        WHERE is_active = true
          AND valid_from <= ${params.to}::date
          AND valid_to >= ${params.from}::date
        ORDER BY created_at DESC
        LIMIT 1
      ),
      dates AS (
        SELECT generate_series(${params.from}::date, ${params.to}::date, INTERVAL '1 day')::date AS date
      ),
      scheduled AS (
        SELECT
          t.id AS teacher_id,
          u.name AS teacher_name,
          t.type AS teacher_type,
          t.subjects,
          s.id AS schedule_id,
          d.date,
          s.subject,
          s.class_id,
          ts.end_time AS slot_end_time,
          EXTRACT(EPOCH FROM (ts.end_time - ts.start_time)) / 3600 AS slot_hours
        FROM dates d
        INNER JOIN active_period ap ON true
        INNER JOIN schedules s
          ON s.schedule_period_id = ap.id
          AND s.day_of_week = EXTRACT(ISODOW FROM d.date)::int
          AND s.is_active = true
        INNER JOIN teachers t ON t.id = s.teacher_id
        INNER JOIN users u ON u.id = t.user_id
        INNER JOIN time_slots ts ON ts.id = s.time_slot_id
        WHERE 1=1
        ${subjectFilter}
        ${classFilter}
        ${teacherFilter}
      )
      SELECT
        sc.teacher_id::text AS teacher_id,
        sc.teacher_name,
        sc.teacher_type::text AS teacher_type,
        sc.subjects,
        COUNT(sc.schedule_id)::int AS total_scheduled,
        COUNT(CASE WHEN at.status IN ('present', 'late', 'excused') THEN 1 END)::int AS present_count,
        COUNT(
          CASE
            WHEN at.status = 'absent' THEN 1
            WHEN at.id IS NULL
              AND ((sc.date::timestamp + sc.slot_end_time)::timestamp <= (NOW() AT TIME ZONE 'Africa/Abidjan'))
            THEN 1
          END
        )::int AS absent_count,
        COUNT(CASE WHEN at.status = 'late' THEN 1 END)::int AS late_count,
        COUNT(CASE WHEN at.room_mismatch = true THEN 1 END)::int AS room_mismatch_count,
        COUNT(CASE WHEN rollcall.has_rollcall = true THEN 1 END)::int AS rollcall_done_count,
        COUNT(
          CASE
            WHEN rollcall.has_rollcall IS DISTINCT FROM true
              AND at.checked_in_at IS NOT NULL
            THEN 1
          END
        )::int AS rollcall_missing_count,
        ROUND(
          100.0 * COUNT(CASE WHEN at.status IN ('present', 'late', 'excused') THEN 1 END)::numeric
          / NULLIF(COUNT(sc.schedule_id), 0),
          2
        )::float AS attendance_rate,
        ROUND(SUM(sc.slot_hours)::numeric, 2)::float AS hours_scheduled,
        ROUND(
          SUM(CASE WHEN at.status IN ('present', 'late', 'excused') THEN sc.slot_hours ELSE 0 END)::numeric,
          2
        )::float AS hours_done
      FROM scheduled sc
      LEFT JOIN attendances_teacher at
        ON at.schedule_id = sc.schedule_id
        AND at.date = sc.date
      LEFT JOIN LATERAL (
        SELECT true AS has_rollcall
        FROM attendances_student ast
        WHERE ast.schedule_id = sc.schedule_id
          AND ast.date = sc.date
        LIMIT 1
      ) rollcall ON true
      GROUP BY sc.teacher_id, sc.teacher_name, sc.teacher_type, sc.subjects
      HAVING
        CASE
          WHEN ${statusFilter} = 'absent'
            THEN COUNT(
              CASE
                WHEN at.status = 'absent' THEN 1
                WHEN at.id IS NULL
                  AND ((sc.date::timestamp + sc.slot_end_time)::timestamp <= (NOW() AT TIME ZONE 'Africa/Abidjan'))
                THEN 1
              END
            ) > 0
          WHEN ${statusFilter} = 'room_mismatch'
            THEN COUNT(CASE WHEN at.room_mismatch = true THEN 1 END) > 0
          WHEN ${statusFilter} = 'rollcall_missing'
            THEN COUNT(
              CASE
                WHEN rollcall.has_rollcall IS DISTINCT FROM true
                  AND at.checked_in_at IS NOT NULL
                THEN 1
              END
            ) > 0
          WHEN ${statusFilter} = 'late'
            THEN COUNT(CASE WHEN at.status = 'late' THEN 1 END) > 0
          ELSE true
        END
      ORDER BY sc.teacher_name ASC
    `);

    return getRows<TeacherAttendanceStatsRow>(result).map((row) => ({
      teacher_id: row.teacher_id,
      teacher_name: row.teacher_name,
      teacher_type: row.teacher_type === 'permanent' ? 'permanent' : 'vacataire',
      subjects: Array.isArray(row.subjects) ? row.subjects : [],
      total_scheduled: toNumber(row.total_scheduled),
      present_count: toNumber(row.present_count),
      absent_count: toNumber(row.absent_count),
      late_count: toNumber(row.late_count),
      room_mismatch_count: toNumber(row.room_mismatch_count),
      rollcall_done_count: toNumber(row.rollcall_done_count),
      rollcall_missing_count: toNumber(row.rollcall_missing_count),
      attendance_rate: toNumber(row.attendance_rate),
      hours_scheduled: toNumber(row.hours_scheduled),
      hours_done: toNumber(row.hours_done),
    }));
  }
}
