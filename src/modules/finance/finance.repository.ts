import { sql } from 'drizzle-orm';
import { BUSINESS_DATE_SQL } from '../../shared/database/business-date.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type {
  MobileMoneyProvider,
  PaymentMethod,
  UpsertTuitionPlanInput,
} from './finance.types.js';
import type { CumulativeScheduleStep, PaymentStatus } from './finance.calculations.js';
import { confirmedFinancialStudent } from './finance-scope.js';
import { confirmedSchoolClassCount } from '../../shared/database/confirmed-school-membership.js';

export type FinanceDb = NodePgDatabase<Record<string, unknown>>;

const rows = <T>(result: unknown): T[] =>
  typeof result === 'object' && result !== null && 'rows' in result
    ? ((result as { rows: T[] }).rows ?? [])
    : [];

export type PaymentRow = {
  id: string;
  student_id: string;
  school_year_id: string;
  amount: string | number;
  method: PaymentMethod;
  source: 'in_app_button' | 'cashier_manual' | 'bulk_import' | 'migration_import';
  status: PaymentStatus;
  confirmed_by_user_id: string | null;
  provider_reference: string | null;
  school_receipt_reference: string | null;
  receipt_number: string;
  cancelled_at: string | Date | null;
  cancelled_by_user_id: string | null;
  cancellation_reason: string | null;
  payment_date: string;
  /** Heure réelle du paiement, seulement quand elle est connue (encaissement à la caisse). */
  paid_at: string | Date | null;
  created_at: string | Date;
};

export type CashJournalRow = PaymentRow & {
  cancelled_by_name?: string | null;
  cancelled_by_active?: boolean | null;
  student_matricule: string | null;
  student_name: string;
  class_id: string;
  class_name: string;
};

export type PaymentHistoryRow = CashJournalRow & {
  level_id: string;
  level_name: string;
  financial_status: 'up_to_date' | 'late' | null;
};

export type CashJournalFilterInput = {
  schoolYearId?: string;
  from?: string;
  to?: string;
  classId?: string;
  method?: PaymentMethod;
  /** Restrict the listed rows to one status (totals ignore it). */
  status?: 'confirmed' | 'cancelled';
  /** When false (default) cancelled payments are never returned. */
  includeCancelled?: boolean;
};

export type CashJournalSummary = {
  total: string | number;
  confirmed_count: string | number;
  cancelled_count: string | number;
  cash_total: string | number;
  mobile_money_total: string | number;
  bank_transfer_total: string | number;
  grand_total: string | number;
};

export type AmountDueContext = {
  student_id: string;
  student_name: string;
  student_matricule: string | null;
  class_id: string;
  class_name: string;
  school_year_id: string;
  plan_id: string;
  plan_total_amount: string | number;
  registration_amount: string | number;
  currency: string;
  override_total_amount: string | number | null;
  discount_amount: string | number | null;
};

export type TuitionPlanRequiredContext = {
  schoolYearId: string;
  schoolYearLabel: string;
  levelId: string;
  levelName: string;
};
export type TuitionOverride = {
  id: string; studentId: string; schoolYearId: string; overrideTotalAmount: number | null; discountAmount: number | null;
  reason: string; grantedByUserId: string; status: 'active' | 'withdrawn'; createdAt: string | Date;
};

export type StudentTuitionScheduleAgreement = {
  id: string;
  studentId: string;
  schoolYearId: string;
  reason: string;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  updatedByName: string | null;
  createdAt: string | Date;
  updatedAt: string | Date;
  scheduleSteps: CumulativeScheduleStep[];
};

export type ReceiptContextRow = PaymentRow & {
  student_name: string;
  class_name: string;
  school_year_label: string;
  currency: string;
  enrollment_total_amount: string | number | null;
  enrollment_parent_alerts_amount: string | number | null;
  show_parent_alerts_on_receipt: boolean | null;
};

type ReceiptNumberRow = {
  receipt_number: string;
};

const ACCENTS = 'àáâäãåçèéêëìíîïñòóôöõùúûüýÿÀÁÂÄÃÅÇÈÉÊËÌÍÎÏÑÒÓÔÖÕÙÚÛÜÝŸ';
const PLAIN = 'aaaaaaceeeeiiiinooooouuuuyyAAAAAACEEEEIIIINOOOOOUUUUYY';
/** Terme de recherche sans accents ni casse, entouré de % pour un LIKE (null si vide). */
const foldSearchTerm = (value?: string): string | null => {
  const folded = value?.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return folded ? `%${folded.replace(/[\\%_]/g, '\\$&')}%` : null;
};
/** Recherche insensible à la casse et aux accents sur élève (prénom/nom dans les deux ordres), matricule, classe, niveau. */
const foldedHaystackMatches = (search: string | null) => sql`(
  lower(translate(concat_ws(' ', s.first_name, s.last_name, s.matricule, c.name, l.name), ${ACCENTS}, ${PLAIN})) LIKE ${search}
  OR lower(translate(concat_ws(' ', s.last_name, s.first_name), ${ACCENTS}, ${PLAIN})) LIKE ${search})`;

export class FinanceRepository {
  constructor(readonly db: FinanceDb) {}

