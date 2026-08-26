import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';

import {
  calculateStudentTotalDue,
  canCancelPayment,
  prorateSubscriptionAmount,
  resolveFinancialStanding,
} from './finance.calculations.js';
import {
  FinanceRepository,
  type FinanceDb,
  type PaymentRow,
} from './finance.repository.js';
import { FinancialCacheRepository } from './financial-cache.repository.js';
import { FinancialCacheService } from './financial-cache.service.js';
import { FinancialAlertsRepository } from './financial-alerts.repository.js';

export const FINANCIAL_ALERT_RULE_TYPES = ['preventive', 'late', 'severe_late'] as const;
export type FinancialAlertRuleType = typeof FINANCIAL_ALERT_RULE_TYPES[number];
import { calculateRunningBalances } from './finance.reports.js';
import type {
  MobileMoneyProvider,
  PaymentMethod,
  SubscriptionPlanInput,
  UpsertTuitionPlanInput,
} from './finance.types.js';

export class FinanceModuleError extends Error {
  constructor(message: string, public readonly statusCode: number, public readonly code: string) {
    super(message);
    this.name = 'FinanceModuleError';
  }
}

const todayIso = (): string => new Date().toISOString().slice(0, 10);
const iso = (value: string | Date | null): string | null => value ? new Date(value).toISOString() : null;
const receiptNumber = (): string => `REC-${randomUUID()}`;

const mapPayment = (row: PaymentRow) => ({
  id: row.id,
  studentId: row.student_id,
  schoolYearId: row.school_year_id,
  amount: FinanceRepository.toNumber(row.amount),
  method: row.method,
  source: row.source,
  status: row.status,
  confirmedByUserId: row.confirmed_by_user_id,
  providerReference: row.provider_reference,
  schoolReceiptReference: row.school_receipt_reference,
  receiptNumber: row.receipt_number,
  cancelledAt: iso(row.cancelled_at),
  cancelledByUserId: row.cancelled_by_user_id,
  cancellationReason: row.cancellation_reason,
  paymentDate: row.payment_date,
  createdAt: iso(row.created_at),
});

export class FinanceService {
  constructor(private readonly repository: FinanceRepository) {}

  private async amountDueWith(repository: FinanceRepository, studentId: string, schoolYearId: string) {
    const context = await repository.getAmountDueContext(studentId, schoolYearId);
    const subscriptionPlans = await repository.listMandatorySubscriptionPlans();
    if (!context) {
      throw new FinanceModuleError(
        'A tuition plan is required for the student level and school year',
        409,
        'TUITION_PLAN_REQUIRED'
      );
    }
    const subscriptionLines = subscriptionPlans.map((plan) => ({
      id: plan.id,
      label: plan.label,
      amount: prorateSubscriptionAmount(
        FinanceRepository.toNumber(plan.amount),
        plan.period,
        plan.imposed_duration
      ),
      showSeparately: plan.show_on_receipt_as_separate_line,
    }));
    const totalDue = calculateStudentTotalDue({
      planTotalAmount: FinanceRepository.toNumber(context.plan_total_amount),
      overrideTotalAmount: context.override_total_amount === null
        ? null
        : FinanceRepository.toNumber(context.override_total_amount),
      discountAmount: context.discount_amount === null
        ? null
        : FinanceRepository.toNumber(context.discount_amount),
      mandatorySubscriptionAmounts: subscriptionLines.map((line) => line.amount),
    });
    return {
      ...context,
      planTotalAmount: FinanceRepository.toNumber(context.plan_total_amount),
      overrideTotalAmount: context.override_total_amount === null
        ? null
        : FinanceRepository.toNumber(context.override_total_amount),
      discountAmount: context.discount_amount === null
        ? null
        : FinanceRepository.toNumber(context.discount_amount),
      subscriptionLines,
      totalDue,
    };
  }

