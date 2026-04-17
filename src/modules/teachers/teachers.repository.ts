import argon2 from 'argon2';
import { sql } from 'drizzle-orm';

import { generateUsername } from '../../shared/utils/username.js';

import type { CreateTeacherInput, TeachersListQuery, UpdateTeacherInput } from './teachers.types.js';

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
}
