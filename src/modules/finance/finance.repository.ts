import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type {
  MobileMoneyProvider,
  PaymentMethod,
  SubscriptionPlanInput,
  UpsertTuitionPlanInput,
} from './finance.types.js';
import type { PaymentStatus, SubscriptionPeriod } from './finance.calculations.js';

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
  created_at: string | Date;
};

export type CashJournalRow = PaymentRow & {
  student_matricule: string | null;
  student_name: string;
  class_id: string;
  class_name: string;
};

export type AmountDueContext = {
  student_id: string;
  student_name: string;
  class_id: string;
  class_name: string;
  school_year_id: string;
  plan_id: string;
  plan_total_amount: string | number;
  currency: string;
  override_total_amount: string | number | null;
  discount_amount: string | number | null;
};

export type MandatorySubscriptionPlanRow = {
  id: string;
  amount: string | number;
  period: SubscriptionPeriod;
  imposed_duration: SubscriptionPeriod;
  label: string;
  show_on_receipt_as_separate_line: boolean;
};

export type ReceiptContextRow = PaymentRow & {
  student_name: string;
  class_name: string;
  school_year_label: string;
  currency: string;
};

export class FinanceRepository {
  constructor(readonly db: FinanceDb) {}

  static toNumber(value: string | number | null | undefined): number {
    const parsed = typeof value === 'number' ? value : Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  async getAmountDueContext(studentId: string, schoolYearId: string): Promise<AmountDueContext | null> {
    const result = await this.db.execute<AmountDueContext>(sql`
      SELECT
        s.id::text AS student_id,
        concat_ws(' ', s.first_name, s.last_name) AS student_name,
        c.id::text AS class_id,
        c.name AS class_name,
        ${schoolYearId}::uuid::text AS school_year_id,
        tp.id::text AS plan_id,
        tp.total_amount AS plan_total_amount,
        tp.currency,
        sto.override_total_amount,
        sto.discount_amount
      FROM students s
      LEFT JOIN enrollments e
        ON e.student_id = s.id
       AND e.school_year_id = ${schoolYearId}::uuid
      INNER JOIN classes c
        ON c.id = COALESCE(e.class_id, s.class_id)
       AND c.school_year_id = ${schoolYearId}::uuid
      INNER JOIN tuition_plans tp
        ON tp.level_id = c.level_id
       AND tp.school_year_id = ${schoolYearId}::uuid
      LEFT JOIN student_tuition_overrides sto
        ON sto.student_id = s.id
       AND sto.school_year_id = ${schoolYearId}::uuid
      WHERE s.id = ${studentId}::uuid
      ORDER BY e.enrolled_at DESC NULLS LAST
      LIMIT 1
    `);
    return rows<AmountDueContext>(result)[0] ?? null;
  }

  async listMandatorySubscriptionPlans(): Promise<MandatorySubscriptionPlanRow[]> {
    const result = await this.db.execute<MandatorySubscriptionPlanRow>(sql`
      SELECT id::text, amount, period::text, imposed_duration::text, label,
             show_on_receipt_as_separate_line
      FROM subscription_plans
      WHERE is_mandatory_at_enrollment = true
      ORDER BY created_at ASC
    `);
    return rows<MandatorySubscriptionPlanRow>(result);
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

  async getExpectedAtDate(studentId: string, schoolYearId: string, asOfDate: string): Promise<number> {
    const result = await this.db.execute<{ expected: string | number }>(sql`
      SELECT COALESCE(tss.cumulative_amount_expected, 0) AS expected
      FROM students s
      LEFT JOIN enrollments e
        ON e.student_id = s.id
       AND e.school_year_id = ${schoolYearId}::uuid
      INNER JOIN classes c
        ON c.id = COALESCE(e.class_id, s.class_id)
       AND c.school_year_id = ${schoolYearId}::uuid
      INNER JOIN tuition_plans tp
        ON tp.level_id = c.level_id
       AND tp.school_year_id = ${schoolYearId}::uuid
      LEFT JOIN LATERAL (
        SELECT cumulative_amount_expected
        FROM tuition_schedule_steps
        WHERE tuition_plan_id = tp.id
          AND due_date <= ${asOfDate}::date
        ORDER BY due_date DESC
        LIMIT 1
      ) tss ON true
      WHERE s.id = ${studentId}::uuid
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
    const result = await this.db.execute<PaymentRow>(sql`
      INSERT INTO payments (
        student_id, school_year_id, amount, method, source, status,
        confirmed_by_user_id, provider_reference, school_receipt_reference, receipt_number,
        payment_date
      ) VALUES (
        ${input.studentId}::uuid, ${input.schoolYearId}::uuid, ${input.amount},
        ${input.method}::finance_payment_method, ${input.source}::payment_source, 'confirmed',
        ${input.confirmedByUserId ?? null}::uuid, ${input.providerReference ?? null},
        ${input.schoolReceiptReference ?? null}, ${input.receiptNumber},
        COALESCE(${input.paymentDate ?? null}::date, CURRENT_DATE)
      )
      RETURNING *, id::text, student_id::text, school_year_id::text,
        confirmed_by_user_id::text, cancelled_by_user_id::text
    `);
    const payment = rows<PaymentRow>(result)[0];
    if (!payment) throw new Error('Failed to insert payment');
    return payment;
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

  async listCashJournal(input: {
    schoolYearId?: string;
    from?: string;
    to?: string;
    classId?: string;
    method?: PaymentMethod;
  }): Promise<CashJournalRow[]> {
    const result = await this.db.execute<CashJournalRow>(sql`
      SELECT p.*, p.id::text, p.student_id::text, p.school_year_id::text,
             p.confirmed_by_user_id::text, p.cancelled_by_user_id::text,
             p.payment_date::text,
             s.matricule AS student_matricule,
             concat_ws(' ', s.first_name, s.last_name) AS student_name,
             c.id::text AS class_id,
             c.name AS class_name
      FROM payments p
      INNER JOIN students s ON s.id = p.student_id
      LEFT JOIN enrollments e
        ON e.student_id = s.id AND e.school_year_id = p.school_year_id
      INNER JOIN classes c ON c.id = COALESCE(e.class_id, s.class_id)
      WHERE (${input.schoolYearId ?? null}::uuid IS NULL OR p.school_year_id = ${input.schoolYearId ?? null}::uuid)
        AND (${input.from ?? null}::date IS NULL OR p.payment_date >= ${input.from ?? null}::date)
        AND (${input.to ?? null}::date IS NULL OR p.payment_date <= ${input.to ?? null}::date)
        AND (${input.classId ?? null}::uuid IS NULL OR c.id = ${input.classId ?? null}::uuid)
        AND (${input.method ?? null}::text IS NULL OR p.method::text = ${input.method ?? null})
      ORDER BY p.payment_date DESC, p.created_at DESC, p.id DESC
    `);
    return rows<CashJournalRow>(result);
  }

  async cancelPayment(id: string, actorUserId: string, reason: string): Promise<PaymentRow | null> {
    const result = await this.db.execute<PaymentRow>(sql`
      UPDATE payments
      SET status = 'cancelled', cancelled_at = NOW(),
          cancelled_by_user_id = ${actorUserId}::uuid, cancellation_reason = ${reason}
      WHERE id = ${id}::uuid
        AND status IN ('confirmed', 'waived_by_school')
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
    await this.db.execute(sql`
      UPDATE enrollments
      SET status = 'confirmed', confirmed_by_user_id = ${actorUserId}::uuid, updated_at = NOW()
      WHERE id = ${id}::uuid
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
      const result = await repository.db.execute<{ id: string }>(sql`
        INSERT INTO tuition_plans (level_id, school_year_id, total_amount, currency)
        VALUES (${levelId}::uuid, ${input.schoolYearId}::uuid, ${input.totalAmount}, ${input.currency})
        ON CONFLICT (level_id, school_year_id) DO UPDATE SET
          total_amount = EXCLUDED.total_amount,
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
             tp.total_amount, tp.currency, tp.created_at, tp.updated_at,
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

  async listSubscriptionPlans() {
    const result = await this.db.execute(sql`
      SELECT id::text, amount, period::text, label, is_mandatory_at_enrollment,
             imposed_duration::text, show_on_receipt_as_separate_line, created_at, updated_at
      FROM subscription_plans ORDER BY created_at
    `);
    return rows(result);
  }

  async createSubscriptionPlan(input: SubscriptionPlanInput) {
    const result = await this.db.execute(sql`
      INSERT INTO subscription_plans (
        amount, period, label, is_mandatory_at_enrollment,
        imposed_duration, show_on_receipt_as_separate_line
      ) VALUES (
        ${input.amount}, ${input.period}::subscription_period, ${input.label},
        ${input.isMandatoryAtEnrollment}, ${input.imposedDuration ?? null}::subscription_period,
        ${input.showOnReceiptAsSeparateLine}
      )
      RETURNING *, id::text, period::text, imposed_duration::text
    `);
    return rows(result)[0];
  }

  async updateSubscriptionPlan(id: string, input: SubscriptionPlanInput) {
    const result = await this.db.execute(sql`
      UPDATE subscription_plans SET
        amount = ${input.amount}, period = ${input.period}::subscription_period,
        label = ${input.label}, is_mandatory_at_enrollment = ${input.isMandatoryAtEnrollment},
        imposed_duration = ${input.imposedDuration ?? null}::subscription_period,
        show_on_receipt_as_separate_line = ${input.showOnReceiptAsSeparateLine},
        updated_at = NOW()
      WHERE id = ${id}::uuid
      RETURNING *, id::text, period::text, imposed_duration::text
    `);
    return rows(result)[0] ?? null;
  }

  async getReceiptContext(paymentId: string): Promise<ReceiptContextRow | null> {
    const result = await this.db.execute<ReceiptContextRow>(sql`
      SELECT p.*, p.id::text, p.student_id::text, p.school_year_id::text,
             p.confirmed_by_user_id::text, p.cancelled_by_user_id::text,
             concat_ws(' ', s.first_name, s.last_name) AS student_name,
             c.name AS class_name, sy.label AS school_year_label,
             COALESCE(tp.currency, 'FCFA') AS currency
      FROM payments p
      INNER JOIN students s ON s.id = p.student_id
      INNER JOIN school_years sy ON sy.id = p.school_year_id
      LEFT JOIN enrollments e ON e.student_id = p.student_id AND e.school_year_id = p.school_year_id
      LEFT JOIN classes c ON c.id = COALESCE(e.class_id, s.class_id)
      LEFT JOIN tuition_plans tp
        ON tp.level_id = c.level_id
       AND tp.school_year_id = p.school_year_id
      WHERE p.id = ${paymentId}::uuid
      ORDER BY e.enrolled_at DESC NULLS LAST
      LIMIT 1
    `);
    return rows<ReceiptContextRow>(result)[0] ?? null;
  }
}
