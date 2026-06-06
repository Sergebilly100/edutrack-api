import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { QueryResult, QueryResultRow } from 'pg';
import { db as publicDb } from '../../shared/database/db.js';
import { toNumber } from '../../shared/utils/numbers.js';

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
  attendance_status: 'present' | 'absent' | 'late' | null;
  checked_in_at: string | null;
  room_scan_end_at: string | null;
  late_minutes: number | null;
  room_mismatch: boolean | null;
  has_rollcall: boolean | null;
};

type SalaryRecordRow = {
  id: string;
  teacher_id: string;
  // 'vacataire' | 'permanent' - champ canonique pour la logique métier
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
  paid_by_role: string | null;
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
  paid_by_role: string | null;
  notes: string | null;
};

type IdRow = { id: string };

type CountRow = { count: string | number };

const getRows = <TRow extends QueryResultRow>(result: QueryResult<TRow>): TRow[] => result.rows;



export class BillingRepository {
  constructor(private readonly db: QueryExecutor) {}

  async listTeacherMonthlyMetrics(monthStart: string, monthEnd: string, teacherId?: string): Promise<SalaryMetricRow[]> {

    const result = await this.db.execute<SalaryMetricRow>(sql`
      -- CTE 1: Récupère le flag use_real_hours depuis public.school_sms_features
      -- Ce flag détermine si on utilise actual_minutes (durée réelle mesurée) ou la durée planifiée du créneau
      WITH feature_flags AS (
        SELECT COALESCE(f.use_real_hours, false) AS use_real_hours
        FROM public.tenants t
        LEFT JOIN public.school_sms_features f ON f.tenant_id = t.id
        WHERE t.schema_name = current_schema()
        LIMIT 1
      ),

      -- CTE 2: Génère une série de dates pour le mois ciblé (ex: 2026-04-01 à 2026-04-30)
      month_days AS (
        SELECT generate_series(${monthStart}::date, ${monthEnd}::date, interval '1 day')::date AS d
      ),

      -- CTE 3: Calcule les heures PLANIFIÉES en croisant l'EDT (schedules + schedule_periods) avec les créneaux (time_slots)
      -- On somme la durée de tous les créneaux prévus dans le mois pour chaque professeur
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

      -- CTE 4: Calcule les heures EFFECTUÉES (hours_done) selon 3 priorités :
      --   1. Si validation_status='approved' → utiliser validated_hours (validation manuelle directeur)
      --   2. Si validation_status IN ('pending','rejected') → 0 (heures rejetées ou en attente = pas comptabilisées)
      --   3. Si use_real_hours=true ET actual_minutes valide → utiliser actual_minutes / 60
      --   4. Sinon → utiliser la durée planifiée du créneau (fallback)
      -- Seules les présences avec status IN ('present', 'late', 'excused') sont comptées
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
                  -- Validation: actual_minutes doit être dans [0, 1440]
                  -- La contrainte DB le garantit, mais on ajoute une sécurité supplémentaire
                  AND at.actual_minutes >= 0
                  AND at.actual_minutes <= 1440
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

      -- SELECT principal : agrège les données de tous les professeurs avec leurs métriques de salaire
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

      -- LATERAL JOIN 1: hours_done_since_paid
      -- Calcule les heures effectuées APRÈS le dernier paiement (sr.paid_at)
      -- Utilisé pour les vacataires avec paiements partiels : permet de savoir combien d'heures ont été faites depuis le dernier versement
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(
            SUM(
              CASE
                WHEN at.validation_status = 'approved' THEN COALESCE(at.validated_hours, 0)
                WHEN at.validation_status IN ('pending', 'rejected') THEN 0
                WHEN COALESCE((SELECT use_real_hours FROM feature_flags), false)
                  AND at.actual_minutes IS NOT NULL
                  AND at.actual_minutes >= 0
                  AND at.actual_minutes <= 1440
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
          AND ((at.date::timestamp + ts.end_time)::timestamp > sr.paid_at)
      ) done_after_payment ON true

      -- LATERAL JOIN 2: payments_summary
      -- Somme tous les paiements effectués via salary_payments pour ce salary_record
      -- Permet de gérer les paiements partiels (vacataires) : un prof peut être payé en plusieurs fois
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

      -- LATERAL JOIN 3: payments_before_cutoff
      -- Paiements effectués AVANT ou À la date de sr.paid_at
      -- Utilisé pour réconcilier les anciens enregistrements legacy (avant introduction de salary_payments)
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

      -- LATERAL JOIN 4: payments_after_cutoff
      -- Paiements effectués APRÈS la date de sr.paid_at
      -- Permet de tracker les paiements partiels ultérieurs
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

      -- Filtres : on ne retourne que les professeurs actifs
      -- Si teacherId fourni, on filtre sur ce prof uniquement
      WHERE u.is_active = true
        ${teacherId ? sql`AND t.id = ${teacherId}` : sql``}
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
            AND at.actual_minutes >= 0
            AND at.actual_minutes <= 1440
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
        -- Préserver hourly_rate, total_fcfa et status pour les salaires déjà payés (historique)
        hourly_rate = CASE
          WHEN salary_records.status = 'paid' THEN salary_records.hourly_rate
          ELSE EXCLUDED.hourly_rate
        END,
        total_fcfa = CASE
          WHEN salary_records.status = 'paid' THEN salary_records.total_fcfa
          ELSE EXCLUDED.total_fcfa
        END,
        status = CASE
          WHEN salary_records.status = 'disputed' THEN 'disputed'::salary_status
          WHEN salary_records.status = 'paid' THEN 'paid'::salary_status
          ELSE EXCLUDED.status
        END,
        notes = COALESCE(EXCLUDED.notes, salary_records.notes),
        updated_at = NOW()
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

  async batchUpsertSalaryRecords(records: Array<{
    teacherId: string;
    periodMonth: string;
    hoursPlanned: number;
    hoursDone: number;
    hourlyRate: number;
    totalFcfa: number;
    status: SalaryRecordStatus;
    notes: string | null;
  }>): Promise<number> {
    if (records.length === 0) return 0;

    const values = sql.join(
      records.map(
        (r) =>
          sql`(${r.teacherId}, ${r.periodMonth}::date, ${r.hoursPlanned}::numeric, ${r.hoursDone}::numeric, ${r.hourlyRate}, ${r.totalFcfa}, ${r.status}::salary_status, ${r.notes})`
      ),
      sql`, `
    );

    const result = await this.db.execute(sql`
      INSERT INTO salary_records (
        teacher_id, period_month, hours_planned, hours_done, hourly_rate, total_fcfa, status, notes
      )
      VALUES ${values}
      ON CONFLICT (teacher_id, period_month)
      DO UPDATE SET
        hours_planned = EXCLUDED.hours_planned,
        hours_done = EXCLUDED.hours_done,
        hourly_rate = CASE
          WHEN salary_records.status = 'paid' THEN salary_records.hourly_rate
          ELSE EXCLUDED.hourly_rate
        END,
        total_fcfa = CASE
          WHEN salary_records.status = 'paid' THEN salary_records.total_fcfa
          ELSE EXCLUDED.total_fcfa
        END,
        status = CASE
          WHEN salary_records.status = 'disputed' THEN 'disputed'::salary_status
          WHEN salary_records.status = 'paid' THEN 'paid'::salary_status
          ELSE EXCLUDED.status
        END,
        notes = COALESCE(EXCLUDED.notes, salary_records.notes),
        updated_at = NOW()
    `);

    return (result as QueryResult).rowCount ?? records.length;
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
        paid_by = CASE WHEN ${input.status === 'paid'} THEN ${input.paidBy ?? null}::uuid ELSE NULL END,
        updated_at = NOW()
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
    limit: number,
    offset = 0
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
          (
            SELECT p.name
            FROM position_assignments pa
            INNER JOIN admin_positions p ON p.id = pa.position_id
            WHERE pa.user_id = sp.paid_by
            ORDER BY pa.created_at DESC
            LIMIT 1
          ) AS paid_by_role,
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
          'paid'::text AS status,
          sr.paid_at::text AS paid_at,
          sr.paid_by,
          up.name AS paid_by_name,
          (
            SELECT p.name
            FROM position_assignments pa
            INNER JOIN admin_positions p ON p.id = pa.position_id
            WHERE pa.user_id = sr.paid_by
            ORDER BY pa.created_at DESC
            LIMIT 1
          ) AS paid_by_role,
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
            AND ((at.date::timestamp + ts.end_time)::timestamp > sr.paid_at)
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
        paid_by_role,
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
          paid_by_role,
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
          paid_by_role,
          notes
        FROM inferred_legacy_records
      ) payments
      ORDER BY paid_at DESC NULLS LAST
      LIMIT ${limit}
      OFFSET ${offset}
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

  /**
   * Effectue un paiement partiel de vacataire de manière atomique avec SELECT FOR UPDATE.
   * Prévient les race conditions lors de paiements simultanés.
   *
   * @returns Le salary_record mis à jour avec son nouveau statut
   */
  async createVacatairePartialPaymentAtomic(input: {
    recordId: string;
    requestedHours: number;
    hourlyRate: number;
    paidBy: string;
    notes?: string;
  }): Promise<{
    record: SalaryRecordRow;
    payment: SalaryPaymentRow;
    paidHoursBefore: number;
    remainingHoursBefore: number;
  }> {
    // Utiliser une transaction pour garantir l'atomicité
    const result = await this.db.execute<{
      record_id: string;
      teacher_id: string;
      teacher_type: 'vacataire' | 'permanent';
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
      payment_id: string;
      payment_hours_paid: string | number;
      payment_amount_fcfa: number;
      payment_paid_at: string;
      paid_hours_before: string | number;
      remaining_hours_before: string | number;
    }>(sql`
      WITH locked_record AS (
        -- Verrouiller le record pour éviter les modifications concurrentes
        SELECT
          sr.id,
          sr.teacher_id,
          t.type::text AS teacher_type,
          sr.period_month,
          sr.hours_planned,
          sr.hours_done,
          sr.hourly_rate,
          sr.total_fcfa,
          sr.status,
          sr.paid_at,
          sr.paid_by,
          sr.notes,
          sr.created_at
        FROM salary_records sr
        INNER JOIN teachers t ON t.id = sr.teacher_id
        WHERE sr.id = ${input.recordId}
        FOR UPDATE
      ),
      current_payments AS (
        -- Calculer le total déjà payé APRÈS le verrouillage
        SELECT
          COALESCE(SUM(hours_paid), 0)::numeric AS paid_hours,
          COALESCE(SUM(amount_fcfa), 0)::int AS paid_amount
        FROM salary_payments
        WHERE salary_record_id = ${input.recordId}
      ),
      validation AS (
        -- Valider que les heures restantes sont suffisantes
        SELECT
          lr.*,
          cp.paid_hours,
          cp.paid_amount,
          GREATEST(0, lr.hours_done - cp.paid_hours)::numeric AS remaining_hours
        FROM locked_record lr
        CROSS JOIN current_payments cp
      ),
      new_payment AS (
        -- Créer le paiement uniquement si validation OK
        INSERT INTO salary_payments (
          salary_record_id,
          hours_paid,
          amount_fcfa,
          notes,
          paid_by
        )
        SELECT
          v.id,
          ${input.requestedHours}::numeric,
          ROUND(${input.requestedHours}::numeric * ${input.hourlyRate})::int,
          ${input.notes ?? null},
          ${input.paidBy}
        FROM validation v
        WHERE v.remaining_hours >= ${input.requestedHours}::numeric
        RETURNING id, salary_record_id, hours_paid, amount_fcfa, paid_at, paid_by, notes
      ),
      updated_record AS (
        -- Mettre à jour le status du salary_record
        UPDATE salary_records
        SET
          status = CASE
            WHEN (
              SELECT v.paid_hours + ${input.requestedHours}::numeric >= v.hours_done
              FROM validation v
            ) THEN 'paid'::salary_status
            ELSE 'pending'::salary_status
          END,
          paid_at = CASE
            WHEN (
              SELECT v.paid_hours + ${input.requestedHours}::numeric >= v.hours_done
              FROM validation v
            ) THEN NOW()
            ELSE paid_at
          END,
          paid_by = CASE
            WHEN (
              SELECT v.paid_hours + ${input.requestedHours}::numeric >= v.hours_done
              FROM validation v
            ) THEN ${input.paidBy}::uuid
            ELSE paid_by
          END,
          notes = COALESCE(${input.notes ?? null}, notes),
          updated_at = NOW()
        WHERE id = ${input.recordId}
          AND EXISTS (SELECT 1 FROM new_payment)
        RETURNING id, teacher_id, period_month, hours_planned, hours_done, hourly_rate, total_fcfa, status, paid_at, paid_by, notes, created_at
      )
      SELECT
        ur.id AS record_id,
        ur.teacher_id,
        v.teacher_type,
        ur.period_month::text,
        ur.hours_planned,
        ur.hours_done,
        ur.hourly_rate,
        ur.total_fcfa,
        ur.status::text,
        ur.paid_at::text,
        ur.paid_by,
        ur.notes,
        ur.created_at::text,
        np.id AS payment_id,
        np.hours_paid AS payment_hours_paid,
        np.amount_fcfa AS payment_amount_fcfa,
        np.paid_at::text AS payment_paid_at,
        v.paid_hours AS paid_hours_before,
        v.remaining_hours AS remaining_hours_before
      FROM updated_record ur
      CROSS JOIN new_payment np
      CROSS JOIN validation v
    `);

    const row = getRows(result)[0];
    if (!row) {
      throw new Error('Payment failed: insufficient remaining hours or record not found');
    }

    return {
      record: {
        id: row.record_id,
        teacher_id: row.teacher_id,
        teacher_type: row.teacher_type,
        period_month: row.period_month,
        hours_planned: row.hours_planned,
        hours_done: row.hours_done,
        hourly_rate: row.hourly_rate,
        total_fcfa: row.total_fcfa,
        status: row.status,
        paid_at: row.paid_at,
        paid_by: row.paid_by,
        notes: row.notes,
        created_at: row.created_at,
      },
      payment: {
        id: row.payment_id,
        salary_record_id: row.record_id,
        hours_paid: row.payment_hours_paid,
        amount_fcfa: row.payment_amount_fcfa,
        paid_at: row.payment_paid_at,
        paid_by: input.paidBy,
        paid_by_name: null,
        paid_by_role: null,
        notes: input.notes ?? null,
      },
      paidHoursBefore: toNumber(row.paid_hours_before),
      remainingHoursBefore: toNumber(row.remaining_hours_before),
    };
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
        (
          SELECT p.name
          FROM position_assignments pa
          INNER JOIN admin_positions p ON p.id = pa.position_id
          WHERE pa.user_id = sp.paid_by
          ORDER BY pa.created_at DESC
          LIMIT 1
        ) AS paid_by_role,
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
        paid_by = CASE WHEN ${input.touchPaidAt ?? true} THEN ${input.paidBy ?? null}::uuid ELSE paid_by END,
        updated_at = NOW()
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

  async auditSalaryAction(params: {
    schemaName: string;
    actorId: string;
    actorRole: string;
    action: 'salary.mark_paid' | 'salary.mark_disputed';
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  }): Promise<void> {
    const actorResult = await this.db.execute<{ actor_name: string | null; actor_position: string | null }>(sql`
      SELECT
        u.name AS actor_name,
        (
          SELECT p.name
          FROM position_assignments pa
          INNER JOIN admin_positions p ON p.id = pa.position_id
          WHERE pa.user_id = u.id
          ORDER BY pa.created_at DESC
          LIMIT 1
        ) AS actor_position
      FROM users u
      WHERE u.id = ${params.actorId}::uuid
      LIMIT 1
    `);
    const actor = actorResult.rows[0] ?? { actor_name: null, actor_position: null };

    await publicDb.execute(sql`
      INSERT INTO public.audit_financial_events (
        tenant_id,
        actor_id,
        actor_role,
        action,
        payload_before,
        payload_after
      )
      SELECT
        t.id,
        ${params.actorId}::uuid,
        ${actor.actor_position ?? params.actorRole},
        ${params.action},
        ${JSON.stringify(params.before)}::jsonb,
        ${JSON.stringify({
          ...params.after,
          actorName: actor.actor_name,
          actorRole: actor.actor_position ?? params.actorRole,
        })}::jsonb
      FROM public.tenants t
      WHERE t.schema_name = ${params.schemaName}
      LIMIT 1
    `);
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
          COALESCE(SUM(amount_fcfa), 0)::int AS paid_amount,
          COALESCE(SUM(hours_paid), 0)::numeric AS paid_hours,
          COUNT(*) AS payments_count
        FROM salary_payments
        GROUP BY salary_record_id
      ),
      -- Un enregistrement legacy est un salary_record avec paid_at défini
      -- mais sans aucune entrée dans salary_payments (créé avant la table salary_payments).
      -- Il est considéré entièrement soldé : montant restant = 0.
      record_remaining AS (
        SELECT
          sr.id,
          sr.period_month,
          sr.status,
          CASE
            WHEN sr.paid_at IS NOT NULL AND COALESCE(payments.payments_count, 0) = 0
              THEN 0
            ELSE GREATEST(sr.total_fcfa - COALESCE(payments.paid_amount, 0), 0)
          END AS remaining_fcfa
        FROM salary_records sr
        LEFT JOIN payments ON payments.salary_record_id = sr.id
        WHERE sr.period_month < ${beforeMonthStart}::date
          AND sr.status::text <> 'nothing_to_pay'
      )
      SELECT
        period_month::text AS period_month,
        COUNT(*)::int AS records_count,
        SUM(remaining_fcfa)::int AS total_remaining_fcfa
      FROM record_remaining
      -- Une fiche 'paid' est soldée par décision du directeur : le reliquat
      -- théorique (ex: vacataire payé à l'heure effectuée) n'est PAS une dette.
      -- Seules les fiches 'pending'/'disputed' avec un restant > 0 sont des impayés.
      WHERE status IN ('pending'::salary_status, 'disputed'::salary_status)
        AND remaining_fcfa > 0
      GROUP BY period_month
      HAVING SUM(remaining_fcfa) > 0
      ORDER BY period_month ASC
    `);

    return getRows(result);
  }

  async getLastComputedDate(monthStart: string): Promise<string | null> {
    const result = await this.db.execute<{ last_computed: string | null }>(sql`
      SELECT GREATEST(MAX(updated_at), MAX(created_at))::text AS last_computed
      FROM salary_records
      WHERE period_month = ${monthStart}::date
    `);

    return getRows(result)[0]?.last_computed ?? null;
  }

  static toNumber(value: string | number): number {
    return toNumber(value);
  }
}
