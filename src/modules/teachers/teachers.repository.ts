import argon2 from 'argon2';
import { sql } from 'drizzle-orm';

import { logger } from '../../shared/observability/logger.js';
import { toNumber } from '../../shared/utils/numbers.js';
import { generateUsername } from '../../shared/utils/username.js';
import { generateInitialPassword } from '../../shared/utils/password-generator.js';

import type {
  CreateTeacherInput,
  TeacherAttendanceStatsQuery,
  TeachersListQuery,
  UpdateTeacherInput,
} from './teachers.types.js';

type SqlExecutor = {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
};

export type QueryExecutor = SqlExecutor & {
  // Drizzle node-postgres expose transaction() : la callback reçoit un exécuteur
  // lié au même client PG (BEGIN/COMMIT/ROLLBACK automatiques).
  transaction: <T>(callback: (tx: SqlExecutor) => Promise<T>) => Promise<T>;
};

// Forme brute renvoyée par PostgreSQL (snake_case).
// is_blocked, blocked_reason et blocked_at sont sur la table teachers.
// is_active est sur la table users (accès au compte).
type TeacherRow = {
  id: string;
  name: string;
  first_name: string;
  last_name: string;
  matricule: string | null;
  phone: string | null;
  email: string | null;
  type: 'vacataire' | 'permanent';
  subjects: string[];
  hourly_rate: number | null;
  monthly_salary: number | null;
  is_active: boolean;
  is_blocked: boolean;
  blocked_reason: string | null;
  blocked_at: Date | null;
  username: string;
  user_id: string;
  created_at: Date;
  updated_at: Date | null;
  updated_by: string | null;
  updated_by_name: string | null;
};

type TotalRow = { total: string | number };
type IdRow = { id: string };
type CountRow = { count: string | number };
type TeacherAttendanceStatsRow = {
  teacher_id: string;
  teacher_name: string;
  teacher_matricule: string | null;
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
        OR t.matricule ILIKE ${`%${query.search}%`}
      )`
    );
  }

  return where;
};

const makeWhereClause = (conditions: ReturnType<typeof sql>[]): ReturnType<typeof sql> => {
  if (conditions.length === 0) return sql``;
  return sql`WHERE ${sql.join(conditions, sql` AND `)}`;
};

// Fragment SELECT partagé - liste tous les champs utiles de teachers + users.
// Centralise la sélection pour éviter toute désynchronisation entre les méthodes.
const TEACHER_SELECT = sql`
  SELECT
    t.id,
    u.name,
    split_part(u.name, ' ', 1)                                               AS first_name,
    trim(substring(u.name FROM length(split_part(u.name, ' ', 1)) + 1))     AS last_name,
    t.matricule,
    u.phone,
    u.email,
    t.type::text                                                              AS type,
    t.subjects,
    t.hourly_rate,
    t.monthly_salary,
    u.is_active,
    t.is_blocked,
    t.blocked_reason,
    t.blocked_at,
    t.username,
    t.user_id,
    t.created_at,
    t.updated_at,
    t.updated_by::text AS updated_by,
    upd.name           AS updated_by_name
  FROM teachers t
  INNER JOIN users u ON u.id = t.user_id
  LEFT JOIN users upd ON upd.id = t.updated_by
