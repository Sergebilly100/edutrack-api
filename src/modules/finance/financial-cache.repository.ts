import { sql } from 'drizzle-orm';

import type { TenantDb } from '../../shared/database/db.js';

type Rows<T> = { rows?: T[] };

const getRows = <T>(result: unknown): T[] => {
  if (typeof result !== 'object' || result === null || !('rows' in result)) {
    return [];
  }
  const rows = (result as Rows<T>).rows;
  return Array.isArray(rows) ? rows : [];
};

const toNumber = (value: string | number | null | undefined): number => {
  if (typeof value === 'number') return value;
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

export type StudentFinancialSnapshot = {
  studentId: string;
  classId: string | null;
  expectedToDate: number;
  paidConfirmed: number;
  waivedAmount: number;
  totalDueYear: number;
  earliestOverdueStepDueDate: string | null;
};

export class FinancialCacheRepository {
  constructor(readonly db: TenantDb) {}

  async getActiveSchoolYearId(): Promise<string | null> {
    const result = await this.db.execute<{ id: string }>(sql`
      SELECT id::text FROM school_years WHERE status = 'active' LIMIT 1
    `);
    return getRows<{ id: string }>(result)[0]?.id ?? null;
  }

  /**
   * Snapshot financier par élève pour une année, en une seule requête
   * (performance : pas de N+1 à 1000 élèves).
   */
  async listStudentFinancialSnapshots(schoolYearId: string): Promise<StudentFinancialSnapshot[]> {
    const result = await this.db.execute<{
      student_id: string;
      class_id: string | null;
      expected_to_date: string;
      paid_confirmed: string;
      waived_amount: string;
      total_due_year: string;
      earliest_overdue_step_due_date: string | null;
    }>(sql`
      WITH scope AS (
        SELECT s.id AS student_id,
               COALESCE(e.class_id, s.class_id) AS class_id,
               tp.total_amount AS plan_total,
               sto.override_total_amount,
               sto.discount_amount
        FROM students s
        LEFT JOIN enrollments e
          ON e.student_id = s.id AND e.school_year_id = ${schoolYearId}::uuid
        INNER JOIN classes c
          ON c.id = COALESCE(e.class_id, s.class_id)
         AND c.school_year_id = ${schoolYearId}::uuid AND c.is_active = true
        LEFT JOIN tuition_plans tp
          ON tp.level_id = c.level_id AND tp.school_year_id = ${schoolYearId}::uuid
        LEFT JOIN student_tuition_overrides sto
          ON sto.student_id = s.id AND sto.school_year_id = ${schoolYearId}::uuid
        WHERE s.is_active = true
      ),
      coverage AS (
        SELECT student_id, school_year_id,
               COALESCE(SUM(amount) FILTER (WHERE status = 'confirmed'), 0) AS paid_confirmed,
               COALESCE(SUM(amount) FILTER (WHERE status = 'waived_by_school'), 0) AS waived_amount
        FROM payments
        WHERE school_year_id = ${schoolYearId}::uuid
          AND status IN ('confirmed', 'waived_by_school')
        GROUP BY student_id, school_year_id
      )
      SELECT scope.student_id::text,
             scope.class_id::text AS class_id,
             COALESCE(steps.expected_to_date, 0)::text AS expected_to_date,
             COALESCE(cov.paid_confirmed, 0)::text AS paid_confirmed,
             COALESCE(cov.waived_amount, 0)::text AS waived_amount,
             COALESCE(GREATEST(
               COALESCE(scope.override_total_amount, scope.plan_total + COALESCE(scope.discount_amount, 0), 0),
               0
             ), 0)::text AS total_due_year,
             steps.earliest_overdue_step_due_date::text AS earliest_overdue_step_due_date
      FROM scope
      LEFT JOIN coverage cov
        ON cov.student_id = scope.student_id AND cov.school_year_id = ${schoolYearId}::uuid
      LEFT JOIN LATERAL (
        SELECT MAX(tss.cumulative_amount_expected) FILTER (WHERE tss.due_date <= CURRENT_DATE) AS expected_to_date,
               MIN(tss.due_date) FILTER (WHERE tss.due_date <= CURRENT_DATE) AS earliest_overdue_step_due_date
        FROM tuition_schedule_steps tss
        INNER JOIN tuition_plans tp2 ON tp2.id = tss.tuition_plan_id
        INNER JOIN classes c2 ON c2.level_id = tp2.level_id AND c2.id = scope.class_id
        WHERE tp2.school_year_id = ${schoolYearId}::uuid
      ) steps ON true
    `);

    return getRows<{
      student_id: string;
      class_id: string | null;
      expected_to_date: string;
      paid_confirmed: string;
      waived_amount: string;
      total_due_year: string;
      earliest_overdue_step_due_date: string | null;
    }>(result).map((row) => ({
      studentId: row.student_id,
      classId: row.class_id,
      expectedToDate: toNumber(row.expected_to_date),
      paidConfirmed: toNumber(row.paid_confirmed),
      waivedAmount: toNumber(row.waived_amount),
      totalDueYear: toNumber(row.total_due_year),
      earliestOverdueStepDueDate: row.earliest_overdue_step_due_date,
    }));
  }

  /** Version ciblée d'un seul élève (recalcul immédiat après paiement). */
  async listStudentFinancialSnapshotSingle(
    studentId: string,
    schoolYearId: string
  ): Promise<StudentFinancialSnapshot[]> {
    // Le calcul par lot est déjà borné par les index ; on réutilise la même
    // logique SQL filtrée sur un élève pour garantir des chiffres identiques.
    const all = await this.listStudentFinancialSnapshots(schoolYearId);
    return all.filter((snapshot) => snapshot.studentId === studentId);
  }

  async upsertStudentStatuses(
    schoolYearId: string,
    rows: Array<{
      studentId: string;
      expectedToDate: number;
      paidConfirmed: number;
      waivedAmount: number;
      totalDueYear: number;
      status: 'up_to_date' | 'late' | 'waived';
      daysLate: number | null;
      earliestOverdueStepDueDate: string | null;
    }>
  ): Promise<void> {
    for (const row of rows) {
      await this.db.execute(sql`
        INSERT INTO student_financial_status (
          student_id, school_year_id, total_expected_to_date, total_paid,
          waived_amount, total_due_year, status, days_late,
          earliest_overdue_step_due_date, last_computed_at
        ) VALUES (
          ${row.studentId}::uuid, ${schoolYearId}::uuid, ${row.expectedToDate}, ${row.paidConfirmed},
          ${row.waivedAmount}, ${row.totalDueYear}, ${row.status}::financial_cache_status,
          ${row.daysLate}, ${row.earliestOverdueStepDueDate ?? null}::date, NOW()
        )
        ON CONFLICT ("student_id", "school_year_id") DO UPDATE SET
          total_expected_to_date = EXCLUDED.total_expected_to_date,
          total_paid = EXCLUDED.total_paid,
          waived_amount = EXCLUDED.waived_amount,
          total_due_year = EXCLUDED.total_due_year,
          status = EXCLUDED.status,
          days_late = EXCLUDED.days_late,
          earliest_overdue_step_due_date = EXCLUDED.earliest_overdue_step_due_date,
          last_computed_at = NOW()
      `);
    }
  }

  async refreshClassSummaries(schoolYearId: string): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO class_financial_summary (
        class_id, school_year_id, total_expected_to_date, total_paid,
        students_up_to_date_count, students_late_count, last_computed_at
      )
      SELECT s.class_id,
             sfs.school_year_id,
             SUM(sfs.total_expected_to_date),
             SUM(sfs.total_paid),
             COUNT(*) FILTER (WHERE sfs.status = 'up_to_date'),
             COUNT(*) FILTER (WHERE sfs.status <> 'up_to_date'),
             NOW()
      FROM student_financial_status sfs
      INNER JOIN students s ON s.id = sfs.student_id AND s.is_active = true
      WHERE sfs.school_year_id = ${schoolYearId}::uuid
      GROUP BY s.class_id, sfs.school_year_id
      ON CONFLICT ("class_id", "school_year_id") DO UPDATE SET
        total_expected_to_date = EXCLUDED.total_expected_to_date,
        total_paid = EXCLUDED.total_paid,
        students_up_to_date_count = EXCLUDED.students_up_to_date_count,
        students_late_count = EXCLUDED.students_late_count,
        last_computed_at = NOW()
    `);
  }

  async refreshSchoolSummary(schoolYearId: string): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO school_financial_summary (
        school_year_id, total_expected_to_date, total_paid, recovery_rate,
        students_up_to_date_count, students_late_count, previous_period_total_paid, last_computed_at
      )
      SELECT sfs.school_year_id,
             SUM(sfs.total_expected_to_date),
             SUM(sfs.total_paid),
             CASE WHEN SUM(sfs.total_expected_to_date) > 0
                  THEN LEAST(1, SUM(sfs.total_paid) / SUM(sfs.total_expected_to_date))
                  ELSE 1 END,
             COUNT(*) FILTER (WHERE sfs.status = 'up_to_date'),
             COUNT(*) FILTER (WHERE sfs.status <> 'up_to_date'),
             COALESCE((
               SELECT SUM(p.amount) FROM payments p
               WHERE p.school_year_id = sfs.school_year_id
                 AND p.status = 'confirmed'
                 AND p.payment_date >= date_trunc('month', CURRENT_DATE) - INTERVAL '1 month'
                 AND p.payment_date < date_trunc('month', CURRENT_DATE)
             ), 0),
             NOW()
      FROM student_financial_status sfs
      WHERE sfs.school_year_id = ${schoolYearId}::uuid
      GROUP BY sfs.school_year_id
      ON CONFLICT ("school_year_id") DO UPDATE SET
        total_expected_to_date = EXCLUDED.total_expected_to_date,
        total_paid = EXCLUDED.total_paid,
        recovery_rate = EXCLUDED.recovery_rate,
        students_up_to_date_count = EXCLUDED.students_up_to_date_count,
        students_late_count = EXCLUDED.students_late_count,
        previous_period_total_paid = EXCLUDED.previous_period_total_paid,
        last_computed_at = NOW()
    `);
  }

  async getSchoolSummary(schoolYearId: string) {
    const result = await this.db.execute<Record<string, string | number>>(sql`
      SELECT total_expected_to_date::text, total_paid::text, recovery_rate::text,
             students_up_to_date_count, students_late_count,
             previous_period_total_paid::text, last_computed_at::text
      FROM school_financial_summary WHERE school_year_id = ${schoolYearId}::uuid LIMIT 1
    `);
    return getRows(result)[0] ?? null;
  }

  async listClassSummaries(schoolYearId: string) {
    const result = await this.db.execute<Record<string, string | number>>(sql`
      SELECT cfs.class_id::text, c.name AS class_name,
             c.level_id::text AS level_id, l.name AS level_name,
             cfs.total_expected_to_date::text, cfs.total_paid::text,
             cfs.students_up_to_date_count, cfs.students_late_count, cfs.last_computed_at::text
      FROM class_financial_summary cfs
      INNER JOIN classes c ON c.id = cfs.class_id
      INNER JOIN levels l ON l.id = c.level_id
      WHERE cfs.school_year_id = ${schoolYearId}::uuid
      ORDER BY c.name ASC
    `);
    return getRows(result);
  }

  /** Agrégat de pilotage : plusieurs classes peuvent appartenir au même niveau. */
  async listLevelSummaries(schoolYearId: string) {
    const result = await this.db.execute<Record<string, string | number>>(sql`
      SELECT l.id::text AS level_id,
             l.name AS level_name,
             SUM(cfs.total_expected_to_date)::text AS total_expected_to_date,
             SUM(cfs.total_paid)::text AS total_paid,
             SUM(cfs.students_up_to_date_count)::int AS students_up_to_date_count,
             SUM(cfs.students_late_count)::int AS students_late_count,
             MAX(cfs.last_computed_at)::text AS last_computed_at
      FROM class_financial_summary cfs
      INNER JOIN classes c ON c.id = cfs.class_id
      INNER JOIN levels l ON l.id = c.level_id
      WHERE cfs.school_year_id = ${schoolYearId}::uuid
      GROUP BY l.id, l.name, l.order_index
      ORDER BY l.order_index ASC, l.name ASC
    `);
    return getRows(result);
  }

  async listCollectionTrend(schoolYearId: string) {
    const result = await this.db.execute<Record<string, string | number>>(sql`
      WITH months AS (
        SELECT generate_series(
          date_trunc('month', CURRENT_DATE) - INTERVAL '5 months',
          date_trunc('month', CURRENT_DATE),
          INTERVAL '1 month'
        )::date AS month_start
      )
      SELECT to_char(months.month_start, 'YYYY-MM') AS month_key,
             COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'confirmed'), 0)::text AS total_paid
      FROM months
      LEFT JOIN payments p
        ON date_trunc('month', p.payment_date) = months.month_start
       AND p.school_year_id = ${schoolYearId}::uuid
      GROUP BY months.month_start
      ORDER BY months.month_start ASC
    `);
    return getRows(result);
  }

  async listPaymentMethodSummaries(schoolYearId: string) {
    const result = await this.db.execute<Record<string, string | number>>(sql`
      SELECT method::text AS method,
             COALESCE(SUM(amount) FILTER (WHERE status = 'confirmed'), 0)::text AS total_paid,
             COUNT(*) FILTER (WHERE status = 'confirmed')::int AS payment_count
      FROM payments
      WHERE school_year_id = ${schoolYearId}::uuid
      GROUP BY method
      ORDER BY total_paid DESC, method ASC
    `);
    return getRows(result);
  }

  async listUpcomingInstallments(schoolYearId: string) {
    const result = await this.db.execute<Record<string, string | number>>(sql`
      WITH step_amounts AS (
        SELECT tss.tuition_plan_id,
               tss.due_date,
               GREATEST(
                 tss.cumulative_amount_expected - COALESCE(
                   LAG(tss.cumulative_amount_expected) OVER (
                     PARTITION BY tss.tuition_plan_id ORDER BY tss.due_date
                   ), 0
                 ), 0
               ) AS installment_amount
        FROM tuition_schedule_steps tss
        INNER JOIN tuition_plans tp ON tp.id = tss.tuition_plan_id
        WHERE tp.school_year_id = ${schoolYearId}::uuid
      )
      SELECT sa.due_date::text AS due_date,
             COALESCE(SUM(sa.installment_amount * enrolled.student_count), 0)::text AS expected_amount,
             COALESCE(SUM(enrolled.student_count), 0)::int AS student_count
      FROM step_amounts sa
      INNER JOIN tuition_plans tp ON tp.id = sa.tuition_plan_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS student_count
        FROM students s
        INNER JOIN classes c ON c.id = s.class_id
        WHERE s.is_active = true
          AND c.is_active = true
          AND c.school_year_id = ${schoolYearId}::uuid
          AND c.level_id = tp.level_id
      ) enrolled ON true
      WHERE sa.due_date >= CURRENT_DATE
      GROUP BY sa.due_date
      ORDER BY sa.due_date ASC
      LIMIT 3
    `);
    return getRows(result);
  }

  async listRecentPayments(schoolYearId: string) {
    const result = await this.db.execute<Record<string, string | number | null>>(sql`
      SELECT p.payment_date::text AS payment_date,
             concat_ws(' ', s.first_name, s.last_name) AS student_name,
             c.name AS class_name,
             p.method::text AS method,
             p.amount::text AS amount,
             p.receipt_number
      FROM payments p
      INNER JOIN students s ON s.id = p.student_id
      LEFT JOIN classes c ON c.id = s.class_id
      WHERE p.school_year_id = ${schoolYearId}::uuid
        AND p.status = 'confirmed'
      ORDER BY p.payment_date DESC, p.created_at DESC
      LIMIT 5
    `);
    return getRows(result);
  }

  async getStudentCachedStatus(studentId: string, schoolYearId: string) {
    const result = await this.db.execute<Record<string, string | number>>(sql`
      SELECT total_expected_to_date::text, total_paid::text, waived_amount::text,
             total_due_year::text, status::text, days_late, last_computed_at::text
      FROM student_financial_status
      WHERE student_id = ${studentId}::uuid AND school_year_id = ${schoolYearId}::uuid
      LIMIT 1
    `);
    return getRows(result)[0] ?? null;
  }

  /** Drill-down classe : statut caché de chaque élève actif, trié par retard. */
  async listClassStudentStatuses(classId: string, schoolYearId: string) {
    const result = await this.db.execute<{
      student_id: string;
      full_name: string;
      matricule: string | null;
      total_expected_to_date: string;
      total_paid: string;
      total_due_year: string;
      status: string;
      days_late: number | null;
    }>(sql`
      SELECT s.id::text,
             concat_ws(' ', s.first_name, s.last_name) AS full_name,
             s.matricule,
             sfs.total_expected_to_date::text,
             sfs.total_paid::text,
             sfs.total_due_year::text,
             sfs.status::text,
             sfs.days_late
      FROM students s
      INNER JOIN student_financial_status sfs ON sfs.student_id = s.id
        AND sfs.school_year_id = ${schoolYearId}::uuid
      WHERE s.class_id = ${classId}::uuid AND s.is_active = true
      ORDER BY CASE sfs.status WHEN 'late' THEN 0 ELSE 1 END,
               sfs.days_late DESC NULLS LAST,
               s.last_name ASC
    `);
    return getRows(result);
  }
}
