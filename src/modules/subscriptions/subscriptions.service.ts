import argon2 from 'argon2';

import { SubscriptionsRepository } from './subscriptions.repository.js';
import {
  businessDateFromNowPlusDays,
  monthKeyInBusinessTimezone,
  todayInBusinessTimezone,
} from '../../shared/utils/business-time.js';
import { generateInitialPassword } from '../../shared/utils/password-generator.js';
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
const EDUTRACK_COMMISSION_PCT = 15;

// Fenêtre pendant laquelle un abonnement peut être annulé (et donc remboursé
// intégralement). Passé ce délai, l'annulation est refusée : la fenêtre sert à
// corriger une erreur de saisie, pas à rembourser un service déjà consommé.
const CANCELLATION_WINDOW_DAYS = 7;
const CANCELLATION_WINDOW_MS = CANCELLATION_WINDOW_DAYS * 24 * 60 * 60 * 1000;

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
    const result = await this.repository.listParents({
      page: query.page,
      limit: query.limit,
      search: query.search,
      status: query.status,
      month: query.month,
      createdBy: query.created_by,
    });
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
          access_sent_at: row.access_sent_at,
          created_by: row.created_by,
          created_by_name: row.created_by_name,
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
                created_by: row.created_by,
                created_by_name: row.created_by_name,
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

  async listCreators() {
    return this.repository.listSubscriptionCreators();
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

    const tempPassword = generateInitialPassword(10);
    const passwordHash = await argon2.hash(tempPassword);
    const actorUserId = await this.resolveActorUserId(input.actorUserId);

    const totalAmount =
      feature.sms_unit_price_fcfa *
      input.payload.student_ids.length *
      input.payload.duration_months;
    const { startsAt, endsAt } = this.repository.computeStartsAndEnds(input.payload.duration_months);

    let parentId: string;
    let subscriptionId: string;
    let parentCreated: boolean;
    try {
      ({ parentId, subscriptionId, parentCreated } = await this.repository.createParentWithSubscriptionTx({
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
        throw new SubscriptionsModuleError(
          'Subscription conflicts with an existing active link',
          409,
          'SUBSCRIPTION_LINK_CONFLICT'
        );
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
      credentials: parentCreated
        ? {
            phone: input.payload.phone,
            temp_password: tempPassword,
          }
        : null,
      students,
    };
  }

  async getParentDetails(parentId: string) {
    const parent = await this.repository.getParentById(parentId);
    if (!parent) {
      throw new SubscriptionsModuleError('Parent not found', 404, 'PARENT_NOT_FOUND');
    }
    const subscriptions = await this.repository.getParentSubscriptions(parentId);
    const subscriptionIds = subscriptions.map((item) => item.id);

    // Batch : 2 requêtes au total (au lieu de 2 par abonnement → N+1).
    const [allStudents, allPayments] = await Promise.all([
      this.repository.getSubscriptionStudentsForIds(subscriptionIds),
      this.repository.getSubscriptionPaymentsForIds(subscriptionIds),
    ]);

    const studentsBySub = new Map<string, typeof allStudents>();
    for (const row of allStudents) {
      const list = studentsBySub.get(row.subscription_id) ?? [];
      list.push(row);
      studentsBySub.set(row.subscription_id, list);
    }
    const paymentsBySub = new Map<string, typeof allPayments>();
    for (const row of allPayments) {
      const list = paymentsBySub.get(row.subscription_id) ?? [];
      list.push(row);
      paymentsBySub.set(row.subscription_id, list);
    }

    // On retire la clé de regroupement subscription_id avant de renvoyer, pour
    // conserver exactement la forme historique (StudentRow / PaymentRow).
    const stripSubId = <T extends { subscription_id: string }>(rows: T[]): Omit<T, 'subscription_id'>[] =>
      rows.map(({ subscription_id, ...rest }) => {
        void subscription_id;
        return rest;
      });

    const subscriptionsWithDetails = subscriptions.map((item) => ({
      ...item,
      students: stripSubId(studentsBySub.get(item.id) ?? []),
      payments: stripSubId(paymentsBySub.get(item.id) ?? []),
    }));
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

  async cancelSubscription(input: {
    subscriptionId: string;
    parentId: string;
    actorUserId: string;
    actorRole: string;
    schemaName: string;
    reason: string;
  }): Promise<void> {
    const subscription = await this.repository.getSubscriptionById(input.subscriptionId);
    if (!subscription) {
      throw new SubscriptionsModuleError('Subscription not found', 404, 'SUBSCRIPTION_NOT_FOUND');
    }
    if (subscription.parent_id !== input.parentId) {
      throw new SubscriptionsModuleError('Subscription does not belong to this parent', 403, 'SUBSCRIPTION_OWNERSHIP_MISMATCH');
    }
    if (subscription.status === 'cancelled') {
      throw new SubscriptionsModuleError('Subscription is already cancelled', 409, 'SUBSCRIPTION_ALREADY_CANCELLED');
    }

    // Fenêtre d'annulation : uniquement dans les 7 jours suivant la souscription.
    // Au-delà, l'annulation (et donc le remboursement) est impossible.
    const ageMs = Date.now() - new Date(subscription.created_at).getTime();
    if (ageMs >= CANCELLATION_WINDOW_MS) {
      throw new SubscriptionsModuleError(
        `L'annulation n'est possible que dans les ${CANCELLATION_WINDOW_DAYS} jours suivant la souscription`,
        409,
        'CANCELLATION_WINDOW_CLOSED'
      );
    }

    const resolvedActorId = await this.resolveActorUserId(input.actorUserId);
    // L'audit (public.audit_financial_events) et le changement de statut (schéma
    // tenant) sont sur deux schémas distincts : on ne peut pas les englober dans
    // une transaction unique simplement. On écrit donc l'audit AVANT le passage en
    // 'cancelled'. Ainsi, si l'audit échoue, le statut n'a pas changé et l'action
    // peut être rejouée à l'identique (la garde ALREADY_CANCELLED n'a pas encore
    // basculé). Une fois l'audit en base, on bascule le statut : le passage en
    // 'cancelled' exclut l'abonnement du collecté et de la commission
    // (cf. getRevenueSummary, WHERE status <> 'cancelled'), rendant le
    // remboursement intégral effectif sans écriture monétaire.
    await this.repository.auditSubscriptionCancellation({
      schemaName: input.schemaName,
      actorId: resolvedActorId,
      actorRole: input.actorRole,
      subscriptionId: input.subscriptionId,
      reason: input.reason,
      refundedAmountFcfa: subscription.total_amount_fcfa,
      withinWindow: true,
    });
    await this.repository.updateSubscriptionStatus(input.subscriptionId, 'cancelled', resolvedActorId);
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
    const temp = generateInitialPassword(10);
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

  async commissionOverdueAlerts(schemaName: string) {
    const tenantId = await this.repository.getTenantIdBySchemaName(schemaName);
    if (!tenantId) {
      throw new SubscriptionsModuleError('Tenant not found', 404, 'TENANT_NOT_FOUND');
    }
    const now = new Date();
    const currentMonth = monthKeyInBusinessTimezone(now);
    // Vérifie les 12 derniers mois (hors mois courant)
    const history = await this.repository.listRevenueHistory({ tenantId, months: 13 });
    const overdueMonths = history.filter(
      (row) => row.month < currentMonth && row.commission_remaining_fcfa > 0 && row.total_collected_fcfa > 0
    );
    return {
      count: overdueMonths.length,
      totalRemainingFcfa: overdueMonths.reduce((sum, row) => sum + row.commission_remaining_fcfa, 0),
      months: overdueMonths.map((row) => ({
        month: row.month,
        remainingFcfa: row.commission_remaining_fcfa,
        collectedFcfa: row.total_collected_fcfa,
        paymentStatus: row.payment_status,
      })),
    };
  }

  async revenueSubscriptionDetails(schemaName: string, month: string) {
    const tenantId = await this.repository.getTenantIdBySchemaName(schemaName);
    if (!tenantId) {
      throw new SubscriptionsModuleError('Tenant not found', 404, 'TENANT_NOT_FOUND');
    }
    return this.repository.listRevenueSubscriptionDetails(month);
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
