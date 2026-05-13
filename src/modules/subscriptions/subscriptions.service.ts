import { randomInt } from 'node:crypto';

import argon2 from 'argon2';

import { SubscriptionsRepository } from './subscriptions.repository.js';
import {
  businessDateFromNowPlusDays,
  monthKeyInBusinessTimezone,
  todayInBusinessTimezone,
} from '../../shared/utils/business-time.js';
import type {
  CanSendResult,
  CreateParentSubscriptionBody,
  ListParentsQuery,
  NotificationChannel,
  RenewParentSubscriptionBody,
  UpdateParentContactBody,
} from './subscriptions.types.js';

export class SubscriptionsModuleError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string
  ) {
    super(message);
    this.name = 'SubscriptionsModuleError';
  }
}

const randomFourDigits = (): string => String(randomInt(0, 10_000)).padStart(4, '0');
const EDUTRACK_COMMISSION_PCT = 15;

export class SubscriptionsService {
  constructor(private readonly repository: SubscriptionsRepository) {}

  private async resolveActorUserId(actorUserId: string): Promise<string> {
    const resolved = await this.repository.resolveActorUserId(actorUserId);
    if (!resolved) {
      throw new SubscriptionsModuleError('No eligible school user found to record this action', 422, 'NO_ELIGIBLE_ACTOR');
    }
    return resolved;
  }

  async canSendNotification(input: {
    studentId: string;
    tenantId?: string;
    schemaName: string;
    type: NotificationChannel;
  }): Promise<CanSendResult> {
    const tenantId = input.tenantId ?? (await this.repository.getTenantIdBySchemaName(input.schemaName));
    if (!tenantId) {
      return { allowed: false, reason: 'feature_disabled' };
    }

    const feature = await this.repository.getSmsFeatureByTenantId(tenantId);
    if (!feature || !feature.is_enabled) {
      return { allowed: false, reason: 'feature_disabled' };
    }

    const link = await this.repository.getActiveSubscriptionLinkByStudent(input.studentId);
    if (!link) {
      return { allowed: false, reason: 'no_active_subscription' };
    }

    const today = todayInBusinessTimezone();
    if (link.ends_at < today) {
      return { allowed: false, reason: 'subscription_expired' };
    }

    const usage = await this.repository.getUsageByStudentMonth(
      input.studentId,
      monthKeyInBusinessTimezone()
    );
    if (input.type === 'sms' && usage.sms >= feature.sms_cap_per_student) {
      return { allowed: false, reason: 'cap_reached' };
    }

    return {
      allowed: true,
      subscriptionId: link.subscription_id,
      parentPhone: link.parent_phone,
      parentEmail: link.parent_email,
    };
  }

  async incrementUsage(input: {
    studentId: string;
    subscriptionId: string;
    type: NotificationChannel;
  }): Promise<void> {
    await this.repository.incrementUsage({
      studentId: input.studentId,
      subscriptionId: input.subscriptionId,
      month: monthKeyInBusinessTimezone(),
      type: input.type,
    });
  }

