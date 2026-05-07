import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { QueryResult, QueryResultRow } from 'pg';
import { ensureTenantRealHoursInfrastructure } from '../../shared/database/real-hours-infrastructure.js';

export type QueryExecutor = NodePgDatabase<Record<string, unknown>>;

export type SalaryRecordStatus = 'pending' | 'paid' | 'disputed' | 'nothing_to_pay';

type SalaryMetricRow = {
  teacher_id: string;
  teacher_name: string;
  teacher_type: 'vacataire' | 'permanent';
  hourly_rate: number | null;
  monthly_salary: number | null;
  hours_planned: string | number;
  hours_done: string | number;
  total_fcfa: string | number;
  salary_record_id: string | null;
  salary_status: SalaryRecordStatus | null;
  paid_at: string | null;
  paid_by: string | null;
  paid_by_name: string | null;
  hours_done_since_paid: string | number;
  paid_hours: string | number;
  paid_amount: string | number;
  paid_hours_before_paid_at: string | number;
  paid_amount_before_paid_at: string | number;
  paid_hours_after_paid_at: string | number;
  paid_amount_after_paid_at: string | number;
  notes: string | null;
};

type TeacherDetailsRow = {
  teacher_id: string;
  teacher_name: string;
  teacher_type: 'vacataire' | 'permanent';
  hourly_rate: number | null;
  monthly_salary: number | null;
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
  hours_done: string | number;
  attendance_status: 'present' | 'absent' | 'late' | 'excused' | null;
  checked_in_at: string | null;
  room_scan_end_at: string | null;
  late_minutes: number | null;
  room_mismatch: boolean | null;
  has_rollcall: boolean | null;
};

type SalaryRecordRow = {
  id: string;
  teacher_id: string;
  // 'vacataire' | 'permanent' — champ canonique pour la logique métier
  teacher_type: 'vacataire' | 'permanent';
  period_month: string;
  hours_planned: string | number;
  hours_done: string | number;
  // hourly_rate peut être 0 pour un vacataire non encore paramétré,
  // ne jamais l'utiliser pour détecter le type
  hourly_rate: number;
  total_fcfa: number;
  status: SalaryRecordStatus;
  paid_at: string | null;
  paid_by: string | null;
  notes: string | null;
  created_at: string;
};

type SalaryPaymentHistoryRow = {
  payment_id: string;
  record_id: string;
  period_month: string;
  hours_paid: string | number | null;
  amount_fcfa: number;
  status: SalaryRecordStatus;
  paid_at: string | null;
  paid_by: string | null;
  paid_by_name: string | null;
  notes: string | null;
};

type SalaryPaymentsSummaryRow = {
  paid_hours: string | number;
  paid_amount: string | number;
  payments_count: string | number;
  last_paid_at: string | null;
};

type PastUnpaidSalaryAlertRow = {
  period_month: string;
  records_count: string | number;
  total_remaining_fcfa: string | number;
};

