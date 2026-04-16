import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { QueryResult, QueryResultRow } from 'pg';

export type QueryExecutor = NodePgDatabase<Record<string, unknown>>;

export type SalaryRecordStatus = 'pending' | 'paid' | 'disputed';

type SalaryMetricRow = {
  teacher_id: string;
  teacher_name: string;
  teacher_type: 'vacataire' | 'permanent';
  hourly_rate: number | null;
  hours_planned: string | number;
  hours_done: string | number;
  total_fcfa: string | number;
  salary_record_id: string | null;
  salary_status: SalaryRecordStatus | null;
  paid_at: string | null;
  notes: string | null;
};

type TeacherDetailsRow = {
  teacher_id: string;
  teacher_name: string;
  teacher_type: 'vacataire' | 'permanent';
  hourly_rate: number | null;
};

type TeacherDailyRow = {
  date: string;
  schedule_id: string;
  class_name: string;
  subject: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  slot_label: string;
  hours_planned: string | number;
  attendance_status: 'present' | 'absent' | 'late' | 'excused' | null;
  checked_in_at: string | null;
  late_minutes: number | null;
};

type SalaryRecordRow = {
  id: string;
  teacher_id: string;
  period_month: string;
  hours_planned: string | number;
  hours_done: string | number;
  hourly_rate: number;
  total_fcfa: number;
  status: SalaryRecordStatus;
  paid_at: string | null;
  paid_by: string | null;
  notes: string | null;
  created_at: string;
};

type IdRow = { id: string };

type CountRow = { count: string | number };

const getRows = <TRow extends QueryResultRow>(result: QueryResult<TRow>): TRow[] => result.rows;