  async listParents(schemaName: string, query: ListParentsQuery) {
    const result = await this.repository.listParents(query);
    const in30Iso = businessDateFromNowPlusDays(30);
    return {
      data: result.rows.map((row) => {
        const isMonthHistory = Boolean(query.month);
        const isActive = !isMonthHistory && row.status === 'active';
        const resolvedDurationMonths =
          isMonthHistory
            ? row.month_duration_months ?? row.duration_months
            : isActive && row.active_duration_months
              ? row.active_duration_months
              : row.duration_months;
        const resolvedTotalAmount =
          isMonthHistory
            ? row.month_total_amount_fcfa ?? row.total_amount_fcfa
            : isActive && row.active_total_amount_fcfa
              ? row.active_total_amount_fcfa
              : row.total_amount_fcfa;
        const resolvedEndsAt = isMonthHistory
          ? row.month_ends_at ?? row.ends_at
          : isActive && row.active_ends_at
            ? row.active_ends_at
            : row.ends_at;
        const resolvedStartsAt = isMonthHistory ? row.month_starts_at ?? row.starts_at : row.starts_at;
        const resolvedCreatedAt = isMonthHistory ? row.month_created_at ?? row.created_at : row.created_at;
        const daysRemaining =
          typeof row.month_days_remaining === 'number'
            ? row.month_days_remaining
            : resolvedEndsAt
              ? Math.max(
                  0,
                  Math.ceil(
                    (new Date(`${resolvedEndsAt}T00:00:00.000Z`).getTime() -
                      new Date(`${todayInBusinessTimezone()}T00:00:00.000Z`).getTime()) /
                      86_400_000
                  )
                )
              : null;
        const monthlyAmount =
          resolvedTotalAmount && resolvedDurationMonths
            ? Math.round(resolvedTotalAmount / resolvedDurationMonths)
            : null;
        return {
          parent_id: row.parent_id,
          full_name: row.full_name,
          phone: row.phone,
          email: row.email,
          latest_subscription: row.subscription_id
            ? {
                id: row.subscription_id,
                status: row.status,
                starts_at: resolvedStartsAt,
                ends_at: resolvedEndsAt,
                created_at: resolvedCreatedAt,
                duration_months: resolvedDurationMonths,
                total_amount_fcfa: resolvedTotalAmount,
                monthly_amount_fcfa: monthlyAmount,
                expires_soon: Boolean(resolvedEndsAt && resolvedEndsAt < in30Iso),
                days_remaining: daysRemaining,
              }
            : null,
          students: row.students ?? [],
        };
      }),
      pagination: {
        page: query.page,
        limit: query.limit,
        total: result.total,
        totalPages: result.total === 0 ? 0 : Math.ceil(result.total / query.limit),
      },
      schemaName,
    };
  }

  async listSubscriptionClasses(query: { search?: string }) {
    return this.repository.listSubscriptionClasses({ search: query.search });
  }

  async listSubscriptionStudentsByClass(query: {
    classId: string;
    page: number;
    limit: number;
    search?: string;
  }) {
    return this.repository.listSubscriptionStudentsByClass(query);
  }

  async createParentSubscription(input: {
    schemaName: string;
    actorUserId: string;
    payload: CreateParentSubscriptionBody;
  }) {
    const tenantId = await this.repository.getTenantIdBySchemaName(input.schemaName);
    if (!tenantId) {
      throw new SubscriptionsModuleError('Tenant not found', 404, 'TENANT_NOT_FOUND');
    }
    const feature = await this.repository.getSmsFeatureByTenantId(tenantId);
    if (!feature?.is_enabled) {
      throw new SubscriptionsModuleError('SMS feature is not enabled', 422, 'SMS_FEATURE_NOT_ENABLED');
    }
    if (!feature.sms_unit_price_fcfa || feature.sms_unit_price_fcfa <= 0) {
      throw new SubscriptionsModuleError('SMS price is not configured', 422, 'SMS_PRICE_NOT_CONFIGURED');
    }

    const students = await this.repository.getStudentsByIds(input.payload.student_ids);
    if (students.length !== input.payload.student_ids.length) {
      throw new SubscriptionsModuleError('Some students were not found', 400, 'INVALID_STUDENT_IDS');
    }

    const existingParent = await this.repository.findParentByPhone(input.payload.phone);
    if (existingParent) {
      throw new SubscriptionsModuleError('Parent already exists', 409, 'PARENT_ALREADY_EXISTS');
    }

    const tempPassword = randomFourDigits();
    const passwordHash = await argon2.hash(tempPassword);
    const actorUserId = await this.resolveActorUserId(input.actorUserId);

    const totalAmount =
      feature.sms_unit_price_fcfa *
      input.payload.student_ids.length *
      input.payload.duration_months;
    const { startsAt, endsAt } = this.repository.computeStartsAndEnds(input.payload.duration_months);

    let parentId: string;
    let subscriptionId: string;
    try {
      ({ parentId, subscriptionId } = await this.repository.createParentWithSubscriptionTx({
        fullName: input.payload.full_name,
        phone: input.payload.phone,
        email: input.payload.email,
        passwordHash,
        unitPriceFcfa: feature.sms_unit_price_fcfa,
        studentCount: input.payload.student_ids.length,
        totalAmountFcfa: totalAmount,
        durationMonths: input.payload.duration_months,
        startsAt,
        endsAt,
        createdBy: actorUserId,
        studentIds: input.payload.student_ids,
        paidNow: input.payload.paid_now,
        paymentMethod: input.payload.payment_method,
      }));
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === '23505') {
        throw new SubscriptionsModuleError('Parent already exists', 409, 'PARENT_ALREADY_EXISTS');
      }
      throw error;
    }