  async getAmountDue(studentId: string, schoolYearId: string) {
    return this.amountDueWith(this.repository, studentId, schoolYearId);
  }

  async getSchoolFinancialSummary(schoolYearId?: string) {
    const cache = new FinancialCacheService(new FinancialCacheRepository(this.repository.db));
    return cache.getSchoolSummary(schoolYearId);
  }

  async listClassFinancialSummaries(schoolYearId?: string) {
    const cache = new FinancialCacheService(new FinancialCacheRepository(this.repository.db));
    return cache.listClassSummaries(schoolYearId);
  }

  async getStudentFinancialCache(studentId: string, schoolYearId?: string) {
    const cache = new FinancialCacheService(new FinancialCacheRepository(this.repository.db));
    return cache.getStudentCachedStatus(studentId, schoolYearId);
  }

  // ── Relances de paiement (Tâche 6b) ───────────────────────────────────────
  listFinancialAlertRules() {
    const repository = new FinancialAlertsRepository(this.repository.db);
    return repository.listRules();
  }

  upsertFinancialAlertRule(
    type: 'preventive' | 'late' | 'severe_late',
    input: { daysOffset: number; channel: 'sms' | 'in_app' | 'both'; isActive: boolean },
    actorUserId: string
  ) {
    if (!FINANCIAL_ALERT_RULE_TYPES.includes(type)) {
      throw new FinanceModuleError('Type de relance inconnu', 400, 'INVALID_ALERT_RULE_TYPE');
    }
    const repository = new FinancialAlertsRepository(this.repository.db);
    return repository.upsertRule({ type, ...input, createdByUserId: actorUserId });
  }

  deleteFinancialAlertRule(id: string) {
    const repository = new FinancialAlertsRepository(this.repository.db);
    return repository.deleteRule(id);
  }

  listFinancialAlertLogs(limit = 100) {
    const repository = new FinancialAlertsRepository(this.repository.db);
    return repository.listLogs(limit);
  }

  async getFinancialStatus(studentId: string, schoolYearId: string, asOfDate = todayIso()) {    const due = await this.getAmountDue(studentId, schoolYearId);
    const confirmedPaid = await this.repository.getConfirmedPaid(studentId, schoolYearId);
    const cumulativeExpectedAtDate = await this.repository.getExpectedAtDate(
      studentId,
      schoolYearId,
      asOfDate
    );
    return {
      studentId,
      schoolYearId,
      asOfDate,
      currency: due.currency,
      totalDue: due.totalDue,
      confirmedPaid,
      remainingDue: Math.max(0, Math.round((due.totalDue - confirmedPaid) * 100) / 100),
      cumulativeExpectedAtDate,
      standing: resolveFinancialStanding(confirmedPaid, cumulativeExpectedAtDate),
    };
  }

  async recordManualPayment(input: {
    studentId: string;
    schoolYearId: string;
    amount: number;
    method: PaymentMethod;
    actorUserId: string;
    providerReference?: string;
    schoolReceiptReference?: string;
  }) {
    return this.repository.db.transaction(async (tx) => {
      const repository = new FinanceRepository(tx as FinanceDb);
      const service = new FinanceService(repository);
      await service.getAmountDue(input.studentId, input.schoolYearId);
      const payment = await repository.insertPayment({
        ...input,
        source: 'cashier_manual',
        confirmedByUserId: input.actorUserId,
        receiptNumber: receiptNumber(),
      });
      const financialStatus = await service.getFinancialStatus(input.studentId, input.schoolYearId);
      if (financialStatus.remainingDue === 0) {
        await repository.unblockReEnrollmentsAfterSettlement(input.studentId, input.schoolYearId);
      }
      await new FinancialCacheService(
        new FinancialCacheRepository(tx as FinanceDb)
      ).recalcStudent(input.studentId, input.schoolYearId);
      return { payment: mapPayment(payment), financialStatus };
    });
  }

