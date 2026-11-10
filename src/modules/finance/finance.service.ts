import ExcelJS from 'exceljs';
import { invalidateSchoolDerivedStudent } from '../../shared/database/invalidate-school-derived-student.js';
import type { TenantSqlExecutor } from '../../shared/database/sql-executor.js';
import { allocateEnrollmentPayment, calculateEnrollmentMinimum } from '../../shared/utils/parent-alerts.js';

import {
  calculateStudentTotalDue,
  canCancelPayment,
  isValidCumulativeSchedule,
  resolveIndividualFinancialStatus,
  toCumulativeScheduleSteps,
} from './finance.calculations.js';
import {
  FinanceRepository,
  type CashJournalFilterInput,
  type CashJournalRow,
  type FinanceDb,
  type PaymentRow,
  type StudentTuitionScheduleAgreement,
  type TuitionOverride,
  type TuitionPlanRequiredContext,
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
  UpsertTuitionPlanInput,
} from './finance.types.js';

export class FinanceModuleError extends Error {
  constructor(message: string, public readonly statusCode: number, public readonly code: string,
    public readonly context?: TuitionPlanRequiredContext) {
    super(message);
    this.name = 'FinanceModuleError';
  }
}

const todayIso = (): string => new Date().toISOString().slice(0, 10);
const iso = (value: string | Date | null): string | null => value ? new Date(value).toISOString() : null;
const scheduleAuditPayload = (agreement: StudentTuitionScheduleAgreement) => ({
  agreementId: agreement.id,
  studentId: agreement.studentId,
  schoolYearId: agreement.schoolYearId,
  reason: agreement.reason,
  scheduleSteps: agreement.scheduleSteps,
});
const overrideAuditPayload = (override: TuitionOverride, withdrawalReason?: string) => ({
  overrideId: override.id, studentId: override.studentId, schoolYearId: override.schoolYearId,
  type: override.overrideTotalAmount === null ? 'discount' : 'custom_total',
  overrideTotalAmount: override.overrideTotalAmount, discountAmount: override.discountAmount,
  grantedByUserId: override.grantedByUserId, status: override.status, reason: withdrawalReason ?? override.reason,
});
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
  // Heure réelle du paiement : null quand elle n'est pas connue (imports, rétrodatages, anciens paiements).
  paidAt: iso(row.paid_at),
  createdAt: iso(row.created_at),
});

export const ARCHIVED_USER_LABEL = 'Ancien utilisateur (archivé)';

const mapJournalEntry = (row: CashJournalRow) => ({
  ...mapPayment(row),
  studentMatricule: row.student_matricule,
  studentName: row.student_name,
  classId: row.class_id,
  className: row.class_name,
  cancelledBy: row.status === 'cancelled'
    ? (row.cancelled_by_name && row.cancelled_by_active !== false ? row.cancelled_by_name : ARCHIVED_USER_LABEL)
    : null,
});

export class FinanceService {
  constructor(private readonly repository: FinanceRepository) {}