`;

export class TeachersRepository {
  constructor(private readonly db: QueryExecutor) {}

  async countActiveUsers(): Promise<number> {
    const result = await this.db.execute(sql`
      SELECT COUNT(*) AS count
      FROM users
      WHERE is_active = true
        AND role = 'teacher'
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

  // Route dédiée - ne dépend pas du filtre is_active, retourne toujours le prof
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
    // Only load usernames with the same prefix to avoid loading entire table
    const normalizedLast = (input.last_name || 'user')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'user';
    const normalizedFirst = ((input.first_name || 'user')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'user').slice(0, 4);
    const baseUsername = `${normalizedLast}.${normalizedFirst}`;
    const existingUsernamesResult = await this.db.execute(sql`
      SELECT username FROM teachers WHERE username LIKE ${baseUsername + '%'}
    `);
    const existingUsernames = getRows<{ username: string }>(existingUsernamesResult).map(
      (row) => row.username
    );

    const username = generateUsername(input.last_name, input.first_name, existingUsernames);
    const configuredPassword = process.env.IMPORT_TEACHER_DEFAULT_PASSWORD?.trim();
    const password = configuredPassword && configuredPassword.length >= 8
      ? configuredPassword
      : generateInitialPassword(10);
    if (!configuredPassword || configuredPassword.length < 8) {
      logger.warn(
        '[teachers] IMPORT_TEACHER_DEFAULT_PASSWORD is missing or too short - generated a random 10-char password for teacher creation'
      );
    }
    const passwordHash = await argon2.hash(password);

    // Array littéral PG via sql.join paramétré (même pattern prouvé que
    // updateTeacher / seed.ts). Interpoler ${input.subjects} directement produit
    // un record `($1, $2)` rejeté par PG (`is of type record`) dès qu'il y a
    // plusieurs matières. Tableau vide => `ARRAY[]::text[]`, valide en PG.
    const subjectsLiteral = sql`ARRAY[${sql.join(
      input.subjects.map((s) => sql`${s}`),
      sql`, `
    )}]::text[]`;

    // Les deux INSERT (users puis teachers) DOIVENT être atomiques : sans
    // transaction, un échec sur l'INSERT teachers (ou matricule en doublon)
    // laissait un user orphelin dont le téléphone/email bloquait toute
    // recréation ultérieure via users_phone_unique / users_email_unique.
    const teacher = await this.db.transaction(async (tx) => {
      const userResult = await tx.execute(sql`
        INSERT INTO users (role, name, phone, email, password_hash, is_active, must_change_password)
        VALUES ('teacher', ${input.name}, ${input.phone}, ${input.email ?? null}, ${passwordHash}, true, true)
        RETURNING id
      `);

      const user = getRows<IdRow>(userResult)[0];
      if (!user) throw new Error('Failed to create teacher user');

      const teacherResult = await tx.execute(sql`
        INSERT INTO teachers (
          user_id,
          username,
          matricule,
          type,
          subjects,
          hourly_rate,
          monthly_salary,
          is_blocked
        )
        VALUES (
          ${user.id},
          ${username},
          ${input.matricule ?? null},
          ${input.type},
          ${subjectsLiteral},
          ${input.hourly_rate},
          ${input.monthly_salary},
          false
        )
        RETURNING id
      `);

      const created = getRows<IdRow>(teacherResult)[0];
      if (!created) throw new Error('Failed to create teacher');
      return created;
    });

    const created = await this.getTeacherById(teacher.id);
    if (!created) throw new Error('Failed to load created teacher');

    return created;
  }

  async updateTeacher(
    teacherId: string,
    input: UpdateTeacherInput,
    actorId?: string | null
  ): Promise<TeacherRow | null> {
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
        email     = ${input.email === undefined ? current.email : input.email},
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
      blockedAtSql = current.blocked_at === null ? sql`NULL` : sql`${current.blocked_at}`;
    }
    const subjectsArray = input.subjects ?? current.subjects ?? [];
    // Array littéral PG via sql.join paramétré (pattern prouvé : seed.ts /
    // attendance.repository). Chaque élément est un placeholder bindé - pas
    // d'échappement manuel de quotes, défense en profondeur vs SQLi.
    // Tableau vide => `ARRAY[]::text[]`, valide en PG.
    const subjectsLiteral = sql`ARRAY[${sql.join(
      subjectsArray.map((s) => sql`${s}`),
      sql`, `
    )}]::text[]`;
    // undefined = conserver la valeur courante ; null/valeur = écraser.
    const nextMatricule = input.matricule === undefined ? current.matricule : input.matricule;
    const matriculeSql = nextMatricule === null ? sql`NULL` : sql`${nextMatricule}`;
    const monthlySalaryVal = input.monthly_salary === undefined ? current.monthly_salary : input.monthly_salary;
    const hourlyRateVal = input.hourly_rate === undefined ? current.hourly_rate : input.hourly_rate;
    const monthlySalarySql = monthlySalaryVal === null ? sql`NULL` : sql`${monthlySalaryVal}`;
    const hourlyRateSql = hourlyRateVal === null ? sql`NULL` : sql`${hourlyRateVal}`;

    const updatedBySql = actorId ? sql`${actorId}::uuid` : sql`NULL`;

    await this.db.execute(sql`
      UPDATE teachers
      SET
        matricule      = ${matriculeSql},
        type           = ${input.type ?? current.type},
        subjects       = ${subjectsLiteral},
        hourly_rate    = ${hourlyRateSql},
        monthly_salary = ${monthlySalarySql},
        is_blocked     = ${nextIsBlocked},
        blocked_reason = ${blockedReasonSql},
        blocked_at     = ${blockedAtSql},
        updated_at     = NOW(),
        updated_by     = ${updatedBySql}
      WHERE id = ${teacherId}
    `);

    return this.getTeacherById(teacherId);
  }

  /**
   * Génère un nouveau mot de passe temporaire pour le prof, le hashe, met must_change_password=true.
   * Marque credentials_sent_at = NOW() pour indiquer que les credentials viennent d'être (re)générés.
   * Renvoie le mot de passe en clair + l'email du prof (pour transmission).
   * Renvoie null si le prof n'existe pas.
   */
  async resetTeacherPassword(teacherId: string): Promise<{
    plainPassword: string;
    email: string | null;
    fullName: string;
    username: string;
  } | null> {
    const current = await this.getTeacherById(teacherId);
    if (!current) return null;

    const plainPassword = generateInitialPassword(10);
    const passwordHash = await argon2.hash(plainPassword);

    await this.db.execute(sql`
      UPDATE users
      SET
        password_hash         = ${passwordHash},
        must_change_password  = true,
        credentials_sent_at   = NOW()
      WHERE id = ${current.user_id}
    `);

    return {
      plainPassword,
      email: current.email,
      fullName: current.name,
      username: current.username,
    };
  }

  /**
   * Renvoie la liste des profs sans credentials transmis (credentials_sent_at IS NULL),
   * filtrée optionnellement sur un sous-ensemble d'IDs.
   */
  async listTeachersWithoutCredentials(teacherIds?: string[]): Promise<Array<{
    teacher_id: string;
    user_id: string;
    name: string;
    email: string | null;
    username: string;
  }>> {
    type Row = {
      teacher_id: string;
      user_id: string;
      name: string;
      email: string | null;
      username: string;
    };

    // IN (...) via sql.join plutôt que ANY(${array}::uuid[]) : Drizzle éclate un
    // tableau JS en ($1, $2) dans un `sql` brut, ce qui fait échouer le cast en
    // uuid[] ("cannot cast type record to uuid[]").
    const idsFilter =
      teacherIds && teacherIds.length > 0
        ? sql`AND t.id IN (${sql.join(
            teacherIds.map((id) => sql`${id}::uuid`),
            sql`, `
          )})`
        : sql``;

    const result = await this.db.execute(sql`
      SELECT
        t.id::text AS teacher_id,
        u.id::text AS user_id,
        u.name,
        u.email,
        t.username
      FROM teachers t
      INNER JOIN users u ON u.id = t.user_id
      WHERE u.is_active = true
        AND u.credentials_sent_at IS NULL
        ${idsFilter}
    `);

    return getRows<Row>(result);
  }

  async hasOutstandingUnpaidSalaryRecords(teacherId: string): Promise<boolean> {
    const result = await this.db.execute(sql`
      SELECT 1 AS found
      FROM salary_records
      WHERE teacher_id = ${teacherId}
        AND status <> 'paid'::salary_status
        AND total_fcfa > 0
      LIMIT 1
    `);
    return getRows<{ found: number }>(result).length > 0;
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
      teacher_matricule: string | null;
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
          t.matricule AS teacher_matricule,
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
          AND (s.start_date IS NULL OR s.start_date <= d.date)
          AND (s.end_date IS NULL OR s.end_date > d.date)
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
        sc.teacher_matricule,
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
        COUNT(
          CASE
            WHEN rollcall.has_rollcall = true
              AND at.status IN ('present', 'late', 'excused')
            THEN 1
          END
        )::int AS rollcall_done_count,
        COUNT(
          CASE
            WHEN rollcall.has_rollcall IS DISTINCT FROM true
              AND at.status IN ('present', 'late', 'excused')
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
      GROUP BY sc.teacher_id, sc.teacher_name, sc.teacher_matricule, sc.teacher_type, sc.subjects
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
      teacher_matricule: row.teacher_matricule ?? null,
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