  async listPayments(studentId: string, schoolYearId: string) {
    await this.getAmountDue(studentId, schoolYearId);
    return (await this.repository.listPayments(studentId, schoolYearId)).map(mapPayment);
  }

  async getStudentAccountStatement(studentId: string, schoolYearId: string) {
    const due = await this.getAmountDue(studentId, schoolYearId);
    const payments = (await this.repository.listPaymentsChronological(studentId, schoolYearId)).map(mapPayment);
    return {
      student: {
        id: due.student_id,
        name: due.student_name,
        classId: due.class_id,
        className: due.class_name,
      },
      schoolYearId,
      currency: due.currency,
      totalDue: due.totalDue,
      movements: calculateRunningBalances(due.totalDue, payments.map((payment) => ({
        ...payment,
        paymentDate: payment.paymentDate,
      }))),
    };
  }

  async getCashJournal(filter: {
    schoolYearId?: string;
    from?: string;
    to?: string;
    classId?: string;
    method?: PaymentMethod;
  }) {
    const entries = (await this.repository.listCashJournal(filter)).map((row) => ({
      ...mapPayment(row),
      studentMatricule: row.student_matricule,
      studentName: row.student_name,
      classId: row.class_id,
      className: row.class_name,
    }));
    const confirmed = entries.filter((entry) => entry.status === 'confirmed');
    const totals = {
      cash: 0,
      mobile_money: 0,
      bank_transfer: 0,
      grandTotal: 0,
    };
    for (const entry of confirmed) {
      totals[entry.method] += entry.amount;
      totals.grandTotal += entry.amount;
    }
    return { entries, totals, count: entries.length };
  }

  async exportCashJournalExcel(filter: {
    schoolYearId?: string;
    from?: string;
    to?: string;
    classId?: string;
    method?: PaymentMethod;
  }): Promise<Buffer> {
    const journal = await this.getCashJournal(filter);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'IvoirEdu';
    const sheet = workbook.addWorksheet('Journal de caisse', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = [
      { header: 'Date', key: 'date', width: 14 },
      { header: 'Matricule', key: 'matricule', width: 18 },
      { header: 'Élève', key: 'student', width: 30 },
      { header: 'Classe', key: 'className', width: 20 },
      { header: 'Montant (FCFA)', key: 'amount', width: 18 },
      { header: 'Mode', key: 'method', width: 18 },
      { header: 'Référence', key: 'reference', width: 24 },
      { header: 'Statut', key: 'status', width: 14 },
    ];
    for (const entry of journal.entries) {
      sheet.addRow({
        date: entry.paymentDate,
        matricule: entry.studentMatricule ?? '',
        student: entry.studentName,
        className: entry.className,
        amount: entry.amount,
        method: entry.method,
        reference: entry.providerReference ?? entry.schoolReceiptReference ?? '',
        status: entry.status,
      });
    }
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } };
    sheet.getColumn('amount').numFmt = '#,##0';
    sheet.autoFilter = { from: 'A1', to: 'H1' };
    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  async assertPaymentBelongsToStudent(paymentId: string, studentId: string) {
    const payment = await this.repository.findPayment(paymentId);
    if (!payment) throw new FinanceModuleError('Payment not found', 404, 'PAYMENT_NOT_FOUND');
    if (payment.student_id !== studentId) {
      throw new FinanceModuleError('Payment does not belong to this student', 403, 'PAYMENT_ACCESS_DENIED');
    }
    return mapPayment(payment);
  }

