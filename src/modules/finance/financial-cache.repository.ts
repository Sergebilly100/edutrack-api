import { sql } from 'drizzle-orm';

import type { TenantDb } from '../../shared/database/db.js';
import { confirmedFinancialStudent } from './finance-scope.js';

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
      total_due_year: string;
      earliest_overdue_step_due_date: string | null;
    }>(sql`
      WITH scope AS (
        SELECT s.id AS student_id,
               e.class_id AS class_id,
               tp.total_amount AS plan_total,
               sto.override_total_amount,
               sto.discount_amount
        FROM students s
        INNER JOIN enrollments e
          ON e.student_id = s.id AND e.school_year_id = ${schoolYearId}::uuid
         AND e.status = 'confirmed'
        INNER JOIN classes c
          ON c.id = e.class_id
         AND c.school_year_id = ${schoolYearId}::uuid AND c.is_active = true
        LEFT JOIN tuition_plans tp
          ON tp.level_id = c.level_id AND tp.school_year_id = ${schoolYearId}::uuid
        LEFT JOIN student_tuition_overrides sto
          ON sto.student_id = s.id AND sto.school_year_id = ${schoolYearId}::uuid
        WHERE s.is_active = true
      ),
      coverage AS (
        SELECT student_id, school_year_id,
               COALESCE(SUM(amount), 0) AS paid_confirmed
        FROM payments
        WHERE school_year_id = ${schoolYearId}::uuid
          AND status = 'confirmed'
        GROUP BY student_id, school_year_id
      )
      SELECT scope.student_id::text,
             scope.class_id::text AS class_id,
             CASE WHEN custom_steps.step_count > 0
               THEN COALESCE(custom_steps.expected_to_date, 0)
               ELSE COALESCE(plan_steps.expected_to_date, 0)
             END::text AS expected_to_date,
             COALESCE(cov.paid_confirmed, 0)::text AS paid_confirmed,
             COALESCE(GREATEST(
               COALESCE(scope.override_total_amount, scope.plan_total - COALESCE(scope.discount_amount, 0), 0),
               0
             ), 0)::text AS total_due_year,
             CASE WHEN custom_steps.step_count > 0
               THEN custom_steps.earliest_overdue_step_due_date
               ELSE plan_steps.earliest_overdue_step_due_date
             END::text AS earliest_overdue_step_due_date
      FROM scope
      LEFT JOIN coverage cov
        ON cov.student_id = scope.student_id AND cov.school_year_id = ${schoolYearId}::uuid
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS step_count,
               MAX(stss.cumulative_amount_expected) FILTER (WHERE stss.due_date <= CURRENT_DATE) AS expected_to_date,
               MIN(stss.due_date) FILTER (WHERE stss.due_date <= CURRENT_DATE) AS earliest_overdue_step_due_date
        FROM student_tuition_schedule_steps stss
        INNER JOIN student_tuition_schedule_agreements agreement ON agreement.id = stss.agreement_id
        WHERE agreement.student_id = scope.student_id
          AND agreement.school_year_id = ${schoolYearId}::uuid
      ) custom_steps ON true
      LEFT JOIN LATERAL (
        SELECT MAX(tss.cumulative_amount_expected) FILTER (WHERE tss.due_date <= CURRENT_DATE) AS expected_to_date,
               MIN(tss.due_date) FILTER (WHERE tss.due_date <= CURRENT_DATE) AS earliest_overdue_step_due_date
        FROM tuition_schedule_steps tss
        INNER JOIN tuition_plans tp2 ON tp2.id = tss.tuition_plan_id
        INNER JOIN classes c2 ON c2.level_id = tp2.level_id AND c2.id = scope.class_id
        WHERE tp2.school_year_id = ${schoolYearId}::uuid
      ) plan_steps ON true
    `);

    return getRows<{
      student_id: string;
      class_id: string | null;
      expected_to_date: string;
      paid_confirmed: string;
      total_due_year: string;
      earliest_overdue_step_due_date: string | null;
    }>(result).map((row) => ({
      studentId: row.student_id,
      classId: row.class_id,
      expectedToDate: toNumber(row.expected_to_date),
      paidConfirmed: toNumber(row.paid_confirmed),
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
      totalDueYear: number;
      status: 'up_to_date' | 'late';
      daysLate: number | null;
      earliestOverdueStepDueDate: string | null;
    }>
  ): Promise<void> {
    for (const row of rows) {
      await this.db.execute(sql`
        INSERT INTO student_financial_status (
          student_id, school_year_id, total_expected_to_date, total_paid,
          total_due_year, status, days_late,
          earliest_overdue_step_due_date, last_computed_at
        ) VALUES (
          ${row.studentId}::uuid, ${schoolYearId}::uuid, ${row.expectedToDate}, ${row.paidConfirmed},
          ${row.totalDueYear}, ${row.status}::financial_cache_status,
          ${row.daysLate}, ${row.earliestOverdueStepDueDate ?? null}::date, NOW()
        )
        ON CONFLICT ("student_id", "school_year_id") DO UPDATE SET
          total_expected_to_date = EXCLUDED.total_expected_to_date,
          total_paid = EXCLUDED.total_paid,
          total_due_year = EXCLUDED.total_due_year,
          status = EXCLUDED.status,
          days_late = EXCLUDED.days_late,
          earliest_overdue_step_due_date = EXCLUDED.earliest_overdue_step_due_date,
          last_computed_at = NOW()
      `);
    }
  }

  async pruneOutOfScope(schoolYearId: string): Promise<void> {
    await this.db.execute(sql`
      DELETE FROM student_financial_status sfs
      WHERE sfs.school_year_id = ${schoolYearId}::uuid
        AND NOT EXISTS (
          SELECT 1 FROM enrollments e
          INNER JOIN students s ON s.id = e.student_id AND s.is_active = true
          INNER JOIN classes c ON c.id = e.class_id AND c.is_active = true
          WHERE e.student_id = sfs.student_id AND e.school_year_id = sfs.school_year_id
            AND e.status = 'confirmed' AND c.school_year_id = sfs.school_year_id
        )
    `);
  }

  async deleteStudentStatus(studentId: string, schoolYearId: string): Promise<void> {
    await this.db.execute(sql`
      DELETE FROM student_financial_status
      WHERE student_id = ${studentId}::uuid AND school_year_id = ${schoolYearId}::uuid
    `);
  }

  async refreshClassSummaries(schoolYearId: string): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO class_financial_summary (
        class_id, school_year_id, total_expected_to_date, total_paid,
        students_up_to_date_count, students_late_count, last_computed_at
      )
      SELECT e.class_id,
             sfs.school_year_id,
             SUM(sfs.total_expected_to_date),
             SUM(sfs.total_paid),
             COUNT(*) FILTER (WHERE sfs.status <> 'late'),
             COUNT(*) FILTER (WHERE sfs.status = 'late'),
             NOW()
      FROM student_financial_status sfs
      INNER JOIN students s ON s.id = sfs.student_id AND s.is_active = true
      INNER JOIN enrollments e ON e.student_id = s.id AND e.school_year_id = sfs.school_year_id AND e.status = 'confirmed'
      INNER JOIN classes c ON c.id = e.class_id AND c.school_year_id = sfs.school_year_id AND c.is_active = true
      WHERE sfs.school_year_id = ${schoolYearId}::uuid
      GROUP BY e.class_id, sfs.school_year_id
      ON CONFLICT ("class_id", "school_year_id") DO UPDATE SET
        total_expected_to_date = EXCLUDED.total_expected_to_date,
        total_paid = EXCLUDED.total_paid,
        students_up_to_date_count = EXCLUDED.students_up_to_date_count,
        students_late_count = EXCLUDED.students_late_count,
        last_computed_at = NOW()
    `);
    await this.db.execute(sql`
      DELETE FROM class_financial_summary cfs
      WHERE cfs.school_year_id = ${schoolYearId}::uuid
        AND NOT EXISTS (
          SELECT 1 FROM student_financial_status sfs
          INNER JOIN enrollments e ON e.student_id = sfs.student_id
            AND e.school_year_id = sfs.school_year_id AND e.status = 'confirmed'
          INNER JOIN students s ON s.id = e.student_id AND s.is_active = true
          WHERE sfs.school_year_id = cfs.school_year_id AND e.class_id = cfs.class_id
        )
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
             COUNT(*) FILTER (WHERE sfs.status <> 'late'),
             COUNT(*) FILTER (WHERE sfs.status = 'late'),
             COALESCE((
               SELECT SUM(p.amount) FROM payments p
               WHERE p.school_year_id = sfs.school_year_id
                 AND p.status = 'confirmed'
                 AND ${confirmedFinancialStudent(sql`p.student_id`, sql`p.school_year_id`)}
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
    await this.db.execute(sql`
      DELETE FROM school_financial_summary
      WHERE school_year_id = ${schoolYearId}::uuid
        AND NOT EXISTS (SELECT 1 FROM student_financial_status WHERE school_year_id = ${schoolYearId}::uuid)
    `);
  }

  async getSchoolSummary(schoolYearId: string) {
    const result = await this.db.execute<Record<string, string | number>>(sql`
      SELECT SUM(sfs.total_expected_to_date)::text AS total_expected_to_date,
             SUM(sfs.total_paid)::text AS total_paid,
             SUM(sfs.total_due_year)::text AS annual_total_due,
             (CASE WHEN SUM(sfs.total_expected_to_date) > 0
               THEN LEAST(1, SUM(sfs.total_paid) / SUM(sfs.total_expected_to_date))
               ELSE 1 END)::numeric(6,4)::text AS recovery_rate,
             SUM(GREATEST(sfs.total_expected_to_date - sfs.total_paid, 0))::text AS remaining_to_collect,
             COUNT(*) FILTER (WHERE sfs.status <> 'late')::int AS students_up_to_date_count,
             COUNT(*) FILTER (WHERE sfs.status = 'late')::int AS students_late_count,
             COALESCE((SELECT SUM(p.amount) FROM payments p
               WHERE p.school_year_id = ${schoolYearId}::uuid AND p.status = 'confirmed'
                 AND ${confirmedFinancialStudent(sql`p.student_id`, sql`p.school_year_id`)}
                 AND p.payment_date >= date_trunc('month', CURRENT_DATE) - INTERVAL '1 month'
                 AND p.payment_date < date_trunc('month', CURRENT_DATE)), 0)::text AS previous_period_total_paid,
             MAX(sfs.last_computed_at)::text AS last_computed_at
      FROM student_financial_status sfs
      INNER JOIN enrollments e ON e.student_id = sfs.student_id
        AND e.school_year_id = sfs.school_year_id AND e.status = 'confirmed'
      INNER JOIN students s ON s.id = e.student_id AND s.is_active = true
      INNER JOIN classes c ON c.id = e.class_id AND c.is_active = true AND c.school_year_id = sfs.school_year_id
      WHERE sfs.school_year_id = ${schoolYearId}::uuid
      HAVING COUNT(*) > 0
    `);
    return getRows<Record<string, string | number>>(result)[0] ?? null;
  }

  async listClassSummaries(schoolYearId: string) {
    const result = await this.db.execute<Record<string, string | number>>(sql`
      SELECT c.id::text AS class_id, c.name AS class_name,
             c.level_id::text AS level_id, l.name AS level_name,
             SUM(sfs.total_expected_to_date)::text AS total_expected_to_date,
             SUM(sfs.total_paid)::text AS total_paid,
             SUM(sfs.total_due_year)::text AS annual_total_due,
             SUM(GREATEST(sfs.total_expected_to_date - sfs.total_paid, 0))::text AS remaining_to_collect,
             COUNT(*) FILTER (WHERE sfs.status <> 'late')::int AS students_up_to_date_count,
             COUNT(*) FILTER (WHERE sfs.status = 'late')::int AS students_late_count,
             MAX(sfs.last_computed_at)::text AS last_computed_at
      FROM student_financial_status sfs
      INNER JOIN enrollments e ON e.student_id = sfs.student_id
        AND e.school_year_id = sfs.school_year_id AND e.status = 'confirmed'
      INNER JOIN students s ON s.id = e.student_id AND s.is_active = true
      INNER JOIN classes c ON c.id = e.class_id AND c.is_active = true AND c.school_year_id = sfs.school_year_id
      INNER JOIN levels l ON l.id = c.level_id
      WHERE sfs.school_year_id = ${schoolYearId}::uuid
      GROUP BY c.id, c.name, l.id, l.name
      ORDER BY c.name ASC
    `);
    return getRows<Record<string, string | number>>(result);
  }

  /** Agrégat de pilotage : plusieurs classes peuvent appartenir au même niveau. */
  async listLevelSummaries(schoolYearId: string) {
    const result = await this.db.execute<Record<string, string | number>>(sql`
      SELECT l.id::text AS level_id,
             l.name AS level_name,
             SUM(sfs.total_expected_to_date)::text AS total_expected_to_date,
             SUM(sfs.total_paid)::text AS total_paid,
             SUM(sfs.total_due_year)::text AS annual_total_due,
             SUM(GREATEST(sfs.total_expected_to_date - sfs.total_paid, 0))::text AS remaining_to_collect,
             COUNT(*) FILTER (WHERE sfs.status <> 'late')::int AS students_up_to_date_count,
             COUNT(*) FILTER (WHERE sfs.status = 'late')::int AS students_late_count,
             MAX(sfs.last_computed_at)::text AS last_computed_at
      FROM student_financial_status sfs
      INNER JOIN enrollments e ON e.student_id = sfs.student_id
        AND e.school_year_id = sfs.school_year_id AND e.status = 'confirmed'
      INNER JOIN students s ON s.id = e.student_id AND s.is_active = true
      INNER JOIN classes c ON c.id = e.class_id AND c.is_active = true AND c.school_year_id = sfs.school_year_id
      INNER JOIN levels l ON l.id = c.level_id
      WHERE sfs.school_year_id = ${schoolYearId}::uuid
      GROUP BY l.id, l.name, l.order_index
      ORDER BY l.order_index ASC, l.name ASC
    `);
    return getRows<Record<string, string | number>>(result);
  }

  async listCollectionTrend(schoolYearId: string) {
    const result = await this.db.execute<Record<string, string | number>>(sql`
      WITH school_year AS (
        SELECT start_date, end_date
        FROM school_years
        WHERE id = ${schoolYearId}::uuid
      ), months AS (
        SELECT generate_series(
          date_trunc('month', school_year.start_date)::date,
          date_trunc('month', school_year.end_date)::date,
          INTERVAL '1 month'
        )::date AS month_start
        FROM school_year
      )
      SELECT to_char(months.month_start, 'YYYY-MM') AS month_key,
             COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'confirmed'), 0)::text AS total_paid
      FROM months
      LEFT JOIN payments p
        ON date_trunc('month', p.payment_date) = months.month_start
       AND p.school_year_id = ${schoolYearId}::uuid
       AND ${confirmedFinancialStudent(sql`p.student_id`, sql`p.school_year_id`)}
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
        AND ${confirmedFinancialStudent(sql`payments.student_id`, sql`payments.school_year_id`)}
      GROUP BY method
      ORDER BY total_paid DESC, method ASC
    `);
    return getRows(result);
  }

  async listInstallmentLedger(schoolYearId: string) {
    const result = await this.db.execute<{
      student_id: string;
      annual_due: string;
      scheduled_amount: string;
      due_date: string | null;
      installment_amount: string | null;
      schedule_valid: boolean;
      total_paid: string;
      as_of_date: string;
    }>(sql`
      WITH school_year AS (
        SELECT start_date, end_date, CURRENT_DATE::text AS as_of_date
        FROM school_years
        WHERE id = ${schoolYearId}::uuid
      ), eligible_students AS (
        SELECT s.id AS student_id,
               c.level_id,
               GREATEST(COALESCE(sto.override_total_amount, tp.total_amount - COALESCE(sto.discount_amount, 0), 0), 0) AS total_due_year,
               COALESCE(payments.total_paid, 0) AS total_paid
        FROM enrollments e
        INNER JOIN students s ON s.id = e.student_id AND s.is_active = true
        INNER JOIN classes c ON c.id = e.class_id
          AND c.school_year_id = ${schoolYearId}::uuid AND c.is_active = true
        LEFT JOIN tuition_plans tp ON tp.level_id = c.level_id AND tp.school_year_id = ${schoolYearId}::uuid
        LEFT JOIN student_tuition_overrides sto ON sto.student_id = s.id AND sto.school_year_id = ${schoolYearId}::uuid
        LEFT JOIN (
          SELECT p.student_id, SUM(p.amount) AS total_paid
          FROM payments p
          WHERE p.school_year_id = ${schoolYearId}::uuid
            AND p.status = 'confirmed'
            AND ${confirmedFinancialStudent(sql`p.student_id`, sql`p.school_year_id`)}
          GROUP BY p.student_id
        ) payments ON payments.student_id = s.id
        WHERE e.school_year_id = ${schoolYearId}::uuid AND e.status = 'confirmed'
      ), selected_steps AS (
        SELECT eligible.student_id, eligible.total_due_year, eligible.total_paid,
               individual.due_date, individual.cumulative_amount_expected, school_year.as_of_date
        FROM eligible_students eligible
        INNER JOIN student_tuition_schedule_agreements agreement
          ON agreement.student_id = eligible.student_id AND agreement.school_year_id = ${schoolYearId}::uuid
        INNER JOIN student_tuition_schedule_steps individual ON individual.agreement_id = agreement.id
        CROSS JOIN school_year
        WHERE individual.due_date BETWEEN school_year.start_date AND school_year.end_date
        UNION ALL
        SELECT eligible.student_id, eligible.total_due_year, eligible.total_paid,
               standard.due_date, standard.cumulative_amount_expected, school_year.as_of_date
        FROM eligible_students eligible
        INNER JOIN tuition_plans plan
          ON plan.level_id = eligible.level_id AND plan.school_year_id = ${schoolYearId}::uuid
        INNER JOIN tuition_schedule_steps standard ON standard.tuition_plan_id = plan.id
        CROSS JOIN school_year
        WHERE NOT EXISTS (
          SELECT 1 FROM student_tuition_schedule_agreements agreement
          WHERE agreement.student_id = eligible.student_id AND agreement.school_year_id = ${schoolYearId}::uuid
        )
          AND standard.due_date BETWEEN school_year.start_date AND school_year.end_date
      ), ordered_steps AS (
        SELECT student_id, due_date, total_paid, as_of_date, total_due_year,
               cumulative_amount_expected,
               LAG(cumulative_amount_expected) OVER (
                 PARTITION BY student_id ORDER BY due_date
               ) AS previous_cumulative_amount_expected
        FROM selected_steps
      ), step_amounts AS (
        SELECT student_id, due_date, total_paid, as_of_date,
               cumulative_amount_expected >= COALESCE(previous_cumulative_amount_expected, 0) AS schedule_valid,
               GREATEST(
                 LEAST(cumulative_amount_expected, total_due_year)
                 - CASE
                   WHEN previous_cumulative_amount_expected IS NULL THEN 0
                   ELSE LEAST(previous_cumulative_amount_expected, total_due_year)
                 END,
                 0
               ) AS installment_amount
        FROM ordered_steps
      ), installment_totals AS (
        SELECT eligible.student_id,
               COALESCE(SUM(step.installment_amount), 0) AS scheduled_amount,
               COALESCE(BOOL_AND(step.schedule_valid), true) AS schedule_valid
        FROM eligible_students eligible
        LEFT JOIN step_amounts step ON step.student_id = eligible.student_id
        GROUP BY eligible.student_id
      ), positive_installments AS (
        SELECT student_id, due_date, installment_amount
        FROM step_amounts
        WHERE installment_amount > 0
      )
      SELECT eligible.student_id::text,
             eligible.total_due_year::text AS annual_due,
             totals.scheduled_amount::text,
             installment.due_date::text,
             installment.installment_amount::text,
             totals.schedule_valid,
             eligible.total_paid::text,
             school_year.as_of_date
      FROM eligible_students eligible
      INNER JOIN installment_totals totals ON totals.student_id = eligible.student_id
      LEFT JOIN positive_installments installment ON installment.student_id = eligible.student_id
      CROSS JOIN school_year
      ORDER BY eligible.student_id ASC, installment.due_date ASC
    `);
    return getRows<{
      student_id: string;
      annual_due: string;
      scheduled_amount: string;
      due_date: string | null;
      installment_amount: string | null;
      schedule_valid: boolean;
      total_paid: string;
      as_of_date: string;
    }>(result);
  }

  async listRecentPayments(schoolYearId: string) {
    const result = await this.db.execute<Record<string, string | number | null>>(sql`
      SELECT p.id::text AS payment_id,
             p.student_id::text AS student_id,
             p.payment_date::text AS payment_date,
             concat_ws(' ', s.first_name, s.last_name) AS student_name,
             s.matricule AS student_matricule,
             c.name AS class_name,
             p.method::text AS method,
             p.amount::text AS amount,
             p.receipt_number
      FROM payments p
      INNER JOIN students s ON s.id = p.student_id
      INNER JOIN enrollments e ON e.student_id = s.id AND e.school_year_id = p.school_year_id AND e.status = 'confirmed'
      INNER JOIN classes c ON c.id = e.class_id AND c.school_year_id = p.school_year_id AND c.is_active = true
      WHERE p.school_year_id = ${schoolYearId}::uuid AND s.is_active = true
        AND p.status = 'confirmed'
      ORDER BY p.payment_date DESC, p.created_at DESC
      LIMIT 5
    `);
    return getRows(result);
  }

  async getStudentCachedStatus(studentId: string, schoolYearId: string) {
    const result = await this.db.execute<Record<string, string | number>>(sql`
      SELECT total_expected_to_date::text, total_paid::text,
             total_due_year::text, status::text, days_late, last_computed_at::text
      FROM student_financial_status
      WHERE student_id = ${studentId}::uuid AND school_year_id = ${schoolYearId}::uuid
        AND ${confirmedFinancialStudent(sql`student_financial_status.student_id`, sql`student_financial_status.school_year_id`)}
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
      INNER JOIN enrollments e ON e.student_id = s.id AND e.school_year_id = sfs.school_year_id AND e.status = 'confirmed'
      INNER JOIN classes c ON c.id = e.class_id AND c.school_year_id = sfs.school_year_id AND c.is_active = true
      WHERE e.class_id = ${classId}::uuid AND s.is_active = true
      ORDER BY CASE sfs.status WHEN 'late' THEN 0 ELSE 1 END,
               sfs.days_late DESC NULLS LAST,
               s.last_name ASC
    `);
    return getRows(result);
  }
}