  static toNumber(value: string | number | null | undefined): number {
    const parsed = typeof value === 'number' ? value : Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  async listAgreementsRegister(input: { schoolYearId: string; kind: 'overrides' | 'schedules'; search?: string; studentId?: string; classId?: string; levelId?: string; from?: string; to?: string; status: 'active' | 'withdrawn' | 'replaced' | 'reset' | 'all'; page: number; limit: number }) {
    const offset = (input.page - 1) * input.limit;
    const search = foldSearchTerm(input.search);
    const studentId = input.studentId ?? null;
    const classId = input.classId ?? null;
    const levelId = input.levelId ?? null;
    const from = input.from ?? null;
    const to = input.to ?? null;
    const overrideRows = input.kind === 'overrides' ? await this.db.execute(sql`
      SELECT o.id::text AS id, 'override'::text AS kind, o.status, s.id::text AS student_id, o.school_year_id::text AS school_year_id, c.id::text AS class_id, l.id::text AS level_id, format_person_name(s.first_name, s.last_name) AS student_name, s.matricule, c.name AS class_name, l.name AS level_name, o.discount_amount, o.override_total_amount, tp.total_amount AS plan_total_amount, COALESCE(sfs.total_paid,0) AS total_paid, GREATEST(COALESCE(sfs.total_due_year,0) - COALESCE(sfs.total_paid,0), 0) AS remaining_due, sfs.status AS financial_status, o.created_at, o.withdrawn_at, o.granted_by_user_id::text AS actor_id, grantor.name AS created_by_name, 0::numeric AS active_discount_amount, COUNT(*) OVER()::int AS total_count
      FROM student_tuition_overrides o JOIN students s ON s.id=o.student_id JOIN enrollments e ON e.student_id=s.id AND e.school_year_id=o.school_year_id AND e.status='confirmed' JOIN classes c ON c.id=e.class_id JOIN levels l ON l.id=c.level_id LEFT JOIN tuition_plans tp ON tp.level_id=c.level_id AND tp.school_year_id=o.school_year_id LEFT JOIN student_financial_status sfs ON sfs.student_id=s.id AND sfs.school_year_id=o.school_year_id LEFT JOIN users grantor ON grantor.id=o.granted_by_user_id
      WHERE o.school_year_id=${input.schoolYearId}::uuid AND (${input.status}='all' OR o.status=${input.status}) AND (${studentId}::uuid IS NULL OR o.student_id=${studentId}::uuid) AND (${classId}::uuid IS NULL OR c.id=${classId}::uuid) AND (${levelId}::uuid IS NULL OR l.id=${levelId}::uuid) AND (${from}::date IS NULL OR o.created_at::date >= ${from}::date) AND (${to}::date IS NULL OR o.created_at::date <= ${to}::date) AND (${search}::text IS NULL OR ${foldedHaystackMatches(search)}) ORDER BY o.created_at DESC LIMIT ${input.limit} OFFSET ${offset}`) : { rows: [] };
    const scheduleRows = input.kind === 'schedules' ? await this.db.execute(sql`
      SELECT a.id::text AS id, 'schedule'::text AS kind, a.status, s.id::text AS student_id, a.school_year_id::text AS school_year_id, c.id::text AS class_id, l.id::text AS level_id, format_person_name(s.first_name, s.last_name) AS student_name, s.matricule, c.name AS class_name, l.name AS level_name, NULL::numeric AS discount_amount, NULL::numeric AS override_total_amount, COALESCE(sfs.total_due_year,0) AS plan_total_amount, COALESCE(sfs.total_paid,0) AS total_paid, GREATEST(COALESCE(sfs.total_due_year,0) - COALESCE(sfs.total_paid,0), 0) AS remaining_due, sfs.status AS financial_status, a.created_at, a.closed_at AS withdrawn_at, a.updated_by_user_id::text AS actor_id, creator.name AS created_by_name, COALESCE(discount.discount_amount, 0) AS active_discount_amount, schedule.step_count, schedule.schedule_total_amount, schedule.next_due_date, COUNT(*) OVER()::int AS total_count
      FROM student_tuition_schedule_agreements a JOIN students s ON s.id=a.student_id JOIN enrollments e ON e.student_id=s.id AND e.school_year_id=a.school_year_id AND e.status='confirmed' JOIN classes c ON c.id=e.class_id JOIN levels l ON l.id=c.level_id LEFT JOIN student_financial_status sfs ON sfs.student_id=s.id AND sfs.school_year_id=a.school_year_id LEFT JOIN users creator ON creator.id=a.created_by_user_id LEFT JOIN student_tuition_overrides discount ON discount.student_id=a.student_id AND discount.school_year_id=a.school_year_id AND discount.status='active' AND discount.discount_amount IS NOT NULL
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS step_count, COALESCE(MAX(step.cumulative_amount_expected), 0) AS schedule_total_amount,
          MIN(step.due_date) FILTER (WHERE step.due_date >= CURRENT_DATE)::text AS next_due_date
        FROM student_tuition_schedule_steps step WHERE step.agreement_id=a.id
      ) schedule ON TRUE
      WHERE a.school_year_id=${input.schoolYearId}::uuid AND (${input.status}='all' OR a.status=${input.status}) AND (${studentId}::uuid IS NULL OR a.student_id=${studentId}::uuid) AND (${classId}::uuid IS NULL OR c.id=${classId}::uuid) AND (${levelId}::uuid IS NULL OR l.id=${levelId}::uuid) AND (${from}::date IS NULL OR a.created_at::date >= ${from}::date) AND (${to}::date IS NULL OR a.created_at::date <= ${to}::date) AND (${search}::text IS NULL OR ${foldedHaystackMatches(search)}) ORDER BY a.updated_at DESC LIMIT ${input.limit} OFFSET ${offset}`) : { rows: [] };
    const result = input.kind === 'overrides' ? overrideRows : scheduleRows;
    const entries = rows<Record<string, unknown>>(result).map((row) => ({ ...row, discount_amount: FinanceRepository.toNumber(row.discount_amount as string | number), override_total_amount: FinanceRepository.toNumber(row.override_total_amount as string | number), active_discount_amount: FinanceRepository.toNumber(row.active_discount_amount as string | number), plan_total_amount: FinanceRepository.toNumber(row.plan_total_amount as string | number), total_paid: FinanceRepository.toNumber(row.total_paid as string | number), remaining_due: FinanceRepository.toNumber(row.remaining_due as string | number), step_count: FinanceRepository.toNumber(row.step_count as string | number), schedule_total_amount: FinanceRepository.toNumber(row.schedule_total_amount as string | number) }));
    return { entries, total: Number((entries[0] as Record<string, unknown> | undefined)?.total_count ?? 0) };
  }

  async getAgreementDetail(kind: 'overrides' | 'schedules', agreementId: string) {
    const result = kind === 'overrides'
      ? await this.db.execute(sql`
          SELECT o.id::text AS id, 'override'::text AS kind, o.status, o.reason, o.withdrawal_reason, o.created_at, o.withdrawn_at, o.discount_amount, o.override_total_amount, o.student_id::text AS student_id, o.school_year_id::text AS school_year_id, grantor.name AS created_by_name, 0::numeric AS active_discount_amount,
            format_person_name(s.first_name, s.last_name) AS student_name, s.matricule, c.name AS class_name, l.name AS level_name, COALESCE(tp.total_amount, 0) AS plan_total_amount, COALESCE(sfs.total_paid, 0) AS total_paid, GREATEST(COALESCE(sfs.total_due_year,0) - COALESCE(sfs.total_paid,0), 0) AS remaining_due, sfs.status AS financial_status
          FROM student_tuition_overrides o JOIN students s ON s.id=o.student_id JOIN enrollments e ON e.student_id=s.id AND e.school_year_id=o.school_year_id AND e.status='confirmed' JOIN classes c ON c.id=e.class_id JOIN levels l ON l.id=c.level_id LEFT JOIN tuition_plans tp ON tp.level_id=c.level_id AND tp.school_year_id=o.school_year_id LEFT JOIN student_financial_status sfs ON sfs.student_id=o.student_id AND sfs.school_year_id=o.school_year_id LEFT JOIN users grantor ON grantor.id=o.granted_by_user_id
          WHERE o.id=${agreementId}::uuid LIMIT 1`)
      : await this.db.execute(sql`
          SELECT a.id::text AS id, 'schedule'::text AS kind, a.status, a.reason, a.closure_reason AS withdrawal_reason, a.created_at, a.closed_at AS withdrawn_at, NULL::numeric AS discount_amount, NULL::numeric AS override_total_amount, a.student_id::text AS student_id, a.school_year_id::text AS school_year_id, creator.name AS created_by_name, COALESCE(discount.discount_amount, 0) AS active_discount_amount,
            format_person_name(s.first_name, s.last_name) AS student_name, s.matricule, c.name AS class_name, l.name AS level_name, COALESCE(sfs.total_due_year, 0) AS plan_total_amount, COALESCE(sfs.total_paid, 0) AS total_paid, GREATEST(COALESCE(sfs.total_due_year,0) - COALESCE(sfs.total_paid,0), 0) AS remaining_due, sfs.status AS financial_status, schedule.schedule_steps
          FROM student_tuition_schedule_agreements a JOIN students s ON s.id=a.student_id JOIN enrollments e ON e.student_id=s.id AND e.school_year_id=a.school_year_id AND e.status='confirmed' JOIN classes c ON c.id=e.class_id JOIN levels l ON l.id=c.level_id LEFT JOIN student_financial_status sfs ON sfs.student_id=a.student_id AND sfs.school_year_id=a.school_year_id LEFT JOIN users creator ON creator.id=a.created_by_user_id LEFT JOIN student_tuition_overrides discount ON discount.student_id=a.student_id AND discount.school_year_id=a.school_year_id AND discount.status='active' AND discount.discount_amount IS NOT NULL
          LEFT JOIN LATERAL (
            SELECT COALESCE(json_agg(json_build_object('dueDate', step.due_date::text, 'cumulativeAmountExpected', step.cumulative_amount_expected) ORDER BY step.due_date), '[]'::json) AS schedule_steps
            FROM student_tuition_schedule_steps step WHERE step.agreement_id=a.id
          ) schedule ON TRUE
          WHERE a.id=${agreementId}::uuid LIMIT 1`);
    const agreement = rows<Record<string, unknown>>(result)[0];
    if (!agreement) return null;
    const events = rows<Record<string, unknown>>(await this.db.execute(sql`
      SELECT event.id::text AS id, event.action, event.actor_role, event.created_at, actor.name AS actor_name, event.payload_before, event.payload_after
      FROM public.audit_financial_events event
      LEFT JOIN users actor ON actor.id=event.actor_id
      WHERE event.tenant_id=(SELECT id FROM public.tenants WHERE schema_name=current_schema())
        AND (event.payload_before->>'agreementId'=${agreementId} OR event.payload_after->>'agreementId'=${agreementId} OR event.payload_before->>'overrideId'=${agreementId} OR event.payload_after->>'overrideId'=${agreementId})
      ORDER BY event.created_at ASC`));
    return { agreement: { ...agreement, discount_amount: FinanceRepository.toNumber(agreement.discount_amount as string | number), override_total_amount: FinanceRepository.toNumber(agreement.override_total_amount as string | number), active_discount_amount: FinanceRepository.toNumber(agreement.active_discount_amount as string | number), plan_total_amount: FinanceRepository.toNumber(agreement.plan_total_amount as string | number), total_paid: FinanceRepository.toNumber(agreement.total_paid as string | number), remaining_due: FinanceRepository.toNumber(agreement.remaining_due as string | number) }, events };
  }

  async getAgreementsMetrics(schoolYearId: string) {
    const result = await this.db.execute<{ active_overrides: string; active_discounts: string; active_schedules: string; late_schedules: string; late_schedule_remaining: string }>(sql`
      SELECT
        (SELECT COUNT(*) FROM student_tuition_overrides WHERE school_year_id=${schoolYearId}::uuid AND status='active')::text AS active_overrides,
        (SELECT COALESCE(SUM(discount_amount), 0) FROM student_tuition_overrides WHERE school_year_id=${schoolYearId}::uuid AND status='active')::text AS active_discounts,
        (SELECT COUNT(*) FROM student_tuition_schedule_agreements WHERE school_year_id=${schoolYearId}::uuid AND status='active')::text AS active_schedules,
        (SELECT COUNT(*) FROM student_tuition_schedule_agreements a INNER JOIN student_financial_status sfs ON sfs.student_id=a.student_id AND sfs.school_year_id=a.school_year_id WHERE a.school_year_id=${schoolYearId}::uuid AND a.status='active' AND sfs.status='late')::text AS late_schedules,
        (SELECT COALESCE(SUM(GREATEST(sfs.total_expected_to_date - sfs.total_paid, 0)),0) FROM student_tuition_schedule_agreements a INNER JOIN student_financial_status sfs ON sfs.student_id=a.student_id AND sfs.school_year_id=a.school_year_id WHERE a.school_year_id=${schoolYearId}::uuid AND a.status='active' AND sfs.status='late')::text AS late_schedule_remaining
    `);
    const row = rows<{ active_overrides: string; active_discounts: string; active_schedules: string; late_schedules: string; late_schedule_remaining: string }>(result)[0];
    return { activeOverrides: Number(row?.active_overrides ?? 0), activeDiscounts: FinanceRepository.toNumber(row?.active_discounts), activeSchedules: Number(row?.active_schedules ?? 0), lateSchedules: Number(row?.late_schedules ?? 0), lateScheduleRemaining: FinanceRepository.toNumber(row?.late_schedule_remaining) };
  }

  /**
   * Numéro de reçu REC-AAAAMMJJ-NNNN : jour d'enregistrement (fuseau de l'école) + compteur du jour.
   * À appeler dans la transaction qui insère le paiement : l'incrément verrouille la ligne du jour (deux paiements
   * simultanés s'enchaînent) et un échec annule aussi le numéro (aucun trou). UNIQUE(receipt_number) reste le filet.
   */
  async nextReceiptNumber(): Promise<string> {
    const result = await this.db.execute<ReceiptNumberRow>(sql`
      WITH issued AS (
        INSERT INTO payment_receipt_counters (day, last_number)
        VALUES (${BUSINESS_DATE_SQL}, 1)
        ON CONFLICT (day) DO UPDATE SET last_number = payment_receipt_counters.last_number + 1
        RETURNING day, last_number
      )
      SELECT CONCAT('REC-', to_char(day, 'YYYYMMDD'), '-', LPAD(last_number::text, 4, '0')) AS receipt_number FROM issued
    `);
    const receiptNumber = rows<ReceiptNumberRow>(result)[0]?.receipt_number;
    if (!receiptNumber) throw new Error('Failed to generate receipt number');
    return receiptNumber;
  }

  async hasConfirmedEnrollment(studentId: string, schoolYearId: string, allowHistorical = false): Promise<boolean> {
    const result = await this.db.execute<{ eligible: boolean }>(sql`
      SELECT ${allowHistorical ? sql`EXISTS (
        SELECT 1 FROM enrollments e
        JOIN classes c ON c.id = e.class_id AND c.school_year_id = e.school_year_id
        JOIN school_years sy ON sy.id = e.school_year_id
        WHERE e.student_id = ${studentId}::uuid
          AND e.school_year_id = ${schoolYearId}::uuid
          AND e.status = 'confirmed'
          AND sy.status = 'closed'
      )` : confirmedFinancialStudent(sql`${studentId}::uuid`, sql`${schoolYearId}::uuid`)} AS eligible
    `);
    return rows<{ eligible: boolean }>(result)[0]?.eligible === true;
  }

  async getAmountDueContext(studentId: string, schoolYearId: string, allowPending = false, allowHistorical = false): Promise<AmountDueContext | null> {
    const result = await this.db.execute<AmountDueContext>(sql`
      SELECT
        s.id::text AS student_id,
        format_person_name(s.first_name, s.last_name) AS student_name,
        s.matricule AS student_matricule,
        c.id::text AS class_id,
        c.name AS class_name,
        ${schoolYearId}::uuid::text AS school_year_id,
        tp.id::text AS plan_id,
        tp.total_amount AS plan_total_amount,
        tp.registration_amount,
        tp.currency,
        sto.override_total_amount,
        sto.discount_amount
      FROM students s
      INNER JOIN enrollments e
        ON e.student_id = s.id
       AND e.school_year_id = ${schoolYearId}::uuid
       AND ${allowPending ? sql`e.status IN ('pending_cashier', 'pending_dossier')` : sql`e.status = 'confirmed'`}
      INNER JOIN classes c
        ON c.id = e.class_id
       AND c.school_year_id = ${schoolYearId}::uuid ${allowHistorical ? sql`` : sql`AND c.is_active = true`}
      INNER JOIN school_years sy ON sy.id = c.school_year_id
        ${allowHistorical ? sql`` : sql`AND sy.status = 'active'`}
      INNER JOIN tuition_plans tp
        ON tp.level_id = c.level_id
       AND tp.school_year_id = ${schoolYearId}::uuid
      LEFT JOIN student_tuition_overrides sto
        ON sto.student_id = s.id
       AND sto.school_year_id = ${schoolYearId}::uuid
       AND sto.status = 'active'
      WHERE s.id = ${studentId}::uuid ${allowHistorical ? sql`` : sql`AND s.is_active = true`}
      ORDER BY e.enrolled_at DESC
      LIMIT 1
    `);
    return rows<AmountDueContext>(result)[0] ?? null;
  }

  /** The same tuition and payment inputs as getAmountDueContext, for a whole origin year. */
  async listReEnrollmentBalanceContexts(schoolYearId: string): Promise<Array<{
    student_id: string;
    plan_total_amount: string | number | null;
    override_total_amount: string | number | null;
    discount_amount: string | number | null;
    confirmed_paid: string | number;
  }>> {
    const result = await this.db.execute<{
      student_id: string; plan_total_amount: string | number | null;
      override_total_amount: string | number | null; discount_amount: string | number | null;
      confirmed_paid: string | number;
    }>(sql`
      SELECT e.student_id::text,
             tp.total_amount AS plan_total_amount,
             sto.override_total_amount,
             sto.discount_amount,
             COALESCE(coverage.confirmed_paid, 0) AS confirmed_paid
      FROM enrollments e
      INNER JOIN classes c ON c.id = e.class_id AND c.school_year_id = e.school_year_id
      LEFT JOIN tuition_plans tp ON tp.level_id = c.level_id AND tp.school_year_id = e.school_year_id
      LEFT JOIN student_tuition_overrides sto ON sto.student_id = e.student_id AND sto.school_year_id = e.school_year_id AND sto.status = 'active'
      LEFT JOIN LATERAL (
        SELECT SUM(p.amount) AS confirmed_paid
        FROM payments p
        WHERE p.student_id = e.student_id AND p.school_year_id = e.school_year_id
          AND p.status = 'confirmed'
      ) coverage ON true
      WHERE e.school_year_id = ${schoolYearId}::uuid AND e.status = 'confirmed'
    `);
    return rows(result);
  }

  async getTuitionPlanRequiredContext(studentId: string, schoolYearId: string, allowPending = false, allowHistorical = false): Promise<TuitionPlanRequiredContext | null> {
    const result = await this.db.execute<TuitionPlanRequiredContext>(sql`
      SELECT y.id::text AS "schoolYearId", y.label AS "schoolYearLabel",
             l.id::text AS "levelId", l.name AS "levelName"
      FROM students s
      INNER JOIN enrollments e ON e.student_id = s.id AND e.school_year_id = ${schoolYearId}::uuid
        AND ${allowPending ? sql`e.status IN ('pending_cashier', 'pending_dossier')` : sql`e.status = 'confirmed'`}
      INNER JOIN classes c ON c.id = e.class_id AND c.school_year_id = ${schoolYearId}::uuid ${allowHistorical ? sql`` : sql`AND c.is_active = true`}
      INNER JOIN school_years y ON y.id = c.school_year_id
        ${allowHistorical ? sql`` : sql`AND y.status = 'active'`}
      INNER JOIN levels l ON l.id = c.level_id
      WHERE s.id = ${studentId}::uuid ${allowHistorical ? sql`` : sql`AND s.is_active = true`}
      ORDER BY e.enrolled_at DESC NULLS LAST
      LIMIT 1
    `);
    return rows<TuitionPlanRequiredContext>(result)[0] ?? null;
  }

  async getConfirmedPaid(studentId: string, schoolYearId: string): Promise<number> {
    const result = await this.db.execute<{ total: string | number }>(sql`
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM payments
      WHERE student_id = ${studentId}::uuid
        AND school_year_id = ${schoolYearId}::uuid
        AND status = 'confirmed'
    `);
    return FinanceRepository.toNumber(rows<{ total: string | number }>(result)[0]?.total);
  }

  async unblockReEnrollmentsAfterSettlement(studentId: string, previousSchoolYearId: string): Promise<number> {
    const result = await this.db.execute<{ id: string }>(sql`
      UPDATE enrollments e
      SET status = 'pending_cashier', updated_at = NOW()
      FROM school_years target_year, school_years previous_year
      WHERE e.student_id = ${studentId}::uuid
        AND e.type = 're_registration'
        AND e.status = 'blocked_unpaid'
        AND target_year.id = e.school_year_id
        AND previous_year.id = ${previousSchoolYearId}::uuid
        AND target_year.start_date > previous_year.end_date
      RETURNING e.id::text
    `);
    return rows<{ id: string }>(result).length;
  }

  async blockPendingReEnrollmentsAfterUnsettlement(
    studentId: string,
    previousSchoolYearId: string
  ): Promise<number> {
    const result = await this.db.execute<{ id: string }>(sql`
      UPDATE enrollments e
      SET status = 'blocked_unpaid', updated_at = NOW()
      FROM school_years target_year, school_years previous_year
      WHERE e.student_id = ${studentId}::uuid
        AND e.type = 're_registration'
        AND e.status IN ('pending_cashier', 'pending_dossier')
        AND target_year.id = e.school_year_id
        AND previous_year.id = ${previousSchoolYearId}::uuid
        AND target_year.start_date > previous_year.end_date
      RETURNING e.id::text
    `);
    return rows<{ id: string }>(result).length;
  }

  async getExpectedAtDate(studentId: string, schoolYearId: string, asOfDate: string, allowHistorical = false): Promise<number> {
    const result = await this.db.execute<{ expected: string | number }>(sql`
      SELECT CASE
        WHEN custom_steps.step_count > 0 THEN COALESCE(custom_steps.expected, 0)
        ELSE COALESCE(plan_steps.expected, 0)
      END AS expected
      FROM students s
      INNER JOIN enrollments e
        ON e.student_id = s.id
       AND e.school_year_id = ${schoolYearId}::uuid
       AND e.status = 'confirmed'
      INNER JOIN classes c
        ON c.id = e.class_id
       AND c.school_year_id = ${schoolYearId}::uuid ${allowHistorical ? sql`` : sql`AND c.is_active = true`}
      INNER JOIN tuition_plans tp
        ON tp.level_id = c.level_id
       AND tp.school_year_id = ${schoolYearId}::uuid
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS step_count,
               MAX(cumulative_amount_expected) FILTER (WHERE due_date <= ${asOfDate}::date) AS expected
        FROM student_tuition_schedule_steps step
        INNER JOIN student_tuition_schedule_agreements agreement ON agreement.id = step.agreement_id
      WHERE agreement.student_id = s.id
          AND agreement.school_year_id = ${schoolYearId}::uuid
          AND agreement.status = 'active'
      ) custom_steps ON true
      LEFT JOIN LATERAL (
        SELECT MAX(cumulative_amount_expected) AS expected
        FROM tuition_schedule_steps
        WHERE tuition_plan_id = tp.id
          AND due_date <= ${asOfDate}::date
      ) plan_steps ON true
      WHERE s.id = ${studentId}::uuid ${allowHistorical ? sql`` : sql`AND s.is_active = true`}
      ORDER BY e.enrolled_at DESC NULLS LAST
      LIMIT 1
    `);
    return FinanceRepository.toNumber(rows<{ expected: string | number }>(result)[0]?.expected);
  }

  async insertPayment(input: {
    studentId: string;
    schoolYearId: string;
    amount: number;
    method: PaymentMethod;
    source: 'cashier_manual' | 'in_app_button' | 'bulk_import' | 'migration_import';
    confirmedByUserId?: string | null;
    providerReference?: string;
    schoolReceiptReference?: string;
    receiptNumber: string;
    paymentDate?: string;
  }): Promise<PaymentRow> {
    // L'heure réelle n'est connue que pour un encaissement saisi à la caisse, à la date du jour : jamais pour les imports ni les rétrodatages.
    const recordsPaymentMoment = (input.source === 'cashier_manual' || input.source === 'in_app_button') && !input.paymentDate;
    const result = await this.db.execute<PaymentRow>(sql`
      INSERT INTO payments (
        student_id, school_year_id, amount, method, source, status,
        confirmed_by_user_id, provider_reference, school_receipt_reference, receipt_number,
        payment_date, paid_at
      ) VALUES (
        ${input.studentId}::uuid, ${input.schoolYearId}::uuid, ${input.amount},
        ${input.method}::finance_payment_method, ${input.source}::payment_source, 'confirmed',
        ${input.confirmedByUserId ?? null}::uuid, ${input.providerReference ?? null},
        ${input.schoolReceiptReference ?? null}, ${input.receiptNumber},
        COALESCE(${input.paymentDate ?? null}::date, CURRENT_DATE),
        ${recordsPaymentMoment ? sql`NOW()` : sql`NULL`}
      )
      RETURNING *, id::text, student_id::text, school_year_id::text,
        confirmed_by_user_id::text, cancelled_by_user_id::text
    `);
    const payment = rows<PaymentRow>(result)[0];
    if (!payment) throw new Error('Failed to insert payment');
    return payment;
  }

  async insertEnrollmentPaymentAllocation(input: {
    paymentId: string | null;
    subscriptionPaymentId: string;
    studentId: string;
    schoolYearId: string;
    totalAmount: number;
    tuitionAmount: number;
    parentAlertsAmount: number;
    showParentAlertsOnReceipt: boolean;
    actorUserId: string;
  }): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO enrollment_payment_allocations (
        payment_id, subscription_payment_id, student_id, school_year_id,
        total_amount, tuition_amount, parent_alerts_amount,
        show_parent_alerts_on_receipt, allocated_by_user_id
      )
      VALUES (
        ${input.paymentId}::uuid, ${input.subscriptionPaymentId}::uuid,
        ${input.studentId}::uuid, ${input.schoolYearId}::uuid,
        ${input.totalAmount}, ${input.tuitionAmount}, ${input.parentAlertsAmount},
        ${input.showParentAlertsOnReceipt}, ${input.actorUserId}::uuid
      )
    `);
  }

  async findPayment(id: string): Promise<PaymentRow | null> {
    const result = await this.db.execute<PaymentRow>(sql`
      SELECT *, id::text, student_id::text, school_year_id::text,
             confirmed_by_user_id::text, cancelled_by_user_id::text
      FROM payments WHERE id = ${id}::uuid LIMIT 1
    `);
    return rows<PaymentRow>(result)[0] ?? null;
  }

  async listPayments(studentId: string, schoolYearId: string): Promise<PaymentRow[]> {
    const result = await this.db.execute<PaymentRow>(sql`
      SELECT *, id::text, student_id::text, school_year_id::text,
             confirmed_by_user_id::text, cancelled_by_user_id::text
      FROM payments
      WHERE student_id = ${studentId}::uuid
        AND school_year_id = ${schoolYearId}::uuid
      ORDER BY payments.payment_date DESC, payments.created_at DESC, payments.id DESC
    `);
    return rows<PaymentRow>(result);
  }

  async listPaymentsChronological(studentId: string, schoolYearId: string): Promise<PaymentRow[]> {
    const result = await this.db.execute<PaymentRow>(sql`
      SELECT p.*, p.id::text, p.student_id::text, p.school_year_id::text,
             p.confirmed_by_user_id::text, p.cancelled_by_user_id::text,
             p.payment_date::text
      FROM payments p
      WHERE p.student_id = ${studentId}::uuid
        AND p.school_year_id = ${schoolYearId}::uuid
      ORDER BY p.payment_date ASC, p.created_at ASC, p.id ASC
    `);
    return rows<PaymentRow>(result);
  }

  private cashJournalWhere(input: CashJournalFilterInput, withStatus: boolean) {
    const status = withStatus ? input.status ?? null : null;
    return sql`
      WHERE (${input.schoolYearId ?? null}::uuid IS NULL OR p.school_year_id = ${input.schoolYearId ?? null}::uuid)
        AND (${input.from ?? null}::date IS NULL OR p.payment_date >= ${input.from ?? null}::date)
        AND (${input.to ?? null}::date IS NULL OR p.payment_date <= ${input.to ?? null}::date)
        AND (${input.classId ?? null}::uuid IS NULL OR c.id = ${input.classId ?? null}::uuid)
        AND (${input.method ?? null}::text IS NULL OR p.method::text = ${input.method ?? null})
        AND (${input.includeCancelled === true}::boolean OR p.status = 'confirmed')
        AND (${status}::text IS NULL OR p.status::text = ${status})
        AND p.source <> 'migration_import'
    `;
  }

  async listCashJournal(input: CashJournalFilterInput): Promise<CashJournalRow[]> {
    const result = await this.db.execute<CashJournalRow>(sql`
      SELECT p.*, p.id::text, p.student_id::text, p.school_year_id::text,
             p.confirmed_by_user_id::text, p.cancelled_by_user_id::text,
             p.payment_date::text,
             cu.name AS cancelled_by_name, cu.is_active AS cancelled_by_active,
             s.matricule AS student_matricule,
             format_person_name(s.first_name, s.last_name) AS student_name,
             c.id::text AS class_id,
             c.name AS class_name
      FROM payments p
      INNER JOIN students s ON s.id = p.student_id AND s.is_active = true
      INNER JOIN enrollments e
        ON e.student_id = s.id AND e.school_year_id = p.school_year_id AND e.status = 'confirmed'
      INNER JOIN classes c ON c.id = e.class_id AND c.school_year_id = p.school_year_id AND c.is_active = true
      LEFT JOIN users cu ON cu.id = p.cancelled_by_user_id
      ${this.cashJournalWhere(input, true)}
      ORDER BY p.payment_date DESC, p.created_at DESC, p.id DESC
    `);
    return rows<CashJournalRow>(result);
  }

  async listCashJournalPage(input: CashJournalFilterInput & { limit: number; offset: number }): Promise<CashJournalRow[]> {
    const result = await this.db.execute<CashJournalRow>(sql`
      SELECT p.*, p.id::text, p.student_id::text, p.school_year_id::text,
             p.confirmed_by_user_id::text, p.cancelled_by_user_id::text,
             p.payment_date::text,
             cu.name AS cancelled_by_name, cu.is_active AS cancelled_by_active,
             s.matricule AS student_matricule,
             format_person_name(s.first_name, s.last_name) AS student_name,
             c.id::text AS class_id,
             c.name AS class_name
      FROM payments p
      INNER JOIN students s ON s.id = p.student_id AND s.is_active = true
      INNER JOIN enrollments e
        ON e.student_id = s.id AND e.school_year_id = p.school_year_id AND e.status = 'confirmed'
      INNER JOIN classes c ON c.id = e.class_id AND c.school_year_id = p.school_year_id AND c.is_active = true
      LEFT JOIN users cu ON cu.id = p.cancelled_by_user_id
      ${this.cashJournalWhere(input, true)}
      ORDER BY p.payment_date DESC, p.created_at DESC, p.id DESC
      LIMIT ${input.limit} OFFSET ${input.offset}
    `);
    return rows<CashJournalRow>(result);
  }

  /** Totals ignore `status`: only confirmed payments are summed. */
  async getCashJournalSummary(input: CashJournalFilterInput): Promise<CashJournalSummary> {
    const result = await this.db.execute<CashJournalSummary>(sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE p.status = 'confirmed')::int AS confirmed_count,
        COUNT(*) FILTER (WHERE p.status = 'cancelled')::int AS cancelled_count,
        COALESCE(SUM(CASE WHEN p.status = 'confirmed' AND p.method = 'cash' THEN p.amount ELSE 0 END), 0) AS cash_total,
        COALESCE(SUM(CASE WHEN p.status = 'confirmed' AND p.method = 'mobile_money' THEN p.amount ELSE 0 END), 0) AS mobile_money_total,
        COALESCE(SUM(CASE WHEN p.status = 'confirmed' AND p.method = 'bank_transfer' THEN p.amount ELSE 0 END), 0) AS bank_transfer_total,
        COALESCE(SUM(CASE WHEN p.status = 'confirmed' THEN p.amount ELSE 0 END), 0) AS grand_total
      FROM payments p
      INNER JOIN students s ON s.id = p.student_id AND s.is_active = true
      INNER JOIN enrollments e
        ON e.student_id = s.id AND e.school_year_id = p.school_year_id AND e.status = 'confirmed'
      INNER JOIN classes c ON c.id = e.class_id AND c.school_year_id = p.school_year_id AND c.is_active = true
      ${this.cashJournalWhere(input, false)}
    `);
    return rows<CashJournalSummary>(result)[0] ?? {
      total: 0,
      confirmed_count: 0,
      cancelled_count: 0,
      cash_total: 0,
      mobile_money_total: 0,
      bank_transfer_total: 0,
      grand_total: 0,
    };
  }

  async listPaymentHistoryPage(input: {
    schoolYearId: string;
    from?: string;
    to?: string;
    levelId?: string;
    classId?: string;
    status?: 'up_to_date' | 'late';
    limit: number;
    offset: number;
  }): Promise<PaymentHistoryRow[]> {
    const result = await this.db.execute<PaymentHistoryRow>(sql`
      SELECT p.*, p.id::text, p.student_id::text, p.school_year_id::text,
             p.confirmed_by_user_id::text, p.cancelled_by_user_id::text,
             p.payment_date::text,
             s.matricule AS student_matricule,
             format_person_name(s.first_name, s.last_name) AS student_name,
             c.id::text AS class_id, c.name AS class_name,
             l.id::text AS level_id, l.name AS level_name,
             sfs.status::text AS financial_status
      FROM payments p
      INNER JOIN students s ON s.id = p.student_id AND s.is_active = true
      INNER JOIN enrollments e ON e.student_id = s.id AND e.school_year_id = p.school_year_id AND e.status = 'confirmed'
      INNER JOIN classes c ON c.id = e.class_id AND c.school_year_id = p.school_year_id AND c.is_active = true
      INNER JOIN levels l ON l.id = c.level_id
      LEFT JOIN student_financial_status sfs
        ON sfs.student_id = p.student_id AND sfs.school_year_id = p.school_year_id
      WHERE p.school_year_id = ${input.schoolYearId}::uuid
        AND (${input.from ?? null}::date IS NULL OR p.payment_date >= ${input.from ?? null}::date)
        AND (${input.to ?? null}::date IS NULL OR p.payment_date <= ${input.to ?? null}::date)
        AND (${input.levelId ?? null}::uuid IS NULL OR l.id = ${input.levelId ?? null}::uuid)
        AND (${input.classId ?? null}::uuid IS NULL OR c.id = ${input.classId ?? null}::uuid)
        AND (${input.status ?? null}::text IS NULL OR sfs.status::text = ${input.status ?? null})
        AND p.source <> 'migration_import'
      ORDER BY p.payment_date DESC, p.created_at DESC, p.id DESC
      LIMIT ${input.limit} OFFSET ${input.offset}
    `);
    return rows<PaymentHistoryRow>(result);
  }

  async countPaymentHistory(input: {
    schoolYearId: string;
    from?: string;
    to?: string;
    levelId?: string;
    classId?: string;
    status?: 'up_to_date' | 'late';
  }): Promise<number> {
    const result = await this.db.execute<{ total: string | number }>(sql`
      SELECT COUNT(*)::int AS total
      FROM payments p
      INNER JOIN students s ON s.id = p.student_id AND s.is_active = true
      INNER JOIN enrollments e ON e.student_id = s.id AND e.school_year_id = p.school_year_id AND e.status = 'confirmed'
      INNER JOIN classes c ON c.id = e.class_id AND c.school_year_id = p.school_year_id AND c.is_active = true
      INNER JOIN levels l ON l.id = c.level_id
      LEFT JOIN student_financial_status sfs
        ON sfs.student_id = p.student_id AND sfs.school_year_id = p.school_year_id
      WHERE p.school_year_id = ${input.schoolYearId}::uuid
        AND (${input.from ?? null}::date IS NULL OR p.payment_date >= ${input.from ?? null}::date)
        AND (${input.to ?? null}::date IS NULL OR p.payment_date <= ${input.to ?? null}::date)
        AND (${input.levelId ?? null}::uuid IS NULL OR l.id = ${input.levelId ?? null}::uuid)
        AND (${input.classId ?? null}::uuid IS NULL OR c.id = ${input.classId ?? null}::uuid)
        AND (${input.status ?? null}::text IS NULL OR sfs.status::text = ${input.status ?? null})
        AND p.source <> 'migration_import'
    `);
    return FinanceRepository.toNumber(rows<{ total: string | number }>(result)[0]?.total ?? 0);
  }

  async cancelPayment(id: string, actorUserId: string, reason: string): Promise<PaymentRow | null> {
    const result = await this.db.execute<PaymentRow>(sql`
      UPDATE payments
      SET status = 'cancelled', cancelled_at = NOW(),
          cancelled_by_user_id = ${actorUserId}::uuid, cancellation_reason = ${reason}
      WHERE id = ${id}::uuid
        AND status = 'confirmed'
      RETURNING *, id::text, student_id::text, school_year_id::text,
        confirmed_by_user_id::text, cancelled_by_user_id::text
    `);
    return rows<PaymentRow>(result)[0] ?? null;
  }

  async lockEnrollment(id: string): Promise<{
    id: string; student_id: string; school_year_id: string; status: string;
  } | null> {
    const result = await this.db.execute<{
      id: string; student_id: string; school_year_id: string; status: string;
    }>(sql`
      SELECT id::text, student_id::text, school_year_id::text, status::text
      FROM enrollments WHERE id = ${id}::uuid FOR UPDATE
    `);
    return rows<{ id: string; student_id: string; school_year_id: string; status: string }>(result)[0] ?? null;
  }

  async confirmEnrollment(id: string, actorUserId: string): Promise<void> {
    const context = await this.db.execute<{ class_id: string; previous_class_id: string | null }>(sql`
      SELECT e.class_id, s.class_id AS previous_class_id
      FROM enrollments e JOIN students_with_class s ON s.id = e.student_id
      WHERE e.id = ${id}::uuid
    `);
    const membership = rows<{ class_id: string; previous_class_id: string | null }>(context)[0];
    if (!membership) return;
    // The service already holds the enrollment lock in its payment transaction.
    // Serialize class counts before changing membership; a fresh statement then
    // sees confirmed enrollments without copying their class onto the profile.
    await this.db.execute(sql`
      SELECT id FROM classes WHERE id IN (${membership.class_id}::uuid, ${membership.previous_class_id}::uuid)
      ORDER BY id FOR UPDATE
    `);
    await this.db.execute(sql`
      UPDATE enrollments SET status = 'confirmed', confirmed_by_user_id = ${actorUserId}::uuid, updated_at = NOW()
      WHERE id = ${id}::uuid
    `);
    await this.db.execute(sql`
      UPDATE classes class
      SET student_count = ${confirmedSchoolClassCount(sql`class.id`, sql`class.school_year_id`)}
      WHERE class.id IN (${membership.previous_class_id}::uuid, ${membership.class_id}::uuid)
    `);
  }

  async createTuitionOverride(input: {
    studentId: string;
    schoolYearId: string;
    overrideTotalAmount?: number;
    discountAmount?: number;
    reason: string;
    grantedByUserId: string;
  }) {
    const result = await this.db.execute(sql`
      INSERT INTO student_tuition_overrides (
        student_id, school_year_id, override_total_amount, discount_amount, reason, granted_by_user_id
      ) VALUES (
        ${input.studentId}::uuid, ${input.schoolYearId}::uuid,
        ${input.overrideTotalAmount ?? null}, ${input.discountAmount ?? null},
        ${input.reason}, ${input.grantedByUserId}::uuid
      )
      RETURNING *, id::text, student_id::text, school_year_id::text, granted_by_user_id::text
    `);
    return rows(result)[0];
  }

  async getActiveTuitionOverride(studentId: string, schoolYearId: string): Promise<TuitionOverride | null> {
    const result = await this.db.execute(sql`SELECT id::text, student_id::text, school_year_id::text, override_total_amount, discount_amount, reason, granted_by_user_id::text, status, created_at FROM student_tuition_overrides WHERE student_id=${studentId}::uuid AND school_year_id=${schoolYearId}::uuid AND status='active' LIMIT 1`);
    const row = rows<Record<string, unknown>>(result)[0];
    return row ? { id: String(row.id), studentId: String(row.student_id), schoolYearId: String(row.school_year_id), overrideTotalAmount: row.override_total_amount === null ? null : FinanceRepository.toNumber(row.override_total_amount as string | number), discountAmount: row.discount_amount === null ? null : FinanceRepository.toNumber(row.discount_amount as string | number), reason: String(row.reason), grantedByUserId: String(row.granted_by_user_id), status: 'active', createdAt: row.created_at as string | Date } : null;
  }

  async withdrawTuitionOverride(id: string, actorUserId: string, reason: string): Promise<TuitionOverride | null> {
    const result = await this.db.execute(sql`UPDATE student_tuition_overrides SET status='withdrawn', withdrawn_at=NOW(), withdrawn_by_user_id=${actorUserId}::uuid, withdrawal_reason=${reason} WHERE id=${id}::uuid AND status='active' RETURNING id::text, student_id::text, school_year_id::text, override_total_amount, discount_amount, reason, granted_by_user_id::text, status, created_at`);
    const row = rows<Record<string, unknown>>(result)[0];
    return row ? { id: String(row.id), studentId: String(row.student_id), schoolYearId: String(row.school_year_id), overrideTotalAmount: row.override_total_amount === null ? null : FinanceRepository.toNumber(row.override_total_amount as string | number), discountAmount: row.discount_amount === null ? null : FinanceRepository.toNumber(row.discount_amount as string | number), reason: String(row.reason), grantedByUserId: String(row.granted_by_user_id), status: 'withdrawn', createdAt: row.created_at as string | Date } : null;
  }

  async recordTuitionOverrideAudit(input: { actorUserId: string; actorRole: string; action: 'tuition.override.created' | 'tuition.override.withdrawn'; before: Record<string, unknown> | null; after: Record<string, unknown> }) {
    await this.db.execute(sql`INSERT INTO public.audit_financial_events (tenant_id, actor_id, actor_role, action, payload_before, payload_after) SELECT id, ${input.actorUserId}::uuid, ${input.actorRole}, ${input.action}, ${input.before === null ? null : JSON.stringify(input.before)}::jsonb, ${JSON.stringify(input.after)}::jsonb FROM public.tenants WHERE schema_name=current_schema()`);
  }

  async getSchoolYearDateRange(schoolYearId: string): Promise<{ startDate: string; endDate: string } | null> {
    const result = await this.db.execute<{ start_date: string; end_date: string }>(sql`
      SELECT start_date::text, end_date::text FROM school_years WHERE id = ${schoolYearId}::uuid LIMIT 1
    `);
    const year = rows<{ start_date: string; end_date: string }>(result)[0];
    return year ? { startDate: year.start_date, endDate: year.end_date } : null;
  }

  async getStudentTuitionScheduleAgreement(
    studentId: string,
    schoolYearId: string
  ): Promise<StudentTuitionScheduleAgreement | null> {
    const result = await this.db.execute<{
      id: string; student_id: string; school_year_id: string; reason: string;
      created_by_user_id: string | null; updated_by_user_id: string | null; updated_by_name: string | null;
      created_at: string | Date; updated_at: string | Date; schedule_steps: unknown;
    }>(sql`
      SELECT agreement.id::text, agreement.student_id::text, agreement.school_year_id::text,
             agreement.reason, agreement.created_by_user_id::text, agreement.updated_by_user_id::text,
             updated_by.name AS updated_by_name,
             agreement.created_at, agreement.updated_at,
             COALESCE(json_agg(json_build_object(
               'dueDate', step.due_date::text,
               'cumulativeAmountExpected', step.cumulative_amount_expected
             ) ORDER BY step.due_date) FILTER (WHERE step.id IS NOT NULL), '[]'::json) AS schedule_steps
      FROM student_tuition_schedule_agreements agreement
      LEFT JOIN student_tuition_schedule_steps step ON step.agreement_id = agreement.id
      LEFT JOIN users updated_by ON updated_by.id = agreement.updated_by_user_id
      WHERE agreement.student_id = ${studentId}::uuid AND agreement.school_year_id = ${schoolYearId}::uuid AND agreement.status = 'active'
      GROUP BY agreement.id, updated_by.name
      LIMIT 1
    `);
    const agreement = rows<{
      id: string; student_id: string; school_year_id: string; reason: string;
      created_by_user_id: string | null; updated_by_user_id: string | null; updated_by_name: string | null;
      created_at: string | Date; updated_at: string | Date; schedule_steps: unknown;
    }>(result)[0];
    if (!agreement) return null;
    const scheduleSteps = Array.isArray(agreement.schedule_steps) ? agreement.schedule_steps : [];
    return {
      id: agreement.id,
      studentId: agreement.student_id,
      schoolYearId: agreement.school_year_id,
      reason: agreement.reason,
      createdByUserId: agreement.created_by_user_id,
      updatedByUserId: agreement.updated_by_user_id,
      updatedByName: agreement.updated_by_name,
      createdAt: agreement.created_at,
      updatedAt: agreement.updated_at,
      scheduleSteps: scheduleSteps.map((step) => {
        const row = step as { dueDate?: string; cumulativeAmountExpected?: string | number };
        return {
          dueDate: String(row.dueDate ?? ''),
          cumulativeAmountExpected: FinanceRepository.toNumber(row.cumulativeAmountExpected),
        };
      }),
    };
  }

  async replaceStudentTuitionSchedule(input: {
    studentId: string;
    schoolYearId: string;
    reason: string;
    actorUserId: string;
    scheduleSteps: readonly CumulativeScheduleStep[];
  }): Promise<StudentTuitionScheduleAgreement> {
    const existing = await this.getStudentTuitionScheduleAgreement(input.studentId, input.schoolYearId);
    if (existing) {
      await this.db.execute(sql`
        UPDATE student_tuition_schedule_agreements
        SET status = 'replaced', closed_at = NOW(), closed_by_user_id = ${input.actorUserId}::uuid,
            closure_reason = ${input.reason}, updated_at = NOW()
        WHERE id = ${existing.id}::uuid AND status = 'active'
      `);
    }
    const agreementId = rows<{ id: string }>(await this.db.execute<{ id: string }>(sql`
      INSERT INTO student_tuition_schedule_agreements (
        student_id, school_year_id, reason, created_by_user_id, updated_by_user_id
      ) VALUES (
        ${input.studentId}::uuid, ${input.schoolYearId}::uuid, ${input.reason},
        ${input.actorUserId}::uuid, ${input.actorUserId}::uuid
      ) RETURNING id::text
    `))[0]?.id;
    if (!agreementId) throw new Error('Failed to create student tuition schedule agreement');
    if (existing) await this.db.execute(sql`UPDATE student_tuition_schedule_agreements SET replaced_by_agreement_id=${agreementId}::uuid WHERE id=${existing.id}::uuid`);
    for (const step of input.scheduleSteps) {
      await this.db.execute(sql`
        INSERT INTO student_tuition_schedule_steps (agreement_id, due_date, cumulative_amount_expected)
        VALUES (${agreementId}::uuid, ${step.dueDate}::date, ${step.cumulativeAmountExpected})
      `);
    }
    const agreement = await this.getStudentTuitionScheduleAgreement(input.studentId, input.schoolYearId);
    if (!agreement) throw new Error('Failed to load student tuition schedule agreement');
    return agreement;
  }

  async deleteStudentTuitionSchedule(studentId: string, schoolYearId: string, actorUserId: string, reason: string): Promise<StudentTuitionScheduleAgreement | null> {
    const agreement = await this.getStudentTuitionScheduleAgreement(studentId, schoolYearId);
    if (!agreement) return null;
    await this.db.execute(sql`UPDATE student_tuition_schedule_agreements SET status='reset', closed_at=NOW(), closed_by_user_id=${actorUserId}::uuid, closure_reason=${reason}, updated_at=NOW() WHERE id=${agreement.id}::uuid AND status='active'`);
    return agreement;
  }

  async recordStudentTuitionScheduleAudit(input: {
    actorUserId: string;
    actorRole: string;
    action: 'tuition.student_schedule.created' | 'tuition.student_schedule.updated' | 'tuition.student_schedule.reset';
    before: Record<string, unknown> | null;
    after: Record<string, unknown>;
  }): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO public.audit_financial_events (
        tenant_id, actor_id, actor_role, action, payload_before, payload_after
      )
      SELECT id, ${input.actorUserId}::uuid, ${input.actorRole}, ${input.action},
             ${input.before === null ? null : JSON.stringify(input.before)}::jsonb,
             ${JSON.stringify(input.after)}::jsonb
      FROM public.tenants WHERE schema_name = current_schema()
    `);
  }

  async notifyDirectorOfOverride(input: {
    overrideId: string;
    studentName: string;
    reason: string;
    amountLabel: string;
  }): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO notifications_log (
        type, channel, recipient_id, recipient_phone, recipient_email,
        message, metadata, status, related_id, sent_at
      )
      SELECT
        'custom', 'in_app', u.id, COALESCE(u.phone, ''), u.email,
        ${`Nouvelle remise de frais accordée à ${input.studentName} (${input.amountLabel}). Motif : ${input.reason}`},
        ${JSON.stringify({ event: 'tuition_discount_granted' })}::jsonb,
        'delivered', ${input.overrideId}::uuid, NOW()
      FROM users u
      WHERE u.role = 'director' AND u.is_active = true
      ORDER BY u.created_at ASC
      LIMIT 1
    `);
  }

  async upsertTuitionPlan(levelId: string, input: UpsertTuitionPlanInput) {
    return this.db.transaction(async (tx) => {
      const repository = new FinanceRepository(tx as FinanceDb);
      const schoolYear = await repository.db.execute<{ status: string }>(sql`
        SELECT status FROM school_years WHERE id = ${input.schoolYearId}::uuid FOR SHARE
      `);
      if (rows<{ status: string }>(schoolYear)[0]?.status !== 'active') {
        throw Object.assign(new Error('L’année scolaire doit être ouverte par le support.'), { code: 'SCHOOL_YEAR_NOT_OPEN' });
      }
      const result = await repository.db.execute<{ id: string }>(sql`
        INSERT INTO tuition_plans (level_id, school_year_id, total_amount, registration_amount, currency)
        VALUES (${levelId}::uuid, ${input.schoolYearId}::uuid, ${input.totalAmount}, ${input.registrationAmount}, ${input.currency})
        ON CONFLICT (level_id, school_year_id) DO UPDATE SET
          total_amount = EXCLUDED.total_amount,
          registration_amount = EXCLUDED.registration_amount,
          currency = EXCLUDED.currency,
          updated_at = NOW()
        RETURNING id::text
      `);
      const planId = rows<{ id: string }>(result)[0]!.id;
      await repository.db.execute(sql`DELETE FROM tuition_schedule_steps WHERE tuition_plan_id = ${planId}::uuid`);
      for (const step of input.scheduleSteps) {
        await repository.db.execute(sql`
          INSERT INTO tuition_schedule_steps (tuition_plan_id, due_date, cumulative_amount_expected)
          VALUES (${planId}::uuid, ${step.dueDate}::date, ${step.cumulativeAmountExpected})
        `);
      }
      return repository.getTuitionPlan(planId);
    });
  }

  async getTuitionPlan(id: string) {
    const result = await this.db.execute(sql`
      SELECT tp.*, tp.id::text, tp.level_id::text, tp.school_year_id::text,
        l.name AS level_name, sy.label AS school_year_label,
        COALESCE(json_agg(json_build_object(
          'id', tss.id::text,
          'dueDate', tss.due_date::text,
          'cumulativeAmountExpected', tss.cumulative_amount_expected
        ) ORDER BY tss.due_date) FILTER (WHERE tss.id IS NOT NULL), '[]'::json) AS schedule_steps
      FROM tuition_plans tp
      INNER JOIN levels l ON l.id = tp.level_id
      INNER JOIN school_years sy ON sy.id = tp.school_year_id
      LEFT JOIN tuition_schedule_steps tss ON tss.tuition_plan_id = tp.id
      WHERE tp.id = ${id}::uuid
      GROUP BY tp.id, l.name, sy.label
    `);
    return rows(result)[0] ?? null;
  }

  async listTuitionPlans(schoolYearId: string, levelId?: string) {
    const result = await this.db.execute(sql`
      SELECT tp.id::text, tp.level_id::text, l.name AS level_name,
             tp.school_year_id::text, sy.label AS school_year_label,
             tp.total_amount, tp.registration_amount, tp.currency, tp.created_at, tp.updated_at,
             COALESCE(json_agg(json_build_object(
               'id', tss.id::text,
               'dueDate', tss.due_date::text,
               'cumulativeAmountExpected', tss.cumulative_amount_expected
             ) ORDER BY tss.due_date) FILTER (WHERE tss.id IS NOT NULL), '[]'::json) AS schedule_steps
      FROM tuition_plans tp
      INNER JOIN levels l ON l.id = tp.level_id
      INNER JOIN school_years sy ON sy.id = tp.school_year_id
      LEFT JOIN tuition_schedule_steps tss ON tss.tuition_plan_id = tp.id
      WHERE tp.school_year_id = ${schoolYearId}::uuid
        AND (${levelId ?? null}::uuid IS NULL OR tp.level_id = ${levelId ?? null}::uuid)
      GROUP BY tp.id, l.name, sy.label
      ORDER BY l.name
    `);
    return rows(result);
  }

  async listProviderSettings() {
    const result = await this.db.execute(sql`
      SELECT id::text, provider::text, merchant_number, is_active,
             api_credentials <> '{}'::jsonb AS has_credentials,
             created_at, updated_at
      FROM payment_provider_settings ORDER BY provider
    `);
    return rows(result);
  }

  async getProviderAvailability() {
    const result = await this.db.execute<{ provider: MobileMoneyProvider; merchant_number: string }>(sql`
      SELECT provider::text AS provider, merchant_number
      FROM payment_provider_settings
      WHERE is_active = true AND api_credentials <> '{}'::jsonb
      ORDER BY provider
    `);
    return rows<{ provider: MobileMoneyProvider; merchant_number: string }>(result);
  }

  async listManualPaymentChannels() {
    const result = await this.db.execute<{ provider: MobileMoneyProvider; merchant_number: string }>(sql`
      SELECT provider::text AS provider, merchant_number
      FROM payment_provider_settings
      WHERE length(trim(merchant_number)) > 0
      ORDER BY provider
    `);
    return rows<{ provider: MobileMoneyProvider; merchant_number: string }>(result);
  }

  async upsertProviderSetting(input: {
    provider: MobileMoneyProvider;
    merchantNumber: string;
    apiCredentials: Record<string, unknown>;
    isActive: boolean;
  }) {
    const result = await this.db.execute(sql`
      INSERT INTO payment_provider_settings (provider, merchant_number, api_credentials, is_active)
      VALUES (${input.provider}::mobile_money_provider, ${input.merchantNumber},
              ${JSON.stringify(input.apiCredentials)}::jsonb, ${input.isActive})
      ON CONFLICT (provider) DO UPDATE SET
        merchant_number = EXCLUDED.merchant_number,
        api_credentials = CASE
          WHEN EXCLUDED.api_credentials <> '{}'::jsonb THEN EXCLUDED.api_credentials
          ELSE payment_provider_settings.api_credentials
        END,
        is_active = EXCLUDED.is_active,
        updated_at = NOW()
      RETURNING id::text, provider::text, merchant_number, is_active,
                api_credentials <> '{}'::jsonb AS has_credentials, created_at, updated_at
    `);
    return rows(result)[0];
  }

  async getReceiptContext(paymentId: string): Promise<ReceiptContextRow | null> {
    const result = await this.db.execute<ReceiptContextRow>(sql`
      SELECT p.*, p.id::text, p.student_id::text, p.school_year_id::text,
             p.confirmed_by_user_id::text, p.cancelled_by_user_id::text,
             format_person_name(s.first_name, s.last_name) AS student_name,
             c.name AS class_name, sy.label AS school_year_label,
             COALESCE(tp.currency, 'FCFA') AS currency,
             allocation.total_amount AS enrollment_total_amount,
             allocation.parent_alerts_amount AS enrollment_parent_alerts_amount,
             allocation.show_parent_alerts_on_receipt
      FROM payments p
      INNER JOIN students s ON s.id = p.student_id AND s.is_active = true
      INNER JOIN school_years sy ON sy.id = p.school_year_id
      INNER JOIN enrollments e ON e.student_id = p.student_id AND e.school_year_id = p.school_year_id AND e.status = 'confirmed'
      INNER JOIN classes c ON c.id = e.class_id AND c.school_year_id = p.school_year_id AND c.is_active = true
      LEFT JOIN tuition_plans tp
        ON tp.level_id = c.level_id
       AND tp.school_year_id = p.school_year_id
      LEFT JOIN enrollment_payment_allocations allocation
        ON allocation.payment_id = p.id
      WHERE p.id = ${paymentId}::uuid
      ORDER BY e.enrolled_at DESC NULLS LAST
      LIMIT 1
    `);
    return rows<ReceiptContextRow>(result)[0] ?? null;
  }
}