  async recordEnrollmentPayment(input: {
    enrollmentId: string;
    actorUserId: string;
    method: PaymentMethod;
    providerReference?: string;
    schoolReceiptReference?: string;
  }) {
    return this.repository.db.transaction(async (tx) => {
      const repository = new FinanceRepository(tx as FinanceDb);
      const enrollment = await repository.lockEnrollment(input.enrollmentId);
      if (!enrollment) {
        throw new FinanceModuleError('Enrollment not found', 404, 'ENROLLMENT_NOT_FOUND');
      }
      if (!['pending_cashier', 'pending_dossier'].includes(enrollment.status)) {
        throw new FinanceModuleError(
          'Payment cannot be confirmed for this enrollment',
          409,
          'PAYMENT_CONFIRMATION_BLOCKED'
        );
      }
      const due = await this.amountDueWith(repository, enrollment.student_id, enrollment.school_year_id);
      const alreadyPaid = await repository.getConfirmedPaid(enrollment.student_id, enrollment.school_year_id);
      const amount = Math.max(0, Math.round((due.totalDue - alreadyPaid) * 100) / 100);
      if (amount <= 0) {
        throw new FinanceModuleError(
          'No remaining amount can be recorded for this enrollment',
          409,
          'ENROLLMENT_NOTHING_TO_PAY'
        );
      }
      const payment = await repository.insertPayment({
        studentId: enrollment.student_id,
        schoolYearId: enrollment.school_year_id,
        amount,
        method: input.method,
        source: 'cashier_manual',
        confirmedByUserId: input.actorUserId,
        providerReference: input.providerReference,
        schoolReceiptReference: input.schoolReceiptReference,
        receiptNumber: receiptNumber(),
      });
      await repository.confirmEnrollment(input.enrollmentId, input.actorUserId);
      await new FinancialCacheService(
        new FinancialCacheRepository(tx as FinanceDb)
      ).recalcStudent(enrollment.student_id, enrollment.school_year_id);
      return { payment: mapPayment(payment) };
    });
  }

  async cancelPayment(id: string, actorUserId: string, reason: string) {
    return this.repository.db.transaction(async (tx) => {
      const repository = new FinanceRepository(tx as FinanceDb);
      const current = await repository.findPayment(id);
      if (!current) throw new FinanceModuleError('Payment not found', 404, 'PAYMENT_NOT_FOUND');
      if (!canCancelPayment(current.status)) {
        throw new FinanceModuleError('Payment is already cancelled', 409, 'PAYMENT_ALREADY_CANCELLED');
      }
      const payment = await repository.cancelPayment(id, actorUserId, reason);
      if (!payment) throw new FinanceModuleError('Payment cancellation conflict', 409, 'PAYMENT_CANCELLATION_CONFLICT');
      const financialStatus = await new FinanceService(repository).getFinancialStatus(
        payment.student_id,
        payment.school_year_id
      );
      if (financialStatus.remainingDue > 0) {
        await repository.blockPendingReEnrollmentsAfterUnsettlement(
          payment.student_id,
          payment.school_year_id
        );
      }
      await new FinancialCacheService(
        new FinancialCacheRepository(tx as FinanceDb)
      ).recalcStudent(payment.student_id, payment.school_year_id);
      return {
        payment: mapPayment(payment),
        financialStatus,
      };
    });
  }