    return {
      parent: { id: parentId, full_name: input.payload.full_name, phone: input.payload.phone },
      subscription: {
        id: subscriptionId,
        total_amount_fcfa: totalAmount,
        starts_at: startsAt,
        ends_at: endsAt,
      },
      credentials: {
        phone: input.payload.phone,
        temp_password: tempPassword,
      },
      students,
    };
  }

  async getParentDetails(parentId: string) {
    const parent = await this.repository.getParentById(parentId);
    if (!parent) {
      throw new SubscriptionsModuleError('Parent not found', 404, 'PARENT_NOT_FOUND');
    }
    const subscriptions = await this.repository.getParentSubscriptions(parentId);
    const subscriptionsWithDetails = await Promise.all(
      subscriptions.map(async (item) => ({
        ...item,
        students: await this.repository.getSubscriptionStudents(item.id),
        payments: await this.repository.getSubscriptionPayments(item.id),
      }))
    );
    return { parent, subscriptions: subscriptionsWithDetails };
  }

  async renewParentSubscription(input: {
    parentId: string;
    actorUserId: string;
    payload: RenewParentSubscriptionBody;
    schemaName: string;
  }) {
    const parent = await this.repository.getParentById(input.parentId);
    if (!parent) {
      throw new SubscriptionsModuleError('Parent not found', 404, 'PARENT_NOT_FOUND');
    }
    const latest = await this.repository.getLatestSubscription(input.parentId);
    if (!latest) {
      throw new SubscriptionsModuleError('No previous subscription found', 404, 'SUBSCRIPTION_NOT_FOUND');
    }

    const students = await this.repository.getSubscriptionStudents(latest.id);
    if (students.length === 0) {
      throw new SubscriptionsModuleError('No linked students', 400, 'NO_STUDENTS_LINKED');
    }

    const tenantId = await this.repository.getTenantIdBySchemaName(input.schemaName);
    if (!tenantId) {
      throw new SubscriptionsModuleError('Tenant not found', 404, 'TENANT_NOT_FOUND');
    }
    const feature = await this.repository.getSmsFeatureByTenantId(tenantId);
    if (!feature?.sms_unit_price_fcfa || feature.sms_unit_price_fcfa <= 0) {
      throw new SubscriptionsModuleError('SMS price is not configured', 422, 'SMS_PRICE_NOT_CONFIGURED');
    }

    const { startsAt, endsAt } = this.repository.computeRenewalStartsAndEnds(
      latest.ends_at,
      input.payload.duration_months
    );
    const actorUserId = await this.resolveActorUserId(input.actorUserId);
    const totalAmount = feature.sms_unit_price_fcfa * students.length * input.payload.duration_months;

    const { subscriptionId } = await this.repository.renewSubscriptionTx({
      parentId: input.parentId,
      unitPriceFcfa: feature.sms_unit_price_fcfa,
      studentCount: students.length,
      totalAmountFcfa: totalAmount,
      durationMonths: input.payload.duration_months,
      startsAt,
      endsAt,
      createdBy: actorUserId,
      autoRenewAlert: latest.auto_renew_alert,
      studentIds: students.map((item) => item.id),
      paidNow: input.payload.paid_now,
      paymentMethod: input.payload.payment_method,
    });

    return { id: subscriptionId, starts_at: startsAt, ends_at: endsAt, total_amount_fcfa: totalAmount };
  }

  async updateParentContact(input: {
    parentId: string;
    actorUserId: string;
    actorRole: string;
    schemaName: string;
    payload: UpdateParentContactBody;
  }) {
    const parent = await this.repository.getParentById(input.parentId);
    if (!parent) {
      throw new SubscriptionsModuleError('Parent not found', 404, 'PARENT_NOT_FOUND');
    }

    const activeSubscription = await this.repository.getActiveSubscriptionByParentId(input.parentId);
    if (!activeSubscription) {
      throw new SubscriptionsModuleError(
        'Parent contact can only be updated for an active subscription',
        409,
        'ACTIVE_SUBSCRIPTION_REQUIRED'
      );
    }

    const existingParent = await this.repository.findParentByPhone(input.payload.phone);
    if (existingParent && existingParent.id !== input.parentId) {
      throw new SubscriptionsModuleError('Parent already exists', 409, 'PARENT_ALREADY_EXISTS');
    }

    const actorUserId = await this.resolveActorUserId(input.actorUserId);
    const updated = await this.repository.updateParentContact({
      parentId: input.parentId,
      phone: input.payload.phone,
      email: input.payload.email ?? null,
    });

    await this.repository.auditParentContactUpdate({
      schemaName: input.schemaName,
      actorId: actorUserId,
      actorRole: input.actorRole,
      subscriptionId: activeSubscription.id,
      before: {
        parentId: parent.id,
        fullName: parent.full_name,
        phone: parent.phone,
        email: parent.email,
      },
      after: {
        parentId: updated.id,
        fullName: updated.full_name,
        phone: updated.phone,
        email: updated.email,
      },
    });

    return { parent: updated };
  }

  async cancelSubscription(subscriptionId: string, parentId: string, actorUserId: string): Promise<void> {
    const subscription = await this.repository.getSubscriptionById(subscriptionId);
    if (!subscription) {
      throw new SubscriptionsModuleError('Subscription not found', 404, 'SUBSCRIPTION_NOT_FOUND');
    }
    if (subscription.parent_id !== parentId) {
      throw new SubscriptionsModuleError('Subscription does not belong to this parent', 403, 'SUBSCRIPTION_OWNERSHIP_MISMATCH');
    }
    if (subscription.status === 'cancelled') {
      throw new SubscriptionsModuleError('Subscription is already cancelled', 409, 'SUBSCRIPTION_ALREADY_CANCELLED');
    }
    const resolvedActorId = await this.resolveActorUserId(actorUserId);
    await this.repository.updateSubscriptionStatus(subscriptionId, 'cancelled', resolvedActorId);
  }

  async getSchoolSmsFeatureSettings(schemaName: string) {
    const tenantId = await this.repository.getTenantIdBySchemaName(schemaName);
    if (!tenantId) {
      throw new SubscriptionsModuleError('Tenant not found', 404, 'TENANT_NOT_FOUND');
    }

    const feature = await this.repository.getSmsFeatureByTenantId(tenantId);
    return {
      is_enabled: feature?.is_enabled ?? false,
      monetize_parent_alerts: feature?.monetize_parent_alerts ?? false,
      commission_pct: EDUTRACK_COMMISSION_PCT,
      sms_unit_price_fcfa: feature?.sms_unit_price_fcfa ?? null,
      use_real_hours: feature?.use_real_hours ?? false,
      geo_check_enabled: feature?.geo_check_enabled ?? false,
      checkout_tolerance_minutes: feature?.checkout_tolerance_minutes ?? 5,
    };
  }

  async updateSchoolSmsUnitPrice(input: { schemaName: string; smsUnitPriceFcfa: number }) {
    const tenantId = await this.repository.getTenantIdBySchemaName(input.schemaName);
    if (!tenantId) {
      throw new SubscriptionsModuleError('Tenant not found', 404, 'TENANT_NOT_FOUND');
    }

    const feature = await this.repository.updateSmsUnitPriceByTenantId(
      tenantId,
      input.smsUnitPriceFcfa
    );
    return {
      is_enabled: feature.is_enabled,
      monetize_parent_alerts: feature.monetize_parent_alerts,
      commission_pct: EDUTRACK_COMMISSION_PCT,
      sms_unit_price_fcfa: feature.sms_unit_price_fcfa,
      use_real_hours: feature.use_real_hours,
      geo_check_enabled: feature.geo_check_enabled,
      checkout_tolerance_minutes: feature.checkout_tolerance_minutes,
    };
  }

  async resetParentPassword(parentId: string): Promise<{ phone: string; new_temp_password: string }> {
    const parent = await this.repository.getParentById(parentId);
    if (!parent) {
      throw new SubscriptionsModuleError('Parent not found', 404, 'PARENT_NOT_FOUND');
    }
    const temp = randomFourDigits();
    const hash = await argon2.hash(temp);
    await this.repository.updateParentPassword(parentId, hash);
    return { phone: parent.phone, new_temp_password: temp };
  }

  async revenueSummary(schemaName: string, month?: string) {
    const targetMonth = month ?? monthKeyInBusinessTimezone();
    const tenantId = await this.repository.getTenantIdBySchemaName(schemaName);
    if (!tenantId) {
      throw new SubscriptionsModuleError('Tenant not found', 404, 'TENANT_NOT_FOUND');
    }
    const feature = await this.repository.getSmsFeatureByTenantId(tenantId);
    const summary = await this.repository.getRevenueSummary({ tenantId, month: targetMonth });
    const commissionPct = EDUTRACK_COMMISSION_PCT;
    const due = Math.round((summary.total_collected_fcfa * commissionPct) / 100);
    return {
      month: targetMonth,
      subscriptions_active_count: summary.subscriptions_active_count,
      subscriptions_new_this_month: summary.subscriptions_new_this_month,
      total_collected_fcfa: summary.total_collected_fcfa,
      monthly_revenue_prorated_fcfa: summary.monthly_revenue_prorated_fcfa,
      commission_pct: commissionPct,
      commission_due_fcfa: due,
      commission_paid_fcfa: summary.commission_paid_fcfa,
      commission_remaining_fcfa: Math.max(0, due - summary.commission_paid_fcfa),
      sms_unit_price_fcfa: feature?.sms_unit_price_fcfa ?? null,
    };
  }

  async revenueHistory(schemaName: string, months: number) {
    const tenantId = await this.repository.getTenantIdBySchemaName(schemaName);
    if (!tenantId) {
      throw new SubscriptionsModuleError('Tenant not found', 404, 'TENANT_NOT_FOUND');
    }
    return this.repository.listRevenueHistory({ tenantId, months });
  }

  async revenuePayments(schemaName: string, month: string) {
    const tenantId = await this.repository.getTenantIdBySchemaName(schemaName);
    if (!tenantId) {
      throw new SubscriptionsModuleError('Tenant not found', 404, 'TENANT_NOT_FOUND');
    }
    return this.repository.listCommissionPaymentsForMonth({ tenantId, month });
  }

  async revenueSubscriptionDetails(schemaName: string, month: string) {
    const tenantId = await this.repository.getTenantIdBySchemaName(schemaName);
    if (!tenantId) {
      throw new SubscriptionsModuleError('Tenant not found', 404, 'TENANT_NOT_FOUND');
    }
    return this.repository.listRevenueSubscriptionDetails(month);
  }

  async recordCommissionPayment(input: {
    schemaName: string;
    periodMonth: string;
    amountFcfa: number;
    paymentMethod?: 'cash' | 'momo_mtn' | 'momo_orange' | 'bank_transfer';
    notes?: string;
    idempotencyKey: string;
    actorId: string;
    actorRole: string;
  }) {
    const tenantId = await this.repository.getTenantIdBySchemaName(input.schemaName);
    if (!tenantId) {
      throw new SubscriptionsModuleError('Tenant not found', 404, 'TENANT_NOT_FOUND');
    }
    const action = 'subscriptions.record_commission_payment';
    const replay = await this.repository.findFinancialAuditReplay<{
      success: boolean;
      idempotency_replayed?: boolean;
    }>({
      tenantId,
      action,
      idempotencyKey: input.idempotencyKey,
    });
    if (replay) {
      return { ...replay, idempotency_replayed: true };
    }

    const commissionPct = EDUTRACK_COMMISSION_PCT;
    const summary = await this.revenueSummary(input.schemaName, input.periodMonth);
    const result = await this.repository.runCommissionPaymentWithAudit({
      tenantId,
      periodMonth: input.periodMonth,
      amountFcfa: input.amountFcfa,
      paymentMethod: input.paymentMethod,
      notes: input.notes,
      commissionPct,
      dueFcfa: summary.commission_due_fcfa,
      action,
      idempotencyKey: input.idempotencyKey,
      actorId: input.actorId,
      actorRole: input.actorRole,
    });

    return { success: true, idempotency_replayed: result.replayed };
  }

  async runDailyMaintenance(): Promise<{ expired: number; alerts: number }> {
    const expired = await this.repository.expireOutdatedSubscriptions();
    const alerts = await this.repository.listRenewalAlertsInSevenDays();
    for (const item of alerts) {
      await this.repository.insertSubscriptionExpiryAlertLog({
        parentPhone: item.parentPhone,
        message: `Votre souscription SMS expire le ${item.endsAt}. Contactez le secrétariat.`,
      });
    }
    return { expired, alerts: alerts.length };
  }
}
