import { randomUUID } from 'node:crypto';

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
  createdAt: iso(row.created_at),
});

export class FinanceService {
  constructor(private readonly repository: FinanceRepository) {}

  private async amountDueWith(repository: FinanceRepository, studentId: string, schoolYearId: string) {
    const context = await repository.getAmountDueContext(studentId, schoolYearId);
    const subscriptionPlans = await repository.listMandatorySubscriptionPlans();
    if (!context) {
      throw new FinanceModuleError(
        'A tuition plan is required for the student class and school year',
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

  async getFinancialStatus(studentId: string, schoolYearId: string, asOfDate = todayIso()) {
    const due = await this.getAmountDue(studentId, schoolYearId);
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
      return { payment: mapPayment(payment), financialStatus };
    });
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

  async upsertTuitionPlan(classId: string, input: UpsertTuitionPlanInput) {
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
      return await this.repository.upsertTuitionPlan(classId, input);
    } catch (error) {
      if ((error as { code?: string }).code === '23503') {
        throw new FinanceModuleError('Class not found', 404, 'CLASS_NOT_FOUND');
      }
      throw error;
    }
  }

  listTuitionPlans(classId?: string) { return this.repository.listTuitionPlans(classId); }
  listProviderSettings() { return this.repository.listProviderSettings(); }
  async getProviderAvailability() {
    const providers = await this.repository.getProviderAvailability();
    return { inAppPaymentActive: providers.length > 0, providers };
  }
  upsertProviderSetting(input: {
    provider: MobileMoneyProvider;
    merchantNumber: string;
    apiCredentials: Record<string, unknown>;
    isActive: boolean;
  }) { return this.repository.upsertProviderSetting(input); }
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