const toNumber = (value: string | number): number => {
  if (typeof value === 'number') {
    return value;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export class BillingRepository {
  constructor(private readonly db: QueryExecutor) {}

  async listTeacherMonthlyMetrics(monthStart: string, monthEnd: string): Promise<SalaryMetricRow[]> {
    const result = await this.db.execute<SalaryMetricRow>(sql`
      WITH month_days AS (
        SELECT generate_series(${monthStart}::date, ${monthEnd}::date, interval '1 day')::date AS d
      ),
      planned AS (
        SELECT
          s.teacher_id,
          COALESCE(
            SUM(EXTRACT(EPOCH FROM (ts.end_time - ts.start_time)) / 3600.0),
            0
          )::numeric(8,2) AS hours_planned
        FROM month_days md
        INNER JOIN schedule_periods sp
          ON sp.is_active = true
         AND md.d BETWEEN sp.valid_from AND sp.valid_to
        INNER JOIN schedules s
          ON s.schedule_period_id = sp.id
         AND s.is_active = true
         AND s.day_of_week = EXTRACT(ISODOW FROM md.d)::int
        INNER JOIN time_slots ts ON ts.id = s.time_slot_id
        GROUP BY s.teacher_id
      ),
      done_hours AS (
        SELECT
          s.teacher_id,
          COALESCE(
            SUM(EXTRACT(EPOCH FROM (ts.end_time - ts.start_time)) / 3600.0),
            0
          )::numeric(8,2) AS hours_done
        FROM attendances_teacher at
        INNER JOIN schedules s ON s.id = at.schedule_id
        INNER JOIN time_slots ts ON ts.id = s.time_slot_id
        WHERE at.date BETWEEN ${monthStart}::date AND ${monthEnd}::date
          AND at.status IN ('present', 'late')
        GROUP BY s.teacher_id
      )
      SELECT
        t.id AS teacher_id,
        u.name AS teacher_name,
        t.type::text AS teacher_type,
        t.hourly_rate,
        COALESCE(p.hours_planned, 0)::numeric(8,2) AS hours_planned,
        COALESCE(dh.hours_done, 0)::numeric(8,2) AS hours_done,
        CASE
          WHEN t.hourly_rate IS NULL THEN 0
          ELSE ROUND(COALESCE(dh.hours_done, 0) * t.hourly_rate)::int
        END AS total_fcfa,
        sr.id AS salary_record_id,
        sr.status::text AS salary_status,
        sr.paid_at::text AS paid_at,
        sr.notes
      FROM teachers t
      INNER JOIN users u ON u.id = t.user_id
      LEFT JOIN planned p ON p.teacher_id = t.id
      LEFT JOIN done_hours dh ON dh.teacher_id = t.id
      LEFT JOIN salary_records sr
        ON sr.teacher_id = t.id
       AND sr.period_month = ${monthStart}::date
      WHERE u.is_active = true
      ORDER BY u.name ASC
    `);

    return getRows(result);
  }

  async findTeacherById(teacherId: string): Promise<TeacherDetailsRow | null> {
    const result = await this.db.execute<TeacherDetailsRow>(sql`
      SELECT
        t.id AS teacher_id,
        u.name AS teacher_name,
        t.type::text AS teacher_type,
        t.hourly_rate
      FROM teachers t
      INNER JOIN users u ON u.id = t.user_id
      WHERE t.id = ${teacherId}
      LIMIT 1
    `);

    return getRows(result)[0] ?? null;
  }

  async listTeacherDailyBreakdown(
    teacherId: string,
    monthStart: string,
    monthEnd: string
  ): Promise<TeacherDailyRow[]> {
    const result = await this.db.execute<TeacherDailyRow>(sql`
      WITH month_days AS (
        SELECT generate_series(${monthStart}::date, ${monthEnd}::date, interval '1 day')::date AS d
      )
      SELECT
        md.d::text AS date,
        s.id AS schedule_id,
        c.name AS class_name,
        s.subject,
        s.day_of_week,
        ts.start_time::text AS start_time,
        ts.end_time::text AS end_time,
        ts.label AS slot_label,
        (EXTRACT(EPOCH FROM (ts.end_time - ts.start_time)) / 3600.0)::numeric(8,2) AS hours_planned,
        at.status::text AS attendance_status,
        at.checked_in_at::text,
        at.late_minutes
      FROM month_days md
      INNER JOIN schedule_periods sp
        ON sp.is_active = true
       AND md.d BETWEEN sp.valid_from AND sp.valid_to
      INNER JOIN schedules s
        ON s.schedule_period_id = sp.id
       AND s.is_active = true
       AND s.day_of_week = EXTRACT(ISODOW FROM md.d)::int
       AND s.teacher_id = ${teacherId}
      INNER JOIN classes c ON c.id = s.class_id
      INNER JOIN time_slots ts ON ts.id = s.time_slot_id
      LEFT JOIN attendances_teacher at
        ON at.schedule_id = s.id
       AND at.teacher_id = s.teacher_id
       AND at.date = md.d
      ORDER BY md.d ASC, ts.start_time ASC
    `);

    return getRows(result);
  }

  async getSalaryRecordById(recordId: string): Promise<SalaryRecordRow | null> {
    const result = await this.db.execute<SalaryRecordRow>(sql`
      SELECT
        id,
        teacher_id,
        period_month::text,
        hours_planned,
        hours_done,
        hourly_rate,
        total_fcfa,
        status::text,
        paid_at::text,
        paid_by,
        notes,
        created_at::text
      FROM salary_records
      WHERE id = ${recordId}
      LIMIT 1
    `);

    return getRows(result)[0] ?? null;
  }

  async countPaidRecords(monthStart: string): Promise<number> {
    const result = await this.db.execute<CountRow>(sql`
      SELECT COUNT(*)::int AS count
      FROM salary_records
      WHERE period_month = ${monthStart}::date
        AND status = 'paid'
    `);

    return toNumber(getRows(result)[0]?.count ?? 0);
  }

  async upsertSalaryRecord(input: {
    teacherId: string;
    periodMonth: string;
    hoursPlanned: number;
    hoursDone: number;
    hourlyRate: number;
    totalFcfa: number;
    status: SalaryRecordStatus;
    notes: string | null;
  }): Promise<SalaryRecordRow> {
    const result = await this.db.execute<SalaryRecordRow>(sql`
      INSERT INTO salary_records (
        teacher_id,
        period_month,
        hours_planned,
        hours_done,
        hourly_rate,
        total_fcfa,
        status,
        notes
      )
      VALUES (
        ${input.teacherId},
        ${input.periodMonth}::date,
        ${input.hoursPlanned}::numeric,
        ${input.hoursDone}::numeric,
        ${input.hourlyRate},
        ${input.totalFcfa},
        ${input.status}::salary_status,
        ${input.notes}
      )
      ON CONFLICT (teacher_id, period_month)
      DO UPDATE SET
        hours_planned = EXCLUDED.hours_planned,
        hours_done = EXCLUDED.hours_done,
        hourly_rate = EXCLUDED.hourly_rate,
        total_fcfa = EXCLUDED.total_fcfa,
        status = CASE
          WHEN salary_records.status = 'disputed' THEN 'disputed'::salary_status
          ELSE EXCLUDED.status
        END,
        notes = COALESCE(EXCLUDED.notes, salary_records.notes)
      RETURNING
        id,
        teacher_id,
        period_month::text,
        hours_planned,
        hours_done,
        hourly_rate,
        total_fcfa,
        status::text,
        paid_at::text,
        paid_by,
        notes,
        created_at::text
    `);

    const row = getRows(result)[0];
    if (!row) {
      throw new Error('Failed to upsert salary record');
    }

    return row;
  }

  async updateSalaryStatus(input: {
    recordId: string;
    status: 'paid' | 'disputed';
    notes?: string;
    paidBy?: string;
  }): Promise<SalaryRecordRow | null> {
    const result = await this.db.execute<SalaryRecordRow>(sql`
      UPDATE salary_records
      SET
        status = ${input.status}::salary_status,
        notes = CASE WHEN ${input.notes !== undefined} THEN ${input.notes ?? null} ELSE notes END,
        paid_at = CASE WHEN ${input.status === 'paid'} THEN NOW() ELSE NULL END,
        paid_by = CASE WHEN ${input.status === 'paid'} THEN ${input.paidBy ?? null}::uuid ELSE NULL END
      WHERE id = ${input.recordId}
      RETURNING
        id,
        teacher_id,
        period_month::text,
        hours_planned,
        hours_done,
        hourly_rate,
        total_fcfa,
        status::text,
        paid_at::text,
        paid_by,
        notes,
        created_at::text
    `);

    return getRows(result)[0] ?? null;
  }

  async findJobRecordExists(recordId: string): Promise<boolean> {
    const result = await this.db.execute<IdRow>(sql`
      SELECT id
      FROM salary_records
      WHERE id = ${recordId}
      LIMIT 1
    `);

    return getRows(result).length > 0;
  }

  static toNumber(value: string | number): number {
    return toNumber(value);
  }
}