  async grantTuitionOverride(input: {
    studentId: string;
    schoolYearId: string;
    overrideTotalAmount?: number;
    discountAmount?: number;
    reason: string;
    grantedByUserId: string;
  }) {
    const context = await this.getAmountDue(input.studentId, input.schoolYearId);
    if (input.discountAmount !== undefined && input.discountAmount > context.planTotalAmount) {
      throw new FinanceModuleError(
        'Discount cannot exceed the tuition plan amount',
        400,
        'DISCOUNT_EXCEEDS_TUITION'
      );
    }
    try {
      return await this.repository.db.transaction(async (tx) => {
        const repository = new FinanceRepository(tx as FinanceDb);
        const override = await repository.createTuitionOverride(input);
        const overrideId = (override as { id: string }).id;
        const amountLabel = input.overrideTotalAmount !== undefined
          ? `montant personnalisé ${input.overrideTotalAmount} FCFA`
          : `remise ${input.discountAmount} FCFA`;
        await repository.notifyDirectorOfOverride({
          overrideId,
          studentName: context.student_name,
          reason: input.reason,
          amountLabel,
        });
        return { override };
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new FinanceModuleError(
          'A tuition override already exists for this student and school year',
          409,
          'TUITION_OVERRIDE_ALREADY_EXISTS'
        );
      }
      throw error;
    }
  }

  async upsertTuitionPlan(levelId: string, input: UpsertTuitionPlanInput) {
    let previousDate = '';
    let previousAmount = -1;
    for (const step of input.scheduleSteps) {
      if (step.dueDate <= previousDate || step.cumulativeAmountExpected < previousAmount) {
        throw new FinanceModuleError(
          'Schedule steps must have increasing dates and cumulative amounts',
          400,
          'INVALID_CUMULATIVE_SCHEDULE'
        );
      }
      if (step.cumulativeAmountExpected > input.totalAmount) {
        throw new FinanceModuleError(
          'A cumulative expected amount cannot exceed the tuition total',
          400,
          'SCHEDULE_EXCEEDS_TUITION'
        );
      }
      previousDate = step.dueDate;
      previousAmount = step.cumulativeAmountExpected;
    }
    try {
      return await this.repository.upsertTuitionPlan(levelId, input);
    } catch (error) {
      if ((error as { code?: string }).code === '23503') {
        throw new FinanceModuleError('Level or school year not found', 404, 'TUITION_SCOPE_NOT_FOUND');
      }
      throw error;
    }
  }

  listTuitionPlans(schoolYearId: string, levelId?: string) {
    return this.repository.listTuitionPlans(schoolYearId, levelId);
  }
  listProviderSettings() { return this.repository.listProviderSettings(); }
  async getProviderAvailability() {
    const providers = await this.repository.getProviderAvailability();
    return {
      inAppPaymentActive: false,
      disabledReason: 'temporarily_disabled' as const,
      providers,
    };
  }
  async getParentPaymentOptions() {
    return {
      inAppPaymentActive: false,
      disabledReason: 'temporarily_disabled' as const,
      manualPaymentChannels: await this.repository.listManualPaymentChannels(),
    };
  }
  upsertProviderSetting(input: {
    provider: MobileMoneyProvider;
    merchantNumber: string;
    apiCredentials: Record<string, unknown>;
    isActive: boolean;
  }) {
    return this.repository.upsertProviderSetting({ ...input, isActive: false });
  }
  listSubscriptionPlans() { return this.repository.listSubscriptionPlans(); }
  createSubscriptionPlan(input: SubscriptionPlanInput) { return this.repository.createSubscriptionPlan(input); }
  async updateSubscriptionPlan(id: string, input: SubscriptionPlanInput) {
    const plan = await this.repository.updateSubscriptionPlan(id, input);
    if (!plan) throw new FinanceModuleError('Subscription plan not found', 404, 'SUBSCRIPTION_PLAN_NOT_FOUND');
    return plan;
  }

  async getReceiptPayload(paymentId: string) {
    const payment = await this.repository.getReceiptContext(paymentId);
    if (!payment) throw new FinanceModuleError('Payment not found', 404, 'PAYMENT_NOT_FOUND');
    const status = await this.getFinancialStatus(payment.student_id, payment.school_year_id);
    const due = await this.getAmountDue(payment.student_id, payment.school_year_id);
    return {
      receiptNumber: payment.receipt_number,
      studentName: payment.student_name,
      className: payment.class_name,
      schoolYearLabel: payment.school_year_label,
      amount: FinanceRepository.toNumber(payment.amount),
      currency: payment.currency,
      method: payment.method,
      createdAt: iso(payment.created_at)!,
      schoolReceiptReference: payment.school_receipt_reference,
      remainingDue: status.remainingDue,
      subscriptionLines: due.subscriptionLines.filter((line) => line.showSeparately),
    };
  }
}

export const buildFinanceService = (db: FinanceDb): FinanceService =>
  new FinanceService(new FinanceRepository(db));