type SalaryPaymentRow = {
  id: string;
  salary_record_id: string;
  hours_paid: string | number | null;
  amount_fcfa: number;
  paid_at: string;
  paid_by: string;
  paid_by_name: string | null;
  notes: string | null;
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
    await ensureTenantRealHoursInfrastructure(this.db);

    const result = await this.db.execute<SalaryMetricRow>(sql`
      WITH feature_flags AS (
        SELECT COALESCE(f.use_real_hours, false) AS use_real_hours
        FROM public.tenants t
        LEFT JOIN public.school_sms_features f ON f.tenant_id = t.id
        WHERE t.schema_name = current_schema()
        LIMIT 1
      ),
      month_days AS (
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
          ON md.d BETWEEN sp.valid_from AND sp.valid_to
        INNER JOIN schedules s
          ON s.schedule_period_id = sp.id
         AND s.is_active = true
         AND (s.end_date IS NULL OR s.end_date > md.d)
         AND s.day_of_week = EXTRACT(ISODOW FROM md.d)::int
        INNER JOIN time_slots ts ON ts.id = s.time_slot_id
        GROUP BY s.teacher_id
      ),
      done_hours AS (
        SELECT
          s.teacher_id,
          COALESCE(
            SUM(
              CASE
                WHEN at.validation_status = 'approved' THEN COALESCE(at.validated_hours, 0)
                WHEN at.validation_status IN ('pending', 'rejected') THEN 0
                WHEN COALESCE((SELECT use_real_hours FROM feature_flags), false)
                  AND at.actual_minutes IS NOT NULL
                  THEN at.actual_minutes / 60.0
                ELSE EXTRACT(EPOCH FROM (ts.end_time - ts.start_time)) / 3600.0
              END
            ),
            0
          )::numeric(8,2) AS hours_done
        FROM attendances_teacher at
        INNER JOIN schedules s ON s.id = at.schedule_id
        INNER JOIN time_slots ts ON ts.id = s.time_slot_id
        WHERE at.date BETWEEN ${monthStart}::date AND ${monthEnd}::date
          AND at.status IN ('present', 'late', 'excused')
        GROUP BY s.teacher_id
      )
      SELECT
        t.id AS teacher_id,
        u.name AS teacher_name,
        t.type::text AS teacher_type,
        t.hourly_rate,
        t.monthly_salary,
        COALESCE(p.hours_planned, 0)::numeric(8,2) AS hours_planned,
        COALESCE(dh.hours_done, 0)::numeric(8,2) AS hours_done,
        CASE
          WHEN t.hourly_rate IS NULL THEN 0
          ELSE ROUND(COALESCE(dh.hours_done, 0) * t.hourly_rate)::int
        END AS total_fcfa,
        sr.id AS salary_record_id,
        sr.status::text AS salary_status,
        sr.paid_at::text AS paid_at,
        sr.paid_by,
        up.name AS paid_by_name,
        COALESCE(done_after_payment.hours_done_since_paid, 0)::numeric(8,2) AS hours_done_since_paid,
        COALESCE(payments_summary.paid_hours, 0)::numeric(8,2) AS paid_hours,
        COALESCE(payments_summary.paid_amount, 0)::int AS paid_amount,
        COALESCE(payments_before_cutoff.paid_hours, 0)::numeric(8,2) AS paid_hours_before_paid_at,
        COALESCE(payments_before_cutoff.paid_amount, 0)::int AS paid_amount_before_paid_at,
        COALESCE(payments_after_cutoff.paid_hours, 0)::numeric(8,2) AS paid_hours_after_paid_at,
        COALESCE(payments_after_cutoff.paid_amount, 0)::int AS paid_amount_after_paid_at,
        sr.notes
      FROM teachers t
      INNER JOIN users u ON u.id = t.user_id
      LEFT JOIN planned p ON p.teacher_id = t.id
      LEFT JOIN done_hours dh ON dh.teacher_id = t.id
      LEFT JOIN salary_records sr
        ON sr.teacher_id = t.id
       AND sr.period_month = ${monthStart}::date
      LEFT JOIN users up ON up.id = sr.paid_by
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(
            SUM(
              CASE
                WHEN at.validation_status = 'approved' THEN COALESCE(at.validated_hours, 0)
                WHEN at.validation_status IN ('pending', 'rejected') THEN 0
                WHEN COALESCE((SELECT use_real_hours FROM feature_flags), false)
                  AND at.actual_minutes IS NOT NULL
                  THEN at.actual_minutes / 60.0
                ELSE EXTRACT(EPOCH FROM (ts.end_time - ts.start_time)) / 3600.0
              END
            ),
            0
          )::numeric(8,2) AS hours_done_since_paid
        FROM attendances_teacher at
        INNER JOIN schedules s ON s.id = at.schedule_id
        INNER JOIN time_slots ts ON ts.id = s.time_slot_id
        WHERE sr.id IS NOT NULL
          AND sr.paid_at IS NOT NULL
          AND at.teacher_id = t.id
          AND at.date BETWEEN ${monthStart}::date AND ${monthEnd}::date
          AND at.status IN ('present', 'late', 'excused')
          AND ((at.date::timestamp + ts.end_time)::timestamptz > sr.paid_at)
      ) done_after_payment ON true
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(
            SUM(sp.hours_paid),
            0
          )::numeric(8,2) AS paid_hours,
          COALESCE(SUM(sp.amount_fcfa), 0)::int AS paid_amount
        FROM salary_payments sp
        WHERE sr.id IS NOT NULL
          AND sp.salary_record_id = sr.id
      ) payments_summary ON true
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(SUM(sp.hours_paid), 0)::numeric(8,2) AS paid_hours,
          COALESCE(SUM(sp.amount_fcfa), 0)::int AS paid_amount
        FROM salary_payments sp
        WHERE sr.id IS NOT NULL
          AND sr.paid_at IS NOT NULL
          AND sp.salary_record_id = sr.id
          AND sp.paid_at <= sr.paid_at
      ) payments_before_cutoff ON true
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(SUM(sp.hours_paid), 0)::numeric(8,2) AS paid_hours,
          COALESCE(SUM(sp.amount_fcfa), 0)::int AS paid_amount
        FROM salary_payments sp
        WHERE sr.id IS NOT NULL
          AND sr.paid_at IS NOT NULL
          AND sp.salary_record_id = sr.id
          AND sp.paid_at > sr.paid_at
      ) payments_after_cutoff ON true
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
        t.hourly_rate,
        t.monthly_salary
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
    await ensureTenantRealHoursInfrastructure(this.db);

    const result = await this.db.execute<TeacherDailyRow>(sql`
      WITH feature_flags AS (
        SELECT COALESCE(f.use_real_hours, false) AS use_real_hours
        FROM public.tenants t
        LEFT JOIN public.school_sms_features f ON f.tenant_id = t.id
        WHERE t.schema_name = current_schema()
        LIMIT 1
      ),
      month_days AS (
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
        COALESCE(at.checked_out_at, at.room_scan_end_at)::text AS room_scan_end_at,
        CASE
          WHEN at.validation_status = 'approved' THEN COALESCE(at.validated_hours, 0)::numeric(8,2)
          WHEN at.validation_status IN ('pending', 'rejected') THEN 0::numeric(8,2)
          WHEN COALESCE((SELECT use_real_hours FROM feature_flags), false)
            AND at.actual_minutes IS NOT NULL
            THEN (at.actual_minutes / 60.0)::numeric(8,2)
          ELSE (EXTRACT(EPOCH FROM (ts.end_time - ts.start_time)) / 3600.0)::numeric(8,2)
        END AS hours_done,
        at.late_minutes,
        at.room_mismatch,
        rollcall.has_rollcall
      FROM month_days md
      INNER JOIN schedule_periods sp
        ON md.d BETWEEN sp.valid_from AND sp.valid_to
      INNER JOIN schedules s
        ON s.schedule_period_id = sp.id
       AND s.is_active = true
       AND (s.end_date IS NULL OR s.end_date > md.d)
       AND s.day_of_week = EXTRACT(ISODOW FROM md.d)::int
       AND s.teacher_id = ${teacherId}
      INNER JOIN classes c ON c.id = s.class_id
      INNER JOIN time_slots ts ON ts.id = s.time_slot_id
      LEFT JOIN attendances_teacher at
        ON at.schedule_id = s.id
       AND at.teacher_id = s.teacher_id
       AND at.date = md.d
      LEFT JOIN LATERAL (
        SELECT true AS has_rollcall
        FROM attendances_student ast
        WHERE ast.schedule_id = s.id
          AND ast.date = md.d
        LIMIT 1
      ) rollcall ON true
      ORDER BY md.d ASC, ts.start_time ASC
    `);

    return getRows(result);
  }

  async getSalaryRecordById(recordId: string): Promise<SalaryRecordRow | null> {
    //JOIN teachers pour récupérer teacher_type de façon fiable
    const result = await this.db.execute<SalaryRecordRow>(sql`
      SELECT
        sr.id,
        sr.teacher_id,
        -- teacher_type provient de la table teachers, pas de salary_records.
        -- C'est la source de vérité pour la logique de paiement.
        t.type::text AS teacher_type,
        sr.period_month::text,
        sr.hours_planned,
        sr.hours_done,
        sr.hourly_rate,
        sr.total_fcfa,
        sr.status::text,
        sr.paid_at::text,
        sr.paid_by,
        sr.notes,
        sr.created_at::text
      FROM salary_records sr
      -- On joint teachers pour avoir le type canonique du prof,
      -- indépendamment de hourly_rate qui peut valoir 0
      INNER JOIN teachers t ON t.id = sr.teacher_id
      WHERE sr.id = ${recordId}
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

  async hasSalaryStatusValue(status: SalaryRecordStatus): Promise<boolean> {
    const result = await this.db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
        FROM pg_type t
        INNER JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typname = 'salary_status'
          AND t.typnamespace = current_schema()::regnamespace
          AND e.enumlabel = ${status}
      ) AS exists
    `);

    return result.rows[0]?.exists === true;
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
        paid_at = CASE WHEN ${input.status === 'paid'} THEN NOW() ELSE paid_at END,
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

  async listTeacherPaymentHistory(
    teacherId: string,
    limit: number
  ): Promise<SalaryPaymentHistoryRow[]> {
    const result = await this.db.execute<SalaryPaymentHistoryRow>(sql`
      WITH explicit_payments AS (
        SELECT
          sp.id::text AS payment_id,
          sr.id AS record_id,
          sr.period_month::text AS period_month,
          sp.hours_paid,
          sp.amount_fcfa,
          'paid'::text AS status,
          sr.status::text AS record_status,
          sp.paid_at AS paid_at_ts,
          sp.paid_at::text AS paid_at,
          sr.paid_at AS salary_paid_at_ts,
          sp.paid_by,
          up.name AS paid_by_name,
          sp.notes
        FROM salary_payments sp
        INNER JOIN salary_records sr ON sr.id = sp.salary_record_id
        LEFT JOIN users up ON up.id = sp.paid_by
        WHERE sr.teacher_id = ${teacherId}
      ),
      explicit_agg AS (
        SELECT
          record_id,
          COALESCE(SUM(hours_paid), 0)::numeric(8,2) AS paid_hours,
          COALESCE(SUM(amount_fcfa), 0)::int AS paid_amount,
          COALESCE(SUM(hours_paid) FILTER (WHERE paid_at_ts <= salary_paid_at_ts), 0)::numeric(8,2) AS paid_hours_before_cutoff,
          COALESCE(SUM(amount_fcfa) FILTER (WHERE paid_at_ts <= salary_paid_at_ts), 0)::int AS paid_amount_before_cutoff
        FROM explicit_payments
        GROUP BY record_id
      ),
      inferred_legacy_records AS (
        SELECT
          ('legacy-inferred-' || sr.id::text) AS payment_id,
          sr.id AS record_id,
          sr.period_month::text AS period_month,
          CASE
            WHEN sr.hourly_rate > 0
              THEN GREATEST(
                0::numeric,
                sr.hours_done
                - COALESCE(done_after_payment.hours_done_since_paid, 0::numeric)
                - COALESCE(explicit_agg.paid_hours_before_cutoff, 0::numeric)
              )
            ELSE NULL::numeric
          END AS hours_paid,
          CASE
            WHEN sr.hourly_rate > 0
              THEN ROUND(
                GREATEST(
                  0::numeric,
                  sr.hours_done
                  - COALESCE(done_after_payment.hours_done_since_paid, 0::numeric)
                  - COALESCE(explicit_agg.paid_hours_before_cutoff, 0::numeric)
                ) * sr.hourly_rate
              )::int
            WHEN sr.status = 'paid'
              THEN GREATEST(0, sr.total_fcfa - COALESCE(explicit_agg.paid_amount_before_cutoff, 0))
            ELSE 0
          END AS amount_fcfa,
          sr.status::text AS status,
          sr.paid_at::text AS paid_at,
          sr.paid_by,
          up.name AS paid_by_name,
          sr.notes
        FROM salary_records sr
        LEFT JOIN users up ON up.id = sr.paid_by
        LEFT JOIN explicit_agg ON explicit_agg.record_id = sr.id
        LEFT JOIN LATERAL (
          SELECT
            COALESCE(
              SUM(EXTRACT(EPOCH FROM (ts.end_time - ts.start_time)) / 3600.0),
              0
            )::numeric(8,2) AS hours_done_since_paid
          FROM attendances_teacher at
          INNER JOIN schedules s ON s.id = at.schedule_id
          INNER JOIN time_slots ts ON ts.id = s.time_slot_id
          WHERE sr.paid_at IS NOT NULL
            AND at.teacher_id = sr.teacher_id
            AND at.date BETWEEN sr.period_month AND (date_trunc('month', sr.period_month) + interval '1 month - 1 day')::date
            AND at.status IN ('present', 'late', 'excused')
            AND ((at.date::timestamp + ts.end_time)::timestamptz > sr.paid_at)
        ) done_after_payment ON true
        WHERE sr.teacher_id = ${teacherId}
          AND sr.paid_at IS NOT NULL
          AND (
            (
              sr.hourly_rate > 0
              AND GREATEST(
                0::numeric,
                sr.hours_done
                - COALESCE(done_after_payment.hours_done_since_paid, 0::numeric)
                - COALESCE(explicit_agg.paid_hours_before_cutoff, 0::numeric)
              ) > 0
            )
            OR (
              sr.hourly_rate <= 0
              AND sr.status = 'paid'
              AND GREATEST(0, sr.total_fcfa - COALESCE(explicit_agg.paid_amount_before_cutoff, 0)) > 0
            )
          )
      )
      SELECT
        payment_id,
        record_id,
        period_month,
        hours_paid,
        amount_fcfa,
        status,
        paid_at,
        paid_by,
        paid_by_name,
        notes
      FROM (
        SELECT
          payment_id,
          record_id,
          period_month,
          hours_paid,
          amount_fcfa,
          status,
          paid_at,
          paid_by,
          paid_by_name,
          notes
        FROM explicit_payments
        UNION ALL
        SELECT
          payment_id,
          record_id,
          period_month,
          hours_paid,
          amount_fcfa,
          status,
          paid_at,
          paid_by,
          paid_by_name,
          notes
        FROM inferred_legacy_records
      ) payments
      ORDER BY paid_at DESC NULLS LAST
      LIMIT ${limit}
    `);

    return getRows(result);
  }

  async getSalaryPaymentsSummary(recordId: string): Promise<SalaryPaymentsSummaryRow> {
    const result = await this.db.execute<SalaryPaymentsSummaryRow>(sql`
      SELECT
        COALESCE(SUM(hours_paid), 0)::numeric(8,2) AS paid_hours,
        COALESCE(SUM(amount_fcfa), 0)::int AS paid_amount,
        COUNT(*)::int AS payments_count,
        MAX(paid_at)::text AS last_paid_at
      FROM salary_payments
      WHERE salary_record_id = ${recordId}
    `);

    return (
      getRows(result)[0] ?? {
        paid_hours: 0,
        paid_amount: 0,
        payments_count: 0,
        last_paid_at: null,
      }
    );
  }

  async createSalaryPayment(input: {
    recordId: string;
    hoursPaid: number | null;
    amountFcfa: number;
    paidBy: string;
    notes?: string;
  }): Promise<SalaryPaymentRow> {
    const result = await this.db.execute<SalaryPaymentRow>(sql`
      INSERT INTO salary_payments (
        salary_record_id,
        hours_paid,
        amount_fcfa,
        notes,
        paid_by
      )
      VALUES (
        ${input.recordId},
        ${input.hoursPaid}::numeric,
        ${input.amountFcfa},
        ${input.notes ?? null},
        ${input.paidBy}
      )
      RETURNING
        id,
        salary_record_id,
        hours_paid,
        amount_fcfa,
        paid_at::text,
        paid_by,
        notes,
        NULL::text AS paid_by_name
    `);

    const row = getRows(result)[0];
    if (!row) {
      throw new Error('Failed to create salary payment');
    }

    return row;
  }

  async listPaymentsForRecord(recordId: string): Promise<SalaryPaymentRow[]> {
    const result = await this.db.execute<SalaryPaymentRow>(sql`
      SELECT
        sp.id,
        sp.salary_record_id,
        sp.hours_paid,
        sp.amount_fcfa,
        sp.paid_at::text,
        sp.paid_by,
        up.name AS paid_by_name,
        sp.notes
      FROM salary_payments sp
      LEFT JOIN users up ON up.id = sp.paid_by
      WHERE sp.salary_record_id = ${recordId}
      ORDER BY sp.paid_at DESC
    `);

    return getRows(result);
  }

  async updateSalaryRecordAfterPayment(input: {
    recordId: string;
    status: SalaryRecordStatus;
    notes?: string;
    paidBy?: string;
    touchPaidAt?: boolean;
  }): Promise<SalaryRecordRow | null> {
    const result = await this.db.execute<SalaryRecordRow>(sql`
      UPDATE salary_records
      SET
        status = ${input.status}::salary_status,
        notes = CASE WHEN ${input.notes !== undefined} THEN ${input.notes ?? null} ELSE notes END,
        paid_at = CASE WHEN ${input.touchPaidAt ?? true} THEN NOW() ELSE paid_at END,
        paid_by = CASE WHEN ${input.touchPaidAt ?? true} THEN ${input.paidBy ?? null}::uuid ELSE paid_by END
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

  async listTeacherSalaryRecordsInRange(input: {
    teacherId: string;
    periodFrom: string;
    periodTo: string;
  }): Promise<Array<{ id: string; period_month: string }>> {
    const result = await this.db.execute<{ id: string; period_month: string }>(sql`
      SELECT id, period_month::text
      FROM salary_records sr
      WHERE sr.teacher_id = ${input.teacherId}
        AND sr.period_month BETWEEN ${input.periodFrom}::date AND ${input.periodTo}::date
      ORDER BY sr.period_month ASC
    `);

    return getRows(result);
  }

  async listPastUnpaidSalaryAlerts(beforeMonthStart: string): Promise<PastUnpaidSalaryAlertRow[]> {
    const result = await this.db.execute<PastUnpaidSalaryAlertRow>(sql`
      WITH payments AS (
        SELECT
          salary_record_id,
          COALESCE(SUM(amount_fcfa), 0)::int AS paid_amount
        FROM salary_payments
        GROUP BY salary_record_id
      )
      SELECT
        sr.period_month::text AS period_month,
        COUNT(*)::int AS records_count,
        SUM(GREATEST(sr.total_fcfa - COALESCE(payments.paid_amount, 0), 0))::int AS total_remaining_fcfa
      FROM salary_records sr
      LEFT JOIN payments ON payments.salary_record_id = sr.id
      WHERE sr.period_month < ${beforeMonthStart}::date
        AND sr.status::text <> 'nothing_to_pay'
        AND (
          sr.status <> 'paid'::salary_status
          OR GREATEST(sr.total_fcfa - COALESCE(payments.paid_amount, 0), 0) > 0
        )
      GROUP BY sr.period_month
      HAVING SUM(GREATEST(sr.total_fcfa - COALESCE(payments.paid_amount, 0), 0)) > 0
      ORDER BY sr.period_month ASC
    `);

    return getRows(result);
  }

  static toNumber(value: string | number): number {
    return toNumber(value);
  }
}