  private async amountDueWith(repository: FinanceRepository, studentId: string, schoolYearId: string, allowPending = false, allowHistorical = false) {
    const context = await repository.getAmountDueContext(studentId, schoolYearId, allowPending, allowHistorical);
    if (!context) {
      if (!allowPending && !(await repository.hasConfirmedEnrollment(studentId, schoolYearId, allowHistorical))) {
        throw new FinanceModuleError('A confirmed enrollment is required for this school year', 409, 'CONFIRMED_ENROLLMENT_REQUIRED');
      }
      throw new FinanceModuleError(
        'A tuition plan is required for the student level and school year',
        409,
        'TUITION_PLAN_REQUIRED',
        await repository.getTuitionPlanRequiredContext(studentId, schoolYearId, allowPending, allowHistorical) ?? undefined
      );
    }
    const totalDue = calculateStudentTotalDue({
      planTotalAmount: FinanceRepository.toNumber(context.plan_total_amount),
      overrideTotalAmount: context.override_total_amount === null
        ? null
        : FinanceRepository.toNumber(context.override_total_amount),
      discountAmount: context.discount_amount === null
        ? null
        : FinanceRepository.toNumber(context.discount_amount),
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
      subscriptionLines: [],
      tuitionDue: Math.max(0, context.override_total_amount === null
        ? FinanceRepository.toNumber(context.plan_total_amount) - (context.discount_amount === null ? 0 : FinanceRepository.toNumber(context.discount_amount))
        : FinanceRepository.toNumber(context.override_total_amount)),
      totalDue,
    };
  }

  async getAmountDue(studentId: string, schoolYearId: string) {
    return this.amountDueWith(this.repository, studentId, schoolYearId);
  }

  /** Preview for the enrollment confirmation screen; never contributes to aggregate finance. */
  async getEnrollmentPaymentPreview(studentId: string, schoolYearId: string) {
    const due = await this.amountDueWith(this.repository, studentId, schoolYearId, true);
    const confirmedPaid = await this.repository.getConfirmedPaid(studentId, schoolYearId);
    const status = resolveIndividualFinancialStatus({
      totalDue: due.totalDue,
      cumulativeExpectedAtDate: 0,
      confirmedPaid,
    });
    return {
      remainingDue: status.remainingDue,
      firstTuitionInstallment: Math.min(
        status.remainingDue,
        Math.max(0, FinanceRepository.toNumber(due.registration_amount))
      ),
      totalDue: due.totalDue,
      confirmedPaid,
      currency: due.currency,
    };
  }

  async getSchoolFinancialSummary(schoolYearId?: string) {
    const cache = new FinancialCacheService(new FinancialCacheRepository(this.repository.db));
    return cache.getSchoolSummary(schoolYearId);
  }

  async listClassFinancialSummaries(schoolYearId?: string) {
    const cache = new FinancialCacheService(new FinancialCacheRepository(this.repository.db));
    return cache.listClassSummaries(schoolYearId);
  }

  async listLevelFinancialSummaries(schoolYearId?: string) {
    const cache = new FinancialCacheService(new FinancialCacheRepository(this.repository.db));
    return cache.listLevelSummaries(schoolYearId);
  }

  async listFinancialCollectionTrend(schoolYearId?: string) {
    const cache = new FinancialCacheService(new FinancialCacheRepository(this.repository.db));
    return cache.listCollectionTrend(schoolYearId);
  }

  async listFinancialPaymentMethods(schoolYearId?: string) {
    const cache = new FinancialCacheService(new FinancialCacheRepository(this.repository.db));
    return cache.listPaymentMethodSummaries(schoolYearId);
  }

  async getFinancialInstallmentSummary(schoolYearId?: string) {
    const cache = new FinancialCacheService(new FinancialCacheRepository(this.repository.db));
    return cache.getInstallmentSummary(schoolYearId);
  }
  async listFinancialAgingStudents(input: { schoolYearId?: string; bucket: '0-30' | '31-60' | '>60'; page: number; limit: number; search?: string; classId?: string }) {
    const cache = new FinancialCacheService(new FinancialCacheRepository(this.repository.db));
    return cache.listAgingStudents(input);
  }
  async listAgreementsRegister(input: { schoolYearId: string; kind: 'overrides' | 'schedules'; search?: string; studentId?: string; classId?: string; levelId?: string; from?: string; to?: string; status: 'active' | 'withdrawn' | 'replaced' | 'reset' | 'all'; page: number; limit: number }) {
    const result = await this.repository.listAgreementsRegister(input);
    return { entries: result.entries, pagination: { page: input.page, limit: input.limit, total: result.total, totalPages: Math.ceil(result.total / input.limit) } };
  }
  async getAgreementDetail(kind: 'overrides' | 'schedules', agreementId: string) {
    const detail = await this.repository.getAgreementDetail(kind, agreementId);
    if (!detail) throw new FinanceModuleError('Accord introuvable.', 404, 'AGREEMENT_NOT_FOUND');
    return detail;
  }
  async getAgreementsMetrics(schoolYearId: string) { return this.repository.getAgreementsMetrics(schoolYearId); }

  async listFinancialRecentPayments(schoolYearId?: string) {
    const cache = new FinancialCacheService(new FinancialCacheRepository(this.repository.db));
    return cache.listRecentPayments(schoolYearId);
  }

  async getStudentFinancialCache(studentId: string, schoolYearId?: string) {
    const cache = new FinancialCacheService(new FinancialCacheRepository(this.repository.db));
    return cache.getStudentCachedStatus(studentId, schoolYearId);
  }

  async recalculateFinancialCache(schoolYearId?: string) {
    const cache = new FinancialCacheService(new FinancialCacheRepository(this.repository.db));
    return cache.recalcAll(schoolYearId);
  }

  async listClassStudentStatuses(classId: string, schoolYearId?: string) {
    const cache = new FinancialCacheService(new FinancialCacheRepository(this.repository.db));
    return cache.listClassStudentStatuses(classId, schoolYearId);
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

  async listFinancialAlertLogs(input: { page: number; limit: number }) {
    const repository = new FinancialAlertsRepository(this.repository.db);
    const total = await repository.countLogs();
    const totalPages = Math.max(1, Math.ceil(total / input.limit));
    const page = Math.min(input.page, totalPages);
    const logs = await repository.listLogsPage({
      limit: input.limit,
      offset: (page - 1) * input.limit,
    });
    return {
      logs,
      pagination: { page, limit: input.limit, total, totalPages },
    };
  }

  async getFinancialStatus(studentId: string, schoolYearId: string, asOfDate = todayIso()) {
    return this.financialStatusWith(studentId, schoolYearId, asOfDate, false);
  }

  async getHistoricalFinancialStatus(studentId: string, schoolYearId: string, asOfDate = todayIso()) {
    if (!(await this.repository.hasConfirmedEnrollment(studentId, schoolYearId, true))) {
      throw new FinanceModuleError('A confirmed historical enrollment is required', 409, 'CONFIRMED_ENROLLMENT_REQUIRED');
    }
    return this.financialStatusWith(studentId, schoolYearId, asOfDate, true);
  }

  async listReEnrollmentBalances(schoolYearId: string): Promise<Map<string, number | null>> {
    const contexts = await this.repository.listReEnrollmentBalanceContexts(schoolYearId);
    return new Map(contexts.map((context) => {
      if (context.plan_total_amount === null) return [context.student_id, null];
      const totalDue = calculateStudentTotalDue({
        planTotalAmount: FinanceRepository.toNumber(context.plan_total_amount),
        overrideTotalAmount: context.override_total_amount === null ? null : FinanceRepository.toNumber(context.override_total_amount),
        discountAmount: context.discount_amount === null ? null : FinanceRepository.toNumber(context.discount_amount),
      });
      const status = resolveIndividualFinancialStatus({
        totalDue,
        cumulativeExpectedAtDate: 0,
        confirmedPaid: FinanceRepository.toNumber(context.confirmed_paid),
      });
      return [context.student_id, status.remainingDue];
    }));
  }

  private async financialStatusWith(studentId: string, schoolYearId: string, asOfDate: string, allowHistorical: boolean) {
    const due = allowHistorical
      ? await this.amountDueWith(this.repository, studentId, schoolYearId, false, true)
      : await this.getAmountDue(studentId, schoolYearId);
    const confirmedPaid = await this.repository.getConfirmedPaid(studentId, schoolYearId);
    const scheduledExpectedAtDate = await this.repository.getExpectedAtDate(
      studentId,
      schoolYearId,
      asOfDate,
      allowHistorical
    );
    const cumulativeExpectedAtDate = Math.max(0, Math.min(due.tuitionDue, scheduledExpectedAtDate));
    const individualStatus = resolveIndividualFinancialStatus({
      totalDue: due.totalDue,
      cumulativeExpectedAtDate,
      confirmedPaid,
    });
    return {
      studentId,
      schoolYearId,
      asOfDate,
      currency: due.currency,
      totalDue: due.totalDue,
      discountAmount: due.discountAmount ?? 0,
      confirmedPaid,
      coveredAmount: individualStatus.coveredAmount,
      remainingDue: individualStatus.remainingDue,
      cumulativeExpectedAtDate,
      standing: individualStatus.standing,
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
        receiptNumber: await repository.nextReceiptNumber(),
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
        matricule: due.student_matricule,
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

  async getCashJournal(filter: CashJournalFilterInput) {
    const entries = (await this.repository.listCashJournal(filter)).map(mapJournalEntry);
    // Totals never depend on the status filter and never include cancelled payments.
    const basis = filter.status
      ? (await this.repository.listCashJournal({ ...filter, status: undefined })).map(mapJournalEntry)
      : entries;
    const totals = {
      cash: 0,
      mobile_money: 0,
      bank_transfer: 0,
      grandTotal: 0,
    };
    for (const entry of basis) {
      if (entry.status !== 'confirmed') continue;
      totals[entry.method] += entry.amount;
      totals.grandTotal += entry.amount;
    }
    return { entries, totals, count: entries.length };
  }

  async getPaginatedCashJournal(filter: CashJournalFilterInput & { page: number; limit: number }) {
    const summary = await this.repository.getCashJournalSummary(filter);
    const confirmedCount = FinanceRepository.toNumber(summary.confirmed_count);
    const cancelledCount = FinanceRepository.toNumber(summary.cancelled_count);
    const total = filter.status === 'confirmed'
      ? confirmedCount
      : filter.status === 'cancelled' ? cancelledCount : confirmedCount + cancelledCount;
    const totalPages = Math.max(1, Math.ceil(total / filter.limit));
    const page = Math.min(filter.page, totalPages);
    const rows = await this.repository.listCashJournalPage({
      ...filter,
      limit: filter.limit,
      offset: (page - 1) * filter.limit,
    });

    return {
      entries: rows.map(mapJournalEntry),
      totals: {
        cash: FinanceRepository.toNumber(summary.cash_total),
        mobile_money: FinanceRepository.toNumber(summary.mobile_money_total),
        bank_transfer: FinanceRepository.toNumber(summary.bank_transfer_total),
        grandTotal: FinanceRepository.toNumber(summary.grand_total),
      },
      counts: { confirmed: confirmedCount, cancelled: cancelledCount },
      count: total,
      pagination: { page, limit: filter.limit, total, totalPages },
    };
  }

  async getPaginatedPaymentHistory(filter: {
    schoolYearId: string;
    from?: string;
    to?: string;
    levelId?: string;
    classId?: string;
    status?: 'up_to_date' | 'late';
    page: number;
    limit: number;
  }) {
    const total = await this.repository.countPaymentHistory(filter);
    const totalPages = Math.max(1, Math.ceil(total / filter.limit));
    const page = Math.min(filter.page, totalPages);
    const rows = await this.repository.listPaymentHistoryPage({
      ...filter,
      limit: filter.limit,
      offset: (page - 1) * filter.limit,
    });
    return {
      entries: rows.map((row) => ({
        ...mapPayment(row),
        studentMatricule: row.student_matricule,
        studentName: row.student_name,
        classId: row.class_id,
        className: row.class_name,
        levelId: row.level_id,
        levelName: row.level_name,
        financialStatus: row.financial_status,
      })),
      pagination: { page, limit: filter.limit, total, totalPages },
    };
  }

  async exportCashJournalExcel(filter: CashJournalFilterInput): Promise<Buffer> {
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
      { header: 'Annulé par', key: 'cancelledBy', width: 28 },
      { header: 'Annulé le', key: 'cancelledAt', width: 20 },
      { header: 'Motif', key: 'reason', width: 32 },
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
        status: entry.status === 'cancelled' ? 'Annulé' : 'Confirmé',
        cancelledBy: entry.cancelledBy ?? '',
        cancelledAt: entry.cancelledAt ?? '',
        reason: entry.cancellationReason ?? '',
      });
    }
    const totalRow = sheet.addRow({ student: 'Total confirmé (annulés exclus)', amount: journal.totals.grandTotal });
    totalRow.font = { bold: true };
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } };
    sheet.getColumn('amount').numFmt = '#,##0';
    sheet.autoFilter = { from: 'A1', to: 'K1' };
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
    amount: number;
    method: PaymentMethod;
    providerReference?: string;
    schoolReceiptReference: string;
    parentAlerts?: {
      amountFcfa: number;
      minimumTuitionAmount: number;
      showOnSchoolReceipt: boolean;
      createSubscription: (
        executor: TenantSqlExecutor,
        method: PaymentMethod
      ) => Promise<{
        subscriptionId: string;
        subscriptionPaymentId: string;
        parentId: string;
        parentPhone: string | null;
        startsAt: string;
        endsAt: string;
        amountFcfa: number;
        durationMonths: number;
      }>;
    };
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
      const due = await this.amountDueWith(repository, enrollment.student_id, enrollment.school_year_id, true);
      const alreadyPaid = await repository.getConfirmedPaid(enrollment.student_id, enrollment.school_year_id);
      const remainingDue = Math.max(0, Math.round((due.totalDue - alreadyPaid) * 100) / 100);
      const alertsAmount = input.parentAlerts?.amountFcfa ?? 0;
      if (remainingDue <= 0 && alertsAmount <= 0) {
        throw new FinanceModuleError(
          'No remaining amount can be recorded for this enrollment',
          409,
          'ENROLLMENT_NOTHING_TO_PAY'
        );
      }
      const amount = Math.round(input.amount * 100) / 100;
      const minimumTuitionAmount = Math.min(
        remainingDue,
        Math.max(0, input.parentAlerts?.minimumTuitionAmount ?? 0)
      );
      const minimumCombinedAmount = calculateEnrollmentMinimum(minimumTuitionAmount, alertsAmount);
      if (input.parentAlerts && amount < minimumCombinedAmount) {
        throw new FinanceModuleError(
          `The minimum amount required to confirm enrollment is ${minimumCombinedAmount} FCFA`,
          400,
          'ENROLLMENT_PAYMENT_BELOW_MINIMUM'
        );
      }
      if (amount > remainingDue + alertsAmount) {
        throw new FinanceModuleError(
          'Payment amount cannot exceed the remaining tuition and parent alerts amounts',
          400,
          'ENROLLMENT_PAYMENT_EXCEEDS_REMAINING_DUE'
        );
      }
      if (alertsAmount > 0 && !input.parentAlerts) {
        throw new FinanceModuleError('Parent alerts payment details are missing', 409, 'PARENT_ALERTS_PAYMENT_REQUIRED');
      }
      const allocationAmounts = allocateEnrollmentPayment({
        amount,
        remainingTuition: remainingDue,
        parentAlertsAmountFcfa: alertsAmount,
      });
      const tuitionAmount = allocationAmounts.tuitionAmount;
      const payment = tuitionAmount > 0
        ? await repository.insertPayment({
            studentId: enrollment.student_id,
            schoolYearId: enrollment.school_year_id,
            amount: tuitionAmount,
            method: input.method,
            source: 'cashier_manual',
            confirmedByUserId: input.actorUserId,
            providerReference: input.providerReference,
            schoolReceiptReference: input.schoolReceiptReference,
            receiptNumber: await repository.nextReceiptNumber(),
          })
        : null;
      const subscription = input.parentAlerts
        ? await input.parentAlerts.createSubscription(tx, input.method)
        : null;
      if (subscription && input.parentAlerts) {
        await repository.insertEnrollmentPaymentAllocation({
          paymentId: payment?.id ?? null,
          subscriptionPaymentId: subscription.subscriptionPaymentId,
          studentId: enrollment.student_id,
          schoolYearId: enrollment.school_year_id,
          totalAmount: allocationAmounts.totalAmount,
          tuitionAmount,
          parentAlertsAmount: allocationAmounts.parentAlertsAmount,
          showParentAlertsOnReceipt: input.parentAlerts.showOnSchoolReceipt,
          actorUserId: input.actorUserId,
        });
      }
      await repository.confirmEnrollment(input.enrollmentId, input.actorUserId);
      await invalidateSchoolDerivedStudent(tx as FinanceDb, enrollment.student_id, enrollment.school_year_id);
      await new FinancialCacheService(
        new FinancialCacheRepository(tx as FinanceDb)
      ).recalcStudent(enrollment.student_id, enrollment.school_year_id);
      return {
        payment: payment ? mapPayment(payment) : null,
        allocation: subscription ? {
          totalAmount: allocationAmounts.totalAmount,
          tuitionAmount,
          parentAlertsAmount: allocationAmounts.parentAlertsAmount,
          showParentAlertsOnSchoolReceipt: input.parentAlerts?.showOnSchoolReceipt ?? false,
        } : null,
        subscription,
      };
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
    actorRole: string;
  }) {
    try {
      return await this.repository.db.transaction(async (tx) => {
        const repository = new FinanceRepository(tx as FinanceDb);
        const context = await new FinanceService(repository).getAmountDue(input.studentId, input.schoolYearId);
        if (input.discountAmount !== undefined && input.discountAmount > context.planTotalAmount) {
          throw new FinanceModuleError(
            'Discount cannot exceed the tuition plan amount', 400, 'DISCOUNT_EXCEEDS_TUITION'
          );
        }
        const adjustedTuitionAmount = input.overrideTotalAmount ?? Math.max(
          0, context.planTotalAmount - (input.discountAmount ?? 0)
        );
        const currentSchedule = await repository.getStudentTuitionScheduleAgreement(input.studentId, input.schoolYearId);
        if (currentSchedule && !isValidCumulativeSchedule(currentSchedule.scheduleSteps, adjustedTuitionAmount)) {
          throw new FinanceModuleError(
            'Le total de l’échéancier négocié ne correspondrait plus aux frais après cet ajustement.',
            409,
            'STUDENT_SCHEDULE_TOTAL_MISMATCH'
          );
        }
        const override = await repository.createTuitionOverride(input);
        const overrideId = (override as { id: string }).id;
        await repository.recordTuitionOverrideAudit({ actorUserId: input.grantedByUserId, actorRole: input.actorRole, action: 'tuition.override.created', before: null, after: overrideAuditPayload(override as TuitionOverride) });
        const amountLabel = input.overrideTotalAmount !== undefined
          ? `montant personnalisé ${input.overrideTotalAmount} FCFA`
          : `remise ${input.discountAmount} FCFA`;
        await repository.notifyDirectorOfOverride({
          overrideId,
          studentName: context.student_name,
          reason: input.reason,
          amountLabel,
        });
        await new FinancialCacheService(new FinancialCacheRepository(tx as FinanceDb))
          .recalcStudent(input.studentId, input.schoolYearId);
        return { override };
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new FinanceModuleError(
          'Un ajustement individuel actif existe déjà pour cet élève et cette année. Retirez-le avant d’en accorder un nouveau.',
          409,
          'TUITION_OVERRIDE_ALREADY_EXISTS'
        );
      }
      throw error;
    }
  }

  /** Replaces an active adjustment without erasing its financial and audit history. */
  async replaceTuitionOverride(input: {
    studentId: string;
    schoolYearId: string;
    overrideTotalAmount?: number;
    discountAmount?: number;
    reason: string;
    grantedByUserId: string;
    actorRole: string;
  }) {
    return this.repository.db.transaction(async (tx) => {
      const repository = new FinanceRepository(tx as FinanceDb);
      const service = new FinanceService(repository);
      const current = await repository.getActiveTuitionOverride(input.studentId, input.schoolYearId);
      if (!current) {
        throw new FinanceModuleError('Aucun ajustement actif à modifier pour cet élève.', 404, 'TUITION_OVERRIDE_NOT_FOUND');
      }
      const context = await service.getAmountDue(input.studentId, input.schoolYearId);
      if (input.discountAmount !== undefined && input.discountAmount > context.planTotalAmount) {
        throw new FinanceModuleError('La remise ne peut pas dépasser le montant du plan de scolarité.', 400, 'DISCOUNT_EXCEEDS_TUITION');
      }
      const adjustedTuitionAmount = input.overrideTotalAmount ?? Math.max(0, context.planTotalAmount - (input.discountAmount ?? 0));
      const confirmedPaid = await repository.getConfirmedPaid(input.studentId, input.schoolYearId);
      if (confirmedPaid > adjustedTuitionAmount) {
        throw new FinanceModuleError('Cette modification créerait un trop-perçu. Traitez d’abord le remboursement, l’avoir ou la réaffectation comptable.', 409, 'TUITION_OVERRIDE_REPLACEMENT_OVERPAYMENT');
      }
      const schedule = await repository.getStudentTuitionScheduleAgreement(input.studentId, input.schoolYearId);
      if (schedule && !isValidCumulativeSchedule(schedule.scheduleSteps, adjustedTuitionAmount)) {
        throw new FinanceModuleError('Modifiez ou réinitialisez d’abord l’échéancier négocié : son total ne correspondrait plus à cet ajustement.', 409, 'STUDENT_SCHEDULE_TOTAL_MISMATCH');
      }
      const closureReason = `Remplacé : ${input.reason}`;
      const withdrawn = await repository.withdrawTuitionOverride(current.id, input.grantedByUserId, closureReason);
      if (!withdrawn) throw new FinanceModuleError('Cet ajustement a été modifié entre-temps. Actualisez le registre.', 409, 'TUITION_OVERRIDE_CONCURRENT_UPDATE');
      const override = await repository.createTuitionOverride(input);
      await repository.recordTuitionOverrideAudit({
        actorUserId: input.grantedByUserId, actorRole: input.actorRole,
        action: 'tuition.override.withdrawn', before: overrideAuditPayload(current), after: overrideAuditPayload(withdrawn, closureReason),
      });
      await repository.recordTuitionOverrideAudit({
        actorUserId: input.grantedByUserId, actorRole: input.actorRole,
        action: 'tuition.override.created', before: overrideAuditPayload(current), after: overrideAuditPayload(override as TuitionOverride),
      });
      await new FinancialCacheService(new FinancialCacheRepository(tx as FinanceDb)).recalcStudent(input.studentId, input.schoolYearId);
      return { override };
    });
  }

  async previewTuitionOverrideWithdrawal(studentId: string, schoolYearId: string) {
    const activeOverride = await this.repository.getActiveTuitionOverride(studentId, schoolYearId);
    if (!activeOverride) throw new FinanceModuleError('Aucun ajustement actif à retirer pour cet élève.', 404, 'TUITION_OVERRIDE_NOT_FOUND');
    const current = await this.getAmountDue(studentId, schoolYearId);
    const restoredTuitionAmount = current.planTotalAmount;
    const restoredTotalAmount = calculateStudentTotalDue({ planTotalAmount: restoredTuitionAmount });
    const confirmedPaid = await this.repository.getConfirmedPaid(studentId, schoolYearId);
    const agreement = await this.repository.getStudentTuitionScheduleAgreement(studentId, schoolYearId);
    const scheduleCompatible = !agreement || isValidCumulativeSchedule(agreement.scheduleSteps, restoredTuitionAmount);
    const expected = await this.repository.getExpectedAtDate(studentId, schoolYearId, todayIso());
    const currentStatus = resolveIndividualFinancialStatus({ totalDue: current.totalDue, cumulativeExpectedAtDate: Math.min(current.tuitionDue, expected), confirmedPaid });
    const restoredStatus = resolveIndividualFinancialStatus({ totalDue: restoredTotalAmount, cumulativeExpectedAtDate: Math.min(restoredTuitionAmount, expected), confirmedPaid });
    return { adjustment: overrideAuditPayload(activeOverride), currency: current.currency, currentTotalAmount: current.totalDue, restoredTotalAmount, currentTuitionAmount: current.tuitionDue, restoredTuitionAmount, confirmedPaid, remainingBefore: currentStatus.remainingDue, remainingAfter: restoredStatus.remainingDue, standingBefore: currentStatus.standing, standingAfter: restoredStatus.standing, potentialOverpayment: confirmedPaid > restoredTotalAmount, schedule: agreement ? { present: true, compatible: scheduleCompatible, steps: agreement.scheduleSteps } : { present: false, compatible: true, steps: [] } };
  }

  async withdrawTuitionOverride(input: { studentId: string; schoolYearId: string; reason: string; actorUserId: string; actorRole: string; scheduleResolution: 'keep' | 'reset' | 'replace'; installments?: Array<{ dueDate: string; amount: number }> }) {
    return this.repository.db.transaction(async (tx) => {
      const repository = new FinanceRepository(tx as FinanceDb); const service = new FinanceService(repository);
      const preview = await service.previewTuitionOverrideWithdrawal(input.studentId, input.schoolYearId);
      if (preview.potentialOverpayment) throw new FinanceModuleError('Le retrait créerait un trop-perçu. Traitez d’abord le remboursement, l’avoir ou la réaffectation comptable.', 409, 'TUITION_OVERRIDE_WITHDRAWAL_OVERPAYMENT');
      if (preview.schedule.present && !preview.schedule.compatible && input.scheduleResolution === 'keep') throw new FinanceModuleError('L’échéancier négocié doit être remplacé ou abandonné avant le retrait.', 409, 'STUDENT_SCHEDULE_TOTAL_MISMATCH');
      if (preview.schedule.present && !preview.schedule.compatible && input.scheduleResolution === 'replace') {
        if (!input.installments) throw new FinanceModuleError('Un nouvel échéancier complet est requis.', 400, 'REPLACEMENT_SCHEDULE_REQUIRED');
        await service.replaceStudentTuitionSchedule({ studentId: input.studentId, schoolYearId: input.schoolYearId, reason: input.reason, actorUserId: input.actorUserId, actorRole: input.actorRole, installments: input.installments, targetTuitionAmount: preview.restoredTuitionAmount });
      } else if (preview.schedule.present && !preview.schedule.compatible && input.scheduleResolution === 'reset') {
        await service.deleteStudentTuitionSchedule({ studentId: input.studentId, schoolYearId: input.schoolYearId, reason: input.reason, actorUserId: input.actorUserId, actorRole: input.actorRole });
      }
      const withdrawn = await repository.withdrawTuitionOverride(preview.adjustment.overrideId as string, input.actorUserId, input.reason);
      if (!withdrawn) throw new FinanceModuleError('Cet ajustement a déjà été retiré.', 409, 'TUITION_OVERRIDE_ALREADY_WITHDRAWN');
      await repository.recordTuitionOverrideAudit({ actorUserId: input.actorUserId, actorRole: input.actorRole, action: 'tuition.override.withdrawn', before: preview.adjustment, after: overrideAuditPayload(withdrawn, input.reason) });
      await new FinancialCacheService(new FinancialCacheRepository(tx as FinanceDb)).recalcStudent(input.studentId, input.schoolYearId);
      return { withdrawn: true, preview: await service.previewTuitionOverrideWithdrawal(input.studentId, input.schoolYearId).catch(() => ({ restoredTotalAmount: preview.restoredTotalAmount, remainingAfter: preview.remainingAfter, standingAfter: preview.standingAfter })) };
    });
  }

  async getStudentTuitionSchedule(studentId: string, schoolYearId: string, includeReason = true) {
    const due = await this.getAmountDue(studentId, schoolYearId);
    const agreement = await this.repository.getStudentTuitionScheduleAgreement(studentId, schoolYearId);
    const confirmedPaid = await this.repository.getConfirmedPaid(studentId, schoolYearId);
    const remainingToPlan = Math.max(0, Math.round((due.tuitionDue - confirmedPaid) * 100) / 100);
    return {
      agreement: agreement && (includeReason ? agreement : (() => {
        const { reason, ...metadata } = agreement;
        void reason;
        return metadata;
      })()),
      totalTuitionAmount: due.tuitionDue,
      confirmedPaid,
      remainingToPlan,
      currency: due.currency,
    };
  }

  async replaceStudentTuitionSchedule(input: {
    studentId: string;
    schoolYearId: string;
    reason: string;
    actorUserId: string;
    actorRole: string;
    installments: Array<{ dueDate: string; amount: number }>;
    /** Used only by the atomic C46 withdrawal flow, before the override is archived. */
    targetTuitionAmount?: number;
  }) {
    try {
      return await this.repository.db.transaction(async (tx) => {
      const repository = new FinanceRepository(tx as FinanceDb);
      const due = await new FinanceService(repository).getAmountDue(input.studentId, input.schoolYearId);
      const schoolYear = await repository.getSchoolYearDateRange(input.schoolYearId);
      if (!schoolYear) throw new FinanceModuleError('Année scolaire introuvable.', 404, 'SCHOOL_YEAR_NOT_FOUND');
      const tuitionAmount = input.targetTuitionAmount ?? due.tuitionDue;
      const confirmedPaid = await repository.getConfirmedPaid(input.studentId, input.schoolYearId);
      const remainingToPlan = Math.max(0, Math.round((tuitionAmount - confirmedPaid) * 100) / 100);
      if (remainingToPlan <= 0) {
        throw new FinanceModuleError(
          'Aucun reste à planifier : les paiements confirmés couvrent déjà les frais de scolarité.',
          409,
          'STUDENT_SCHEDULE_NOTHING_REMAINING'
        );
      }
      const requestedScheduleSteps = toCumulativeScheduleSteps(input.installments);
      const datesAreInSchoolYear = requestedScheduleSteps.every((step) =>
        step.dueDate >= schoolYear.startDate && step.dueDate <= schoolYear.endDate
      );
      if (!datesAreInSchoolYear) {
        throw new FinanceModuleError(
          'Chaque date d’échéance doit être comprise dans l’année scolaire choisie.',
          400,
          'STUDENT_SCHEDULE_DATE_OUTSIDE_SCHOOL_YEAR'
        );
      }
      if (!isValidCumulativeSchedule(requestedScheduleSteps, remainingToPlan)) {
        throw new FinanceModuleError(
          `Les échéances doivent être ordonnées, strictement positives et couvrir exactement le reste à planifier (${remainingToPlan} FCFA).`,
          400,
          'INVALID_STUDENT_NEGOTIATED_SCHEDULE'
        );
      }
      const scheduleSteps = requestedScheduleSteps.map((step) => ({
        dueDate: step.dueDate,
        cumulativeAmountExpected: Math.round((confirmedPaid + step.cumulativeAmountExpected) * 100) / 100,
      }));
      if (!isValidCumulativeSchedule(scheduleSteps, tuitionAmount)) {
        throw new FinanceModuleError(
          'L’échéancier ne peut pas réintégrer un montant déjà encaissé.',
          400,
          'INVALID_STUDENT_NEGOTIATED_SCHEDULE'
        );
      }
      const previous = await repository.getStudentTuitionScheduleAgreement(input.studentId, input.schoolYearId);
      const agreement = await repository.replaceStudentTuitionSchedule({
        ...input,
        scheduleSteps,
      });
      await repository.recordStudentTuitionScheduleAudit({
        actorUserId: input.actorUserId,
        actorRole: input.actorRole,
        action: previous ? 'tuition.student_schedule.updated' : 'tuition.student_schedule.created',
        before: previous ? scheduleAuditPayload(previous) : null,
        after: scheduleAuditPayload(agreement),
      });
      await new FinancialCacheService(new FinancialCacheRepository(tx as FinanceDb))
        .recalcStudent(input.studentId, input.schoolYearId);
        return { agreement, totalTuitionAmount: tuitionAmount, confirmedPaid, remainingToPlan, currency: due.currency };
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new FinanceModuleError(
          'Cet échéancier a été modifié par un autre utilisateur. Actualisez le registre avant de réessayer.',
          409,
          'STUDENT_SCHEDULE_CONCURRENT_UPDATE'
        );
      }
      throw error;
    }
  }

  async deleteStudentTuitionSchedule(input: {
    studentId: string; schoolYearId: string; reason: string; actorUserId: string; actorRole: string;
  }) {
    return this.repository.db.transaction(async (tx) => {
      const repository = new FinanceRepository(tx as FinanceDb);
      await new FinanceService(repository).getAmountDue(input.studentId, input.schoolYearId);
      const deletedAgreement = await repository.deleteStudentTuitionSchedule(input.studentId, input.schoolYearId, input.actorUserId, input.reason);
      if (deletedAgreement) {
        await repository.recordStudentTuitionScheduleAudit({
          actorUserId: input.actorUserId,
          actorRole: input.actorRole,
          action: 'tuition.student_schedule.reset',
          before: scheduleAuditPayload(deletedAgreement),
          after: {
            agreementId: deletedAgreement.id,
            studentId: input.studentId,
            schoolYearId: input.schoolYearId,
            reason: input.reason,
            scheduleSteps: [],
          },
        });
      }
      await new FinancialCacheService(new FinancialCacheRepository(tx as FinanceDb))
        .recalcStudent(input.studentId, input.schoolYearId);
      return { deleted: Boolean(deletedAgreement) };
    });
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
      return await this.repository.db.transaction(async (tx) => {
        const repository = new FinanceRepository(tx as FinanceDb);
        const tuitionPlan = await repository.upsertTuitionPlan(levelId, input);
        // Le détail financier calcule la situation en temps réel, tandis que
        // les listes et indicateurs s'appuient sur ce cache. Le recalcul est
        // dans la même transaction que le plan pour éviter tout état divergent.
        await new FinancialCacheService(new FinancialCacheRepository(tx as FinanceDb))
          .recalcAll(input.schoolYearId);
        return tuitionPlan;
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'SCHOOL_YEAR_NOT_OPEN') {
        throw new FinanceModuleError('L’année scolaire doit être ouverte par le support.', 409, 'SCHOOL_YEAR_NOT_OPEN');
      }
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
  async getReceiptPayload(paymentId: string) {
    const payment = await this.repository.getReceiptContext(paymentId);
    if (!payment) throw new FinanceModuleError('Payment not found', 404, 'PAYMENT_NOT_FOUND');
    const status = await this.getFinancialStatus(payment.student_id, payment.school_year_id);
    return {
      receiptNumber: payment.receipt_number,
      studentName: payment.student_name,
      className: payment.class_name,
      schoolYearLabel: payment.school_year_label,
      amount: FinanceRepository.toNumber(
        payment.enrollment_total_amount ?? payment.amount
      ),
      currency: payment.currency,
      method: payment.method,
      createdAt: iso(payment.created_at)!,
      paymentDate: payment.payment_date,
      paidAt: iso(payment.paid_at),
      schoolReceiptReference: payment.school_receipt_reference,
      remainingDue: status.remainingDue,
      subscriptionLines: payment.show_parent_alerts_on_receipt
        && FinanceRepository.toNumber(payment.enrollment_parent_alerts_amount) > 0
        ? [{
            label: 'Alertes Parents',
            amount: FinanceRepository.toNumber(payment.enrollment_parent_alerts_amount),
          }]
        : [],
    };
  }
}

export const buildFinanceService = (db: FinanceDb): FinanceService =>
  new FinanceService(new FinanceRepository(db));
