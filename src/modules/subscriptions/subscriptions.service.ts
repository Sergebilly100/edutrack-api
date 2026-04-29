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

export class SubscriptionsService {
  constructor(private readonly repository: SubscriptionsRepository) {}

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
        const monthlyAmount =
          row.total_amount_fcfa && row.duration_months
            ? Math.round(row.total_amount_fcfa / row.duration_months)
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
                starts_at: row.starts_at,
                ends_at: row.ends_at,
                monthly_amount_fcfa: monthlyAmount,
                expires_soon: Boolean(row.ends_at && row.ends_at < in30Iso),
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
    let parentId: string;
    try {
      parentId = await this.repository.createParent({
        fullName: input.payload.full_name,
        phone: input.payload.phone,
        email: input.payload.email,
        passwordHash,
      });
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === '23505') {
        throw new SubscriptionsModuleError('Parent already exists', 409, 'PARENT_ALREADY_EXISTS');
      }
      throw error;
    }

    const totalAmount =
      feature.sms_unit_price_fcfa *
      input.payload.student_ids.length *
      input.payload.duration_months;
    const { startsAt, endsAt } = this.repository.computeStartsAndEnds(input.payload.duration_months);
    const subscriptionId = await this.repository.createSubscription({
      parentId,
      unitPriceFcfa: feature.sms_unit_price_fcfa,
      studentCount: input.payload.student_ids.length,
      totalAmountFcfa: totalAmount,
      durationMonths: input.payload.duration_months,
      startsAt,
      endsAt,
      createdBy: input.actorUserId,
    });

    await this.repository.createParentStudentLinks({
      parentId,
      subscriptionId,
      studentIds: input.payload.student_ids,
    });

    if (input.payload.paid_now) {
      await this.repository.createPayment({
        subscriptionId,
        amountFcfa: totalAmount,
        paymentMethod: input.payload.payment_method,
        recordedBy: input.actorUserId,
      });
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
    const totalAmount = feature.sms_unit_price_fcfa * students.length * input.payload.duration_months;
    const subscriptionId = await this.repository.createSubscription({
      parentId: input.parentId,
      unitPriceFcfa: feature.sms_unit_price_fcfa,
      studentCount: students.length,
      totalAmountFcfa: totalAmount,
      durationMonths: input.payload.duration_months,
      startsAt,
      endsAt,
      createdBy: input.actorUserId,
      autoRenewAlert: latest.auto_renew_alert,
    });
    await this.repository.createParentStudentLinks({
      parentId: input.parentId,
      subscriptionId,
      studentIds: students.map((item) => item.id),
    });
    if (input.payload.paid_now) {
      await this.repository.createPayment({
        subscriptionId,
        amountFcfa: totalAmount,
        paymentMethod: input.payload.payment_method,
        recordedBy: input.actorUserId,
      });
    }
    return { id: subscriptionId, starts_at: startsAt, ends_at: endsAt, total_amount_fcfa: totalAmount };
  }

  async cancelSubscription(subscriptionId: string): Promise<void> {
    await this.repository.updateSubscriptionStatus(subscriptionId, 'cancelled');
  }

  async getSchoolSmsFeatureSettings(schemaName: string) {
    const tenantId = await this.repository.getTenantIdBySchemaName(schemaName);
    if (!tenantId) {
      throw new SubscriptionsModuleError('Tenant not found', 404, 'TENANT_NOT_FOUND');
    }

    const feature = await this.repository.getSmsFeatureByTenantId(tenantId);
    return {
      is_enabled: feature?.is_enabled ?? false,
      commission_pct: Number(feature?.commission_pct ?? 0),
      sms_unit_price_fcfa: feature?.sms_unit_price_fcfa ?? null,
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
      commission_pct: Number(feature.commission_pct ?? 0),
      sms_unit_price_fcfa: feature.sms_unit_price_fcfa,
    };
  }

  async resetParentPassword(parentId: string): Promise<{ new_temp_password: string }> {
    const parent = await this.repository.getParentById(parentId);
    if (!parent) {
      throw new SubscriptionsModuleError('Parent not found', 404, 'PARENT_NOT_FOUND');
    }
    const temp = randomFourDigits();
    const hash = await argon2.hash(temp);
    await this.repository.updateParentPassword(parentId, hash);
    return { new_temp_password: temp };
  }

  async revenueSummary(schemaName: string, month?: string) {
    const targetMonth = month ?? monthKeyInBusinessTimezone();
    const tenantId = await this.repository.getTenantIdBySchemaName(schemaName);
    if (!tenantId) {
      throw new SubscriptionsModuleError('Tenant not found', 404, 'TENANT_NOT_FOUND');
    }
    const feature = await this.repository.getSmsFeatureByTenantId(tenantId);
    const summary = await this.repository.getRevenueSummary({ tenantId, month: targetMonth });
    const commissionPct = Number(feature?.commission_pct ?? 0);
    const due = Math.round((summary.monthly_revenue_prorated_fcfa * commissionPct) / 100);
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

  async recordCommissionPayment(input: {
    schemaName: string;
    periodMonth: string;
    amountFcfa: number;
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

    const feature = await this.repository.getSmsFeatureByTenantId(tenantId);
    const commissionPct = Number(feature?.commission_pct ?? 0);
    const summary = await this.revenueSummary(input.schemaName, input.periodMonth);
    const result = await this.repository.runCommissionPaymentWithAudit({
      tenantId,
      periodMonth: input.periodMonth,
      amountFcfa: input.amountFcfa,
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

  async runDailyMaintenance(schemaName: string): Promise<{ expired: number; alerts: number }> {
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
