import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { db as publicDb } from '../../shared/database/db.js';
import type { NotificationChannel, SubscriptionStatus } from './subscriptions.types.js';

type TenantDb = NodePgDatabase<Record<string, unknown>>;

type PublicFeatureRow = {
  tenant_id: string;
  is_enabled: boolean;
  sms_cap_per_student: number;
  commission_pct: string | number;
  sms_unit_price_fcfa: number | null;
};

type ParentListRow = {
  parent_id: string;
  full_name: string;
  phone: string;
  email: string | null;
  subscription_id: string | null;
  status: SubscriptionStatus | null;
  ends_at: string | null;
  starts_at: string | null;
  total_amount_fcfa: number | null;
  duration_months: number | null;
  students: Array<{ id: string; full_name: string }>;
};

type ParentDetailRow = {
  id: string;
  full_name: string;
  phone: string;
  email: string | null;
  is_active: boolean;
  created_at: string;
};

type SubscriptionRow = {
  id: string;
  status: SubscriptionStatus;
  unit_price_fcfa: number;
  student_count: number;
  total_amount_fcfa: number;
  duration_months: number;
  starts_at: string;
  ends_at: string;
  auto_renew_alert: boolean;
  renewed_count: number;
  created_at: string;
};

type StudentRow = { id: string; full_name: string };
type PaymentRow = {
  id: string;
  amount_fcfa: number;
  payment_method: string;
  paid_at: string;
  created_at: string;
  notes: string | null;
};

type ActiveLinkRow = {
  subscription_id: string;
  parent_phone: string;
  parent_email: string | null;
  ends_at: string;
};

const monthToDate = (month: string): string => `${month}-01`;

const formatMonth = (date: Date): string =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;

const firstDayOfMonth = (month: string): string => `${month}-01`;

const addMonths = (isoDate: string, months: number): string => {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
};

const addDays = (isoDate: string, days: number): string => {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

export class SubscriptionsRepository {
  constructor(private readonly tenantDb: TenantDb) {}

  async getTenantIdBySchemaName(schemaName: string): Promise<string | null> {
    const result = await publicDb.execute<{ id: string }>(sql`
      SELECT id::text AS id
      FROM public.tenants
      WHERE schema_name = ${schemaName}
      LIMIT 1
    `);
    return result.rows[0]?.id ?? null;
  }

  async getSmsFeatureByTenantId(tenantId: string): Promise<PublicFeatureRow | null> {
    const result = await publicDb.execute<PublicFeatureRow>(sql`
      SELECT
        tenant_id::text,
        is_enabled,
        sms_cap_per_student,
        commission_pct,
        sms_unit_price_fcfa
      FROM public.school_sms_features
      WHERE tenant_id = ${tenantId}::uuid
      LIMIT 1
    `);
    return result.rows[0] ?? null;
  }

  async getActiveSubscriptionLinkByStudent(studentId: string): Promise<ActiveLinkRow | null> {
    const result = await this.tenantDb.execute<ActiveLinkRow>(sql`
      SELECT
        psl.subscription_id::text AS subscription_id,
        p.phone AS parent_phone,
        p.email AS parent_email,
        ps.ends_at::text AS ends_at
      FROM parent_student_links psl
      INNER JOIN parent_subscriptions ps ON ps.id = psl.subscription_id
      INNER JOIN parents p ON p.id = psl.parent_id
      WHERE psl.student_id = ${studentId}::uuid
        AND ps.status = 'active'
      ORDER BY ps.ends_at DESC
      LIMIT 1
    `);
    return result.rows[0] ?? null;
  }

  async getUsageByStudentMonth(studentId: string, month: string): Promise<{ sms: number; email: number }> {
    const result = await this.tenantDb.execute<{ sms_sent_count: number; email_sent_count: number }>(sql`
      SELECT sms_sent_count, email_sent_count
      FROM sms_usage_log
      WHERE student_id = ${studentId}::uuid
        AND month = ${month}
      LIMIT 1
    `);
    return {
      sms: result.rows[0]?.sms_sent_count ?? 0,
      email: result.rows[0]?.email_sent_count ?? 0,
    };
  }

  async incrementUsage(params: {
    studentId: string;
    subscriptionId: string;
    month: string;
    type: NotificationChannel;
  }): Promise<void> {
    if (params.type === 'sms') {
      await this.tenantDb.execute(sql`
        INSERT INTO sms_usage_log (subscription_id, student_id, month, sms_sent_count, email_sent_count, updated_at)
        VALUES (${params.subscriptionId}::uuid, ${params.studentId}::uuid, ${params.month}, 1, 0, NOW())
        ON CONFLICT (student_id, month)
        DO UPDATE SET
          sms_sent_count = sms_usage_log.sms_sent_count + 1,
          updated_at = NOW()
      `);
      return;
    }

    await this.tenantDb.execute(sql`
      INSERT INTO sms_usage_log (subscription_id, student_id, month, sms_sent_count, email_sent_count, updated_at)
      VALUES (${params.subscriptionId}::uuid, ${params.studentId}::uuid, ${params.month}, 0, 1, NOW())
      ON CONFLICT (student_id, month)
      DO UPDATE SET
        email_sent_count = sms_usage_log.email_sent_count + 1,
        updated_at = NOW()
    `);
  }

  async listParents(params: {
    page: number;
    limit: number;
    search?: string;
    status?: SubscriptionStatus;
  }): Promise<{ rows: ParentListRow[]; total: number }> {
    const offset = (params.page - 1) * params.limit;
    const searchLike = params.search ? `%${params.search}%` : null;
    const statusFilter = params.status ?? null;
    const countResult = await this.tenantDb.execute<{ total: number }>(sql`
      SELECT COUNT(*)::int AS total
      FROM parents p
      WHERE (${searchLike}::text IS NULL OR p.full_name ILIKE ${searchLike} OR p.phone ILIKE ${searchLike})
    `);
    const total = countResult.rows[0]?.total ?? 0;

    const result = await this.tenantDb.execute<ParentListRow>(sql`
      WITH latest_sub AS (
        SELECT DISTINCT ON (ps.parent_id)
          ps.parent_id,
          ps.id AS subscription_id,
          ps.status,
          ps.starts_at,
          ps.ends_at,
          ps.total_amount_fcfa,
          ps.duration_months
        FROM parent_subscriptions ps
        ORDER BY ps.parent_id, ps.created_at DESC
      )
      SELECT
        p.id::text AS parent_id,
        p.full_name,
        p.phone,
        p.email,
        ls.subscription_id::text AS subscription_id,
        ls.status,
        ls.ends_at::text AS ends_at,
        ls.starts_at::text AS starts_at,
        ls.total_amount_fcfa,
        ls.duration_months,
        COALESCE(
          (
            SELECT json_agg(json_build_object('id', s.id::text, 'full_name', CONCAT(s.first_name, ' ', s.last_name)))
            FROM parent_student_links psl
            INNER JOIN students s ON s.id = psl.student_id
            WHERE psl.parent_id = p.id
          ),
          '[]'::json
        ) AS students
      FROM parents p
      LEFT JOIN latest_sub ls ON ls.parent_id = p.id
      WHERE (${searchLike}::text IS NULL OR p.full_name ILIKE ${searchLike} OR p.phone ILIKE ${searchLike})
        AND (${statusFilter}::text IS NULL OR ls.status::text = ${statusFilter})
      ORDER BY p.created_at DESC
      LIMIT ${params.limit}
      OFFSET ${offset}
    `);
    return { rows: result.rows, total };
  }

  async createParent(params: {
    fullName: string;
    phone: string;
    email?: string;
    passwordHash: string;
  }): Promise<string> {
    const result = await this.tenantDb.execute<{ id: string }>(sql`
      INSERT INTO parents (full_name, phone, email, password_hash, is_active)
      VALUES (${params.fullName}, ${params.phone}, ${params.email ?? null}, ${params.passwordHash}, true)
      RETURNING id::text
    `);
    return result.rows[0]!.id;
  }

  async getStudentsByIds(studentIds: string[]): Promise<StudentRow[]> {
    if (studentIds.length === 0) return [];
    const result = await this.tenantDb.execute<StudentRow>(sql`
      SELECT id::text AS id, CONCAT(first_name, ' ', last_name) AS full_name
      FROM students
      WHERE id IN (${sql.join(studentIds.map((id) => sql`${id}::uuid`), sql`, `)})
    `);
    return result.rows;
  }

  async createSubscription(params: {
    parentId: string;
    unitPriceFcfa: number;
    studentCount: number;
    totalAmountFcfa: number;
    durationMonths: number;
    startsAt: string;
    endsAt: string;
    createdBy: string;
    autoRenewAlert?: boolean;
    status?: SubscriptionStatus;
  }): Promise<string> {
    const result = await this.tenantDb.execute<{ id: string }>(sql`
      INSERT INTO parent_subscriptions (
        parent_id, unit_price_fcfa, student_count, total_amount_fcfa, duration_months,
        starts_at, ends_at, status, auto_renew_alert, renewed_count, created_by
      ) VALUES (
        ${params.parentId}::uuid,
        ${params.unitPriceFcfa},
        ${params.studentCount},
        ${params.totalAmountFcfa},
        ${params.durationMonths},
        ${params.startsAt},
        ${params.endsAt},
        ${params.status ?? 'active'},
        ${params.autoRenewAlert ?? false},
        0,
        ${params.createdBy}::uuid
      )
      RETURNING id::text
    `);
    return result.rows[0]!.id;
  }

  async createParentStudentLinks(params: {
    parentId: string;
    subscriptionId: string;
    studentIds: string[];
  }): Promise<void> {
    for (const studentId of params.studentIds) {
      await this.tenantDb.execute(sql`
        INSERT INTO parent_student_links (subscription_id, parent_id, student_id)
        VALUES (${params.subscriptionId}::uuid, ${params.parentId}::uuid, ${studentId}::uuid)
      `);
    }
  }

  async createPayment(params: {
    subscriptionId: string;
    amountFcfa: number;
    paymentMethod: string;
    recordedBy: string;
    notes?: string;
  }): Promise<void> {
    await this.tenantDb.execute(sql`
      INSERT INTO subscription_payments (subscription_id, amount_fcfa, payment_method, paid_at, recorded_by, notes)
      VALUES (
        ${params.subscriptionId}::uuid,
        ${params.amountFcfa},
        ${params.paymentMethod},
        NOW(),
        ${params.recordedBy}::uuid,
        ${params.notes ?? null}
      )
    `);
  }

  async getParentById(parentId: string): Promise<ParentDetailRow | null> {
    const result = await this.tenantDb.execute<ParentDetailRow>(sql`
      SELECT id::text, full_name, phone, email, is_active, created_at::text
      FROM parents
      WHERE id = ${parentId}::uuid
      LIMIT 1
    `);
    return result.rows[0] ?? null;
  }

  async getParentSubscriptions(parentId: string): Promise<SubscriptionRow[]> {
    const result = await this.tenantDb.execute<SubscriptionRow>(sql`
      SELECT
        id::text,
        status::text AS status,
        unit_price_fcfa,
        student_count,
        total_amount_fcfa,
        duration_months,
        starts_at::text,
        ends_at::text,
        auto_renew_alert,
        renewed_count,
        created_at::text
      FROM parent_subscriptions
      WHERE parent_id = ${parentId}::uuid
      ORDER BY created_at DESC
    `);
    return result.rows;
  }

  async getSubscriptionStudents(subscriptionId: string): Promise<StudentRow[]> {
    const result = await this.tenantDb.execute<StudentRow>(sql`
      SELECT s.id::text AS id, CONCAT(s.first_name, ' ', s.last_name) AS full_name
      FROM parent_student_links psl
      INNER JOIN students s ON s.id = psl.student_id
      WHERE psl.subscription_id = ${subscriptionId}::uuid
      ORDER BY s.last_name, s.first_name
    `);
    return result.rows;
  }

  async getSubscriptionPayments(subscriptionId: string): Promise<PaymentRow[]> {
    const result = await this.tenantDb.execute<PaymentRow>(sql`
      SELECT
        id::text,
        amount_fcfa,
        payment_method,
        paid_at::text,
        created_at::text,
        notes
      FROM subscription_payments
      WHERE subscription_id = ${subscriptionId}::uuid
      ORDER BY paid_at DESC
    `);
    return result.rows;
  }

  async getLatestSubscription(parentId: string): Promise<SubscriptionRow | null> {
    const result = await this.tenantDb.execute<SubscriptionRow>(sql`
      SELECT
        id::text,
        status::text AS status,
        unit_price_fcfa,
        student_count,
        total_amount_fcfa,
        duration_months,
        starts_at::text,
        ends_at::text,
        auto_renew_alert,
        renewed_count,
        created_at::text
      FROM parent_subscriptions
      WHERE parent_id = ${parentId}::uuid
      ORDER BY created_at DESC
      LIMIT 1
    `);
    return result.rows[0] ?? null;
  }

  async updateSubscriptionStatus(subscriptionId: string, status: SubscriptionStatus): Promise<void> {
    await this.tenantDb.execute(sql`
      UPDATE parent_subscriptions
      SET status = ${status}
      WHERE id = ${subscriptionId}::uuid
    `);
  }

  async updateParentPassword(parentId: string, passwordHash: string): Promise<void> {
    await this.tenantDb.execute(sql`
      UPDATE parents
      SET password_hash = ${passwordHash}
      WHERE id = ${parentId}::uuid
    `);
  }

  async computeMonthlyRevenue(month: string): Promise<{ total_subscriptions_fcfa: number; subscription_count: number }> {
    const monthDate = monthToDate(month);
    const result = await this.tenantDb.execute<{ total: string | number; count: number }>(sql`
      SELECT
        COALESCE(SUM((sp.amount_fcfa::numeric / NULLIF(ps.duration_months, 0))), 0) AS total,
        COUNT(DISTINCT ps.id)::int AS count
      FROM subscription_payments sp
      INNER JOIN parent_subscriptions ps ON ps.id = sp.subscription_id
      WHERE DATE_TRUNC('month', sp.paid_at)::date = ${monthDate}::date
    `);
    return {
      total_subscriptions_fcfa: Math.round(Number(result.rows[0]?.total ?? 0)),
      subscription_count: result.rows[0]?.count ?? 0,
    };
  }

  async getRevenueSummary(params: { tenantId: string; month: string }): Promise<{
    subscriptions_active_count: number;
    subscriptions_new_this_month: number;
    total_collected_fcfa: number;
    monthly_revenue_prorated_fcfa: number;
    commission_paid_fcfa: number;
  }> {
    const monthDate = firstDayOfMonth(params.month);
    const activeResult = await this.tenantDb.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM parent_subscriptions
      WHERE status = 'active'
        AND ends_at >= CURRENT_DATE
    `);
    const newResult = await this.tenantDb.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM parent_subscriptions
      WHERE DATE_TRUNC('month', created_at)::date = ${monthDate}::date
    `);
    const collectedResult = await this.tenantDb.execute<{ total: string | number }>(sql`
      SELECT COALESCE(SUM(amount_fcfa), 0) AS total
      FROM subscription_payments
      WHERE DATE_TRUNC('month', paid_at)::date = ${monthDate}::date
    `);
    const prorated = await this.computeMonthlyRevenue(params.month);
    const paidResult = await publicDb.execute<{ paid: number }>(sql`
      SELECT COALESCE(commission_paid_fcfa, 0)::int AS paid
      FROM public.edutrack_commission_records
      WHERE tenant_id = ${params.tenantId}::uuid
        AND period_month = ${monthDate}::date
      LIMIT 1
    `);
    return {
      subscriptions_active_count: activeResult.rows[0]?.count ?? 0,
      subscriptions_new_this_month: newResult.rows[0]?.count ?? 0,
      total_collected_fcfa: Math.round(Number(collectedResult.rows[0]?.total ?? 0)),
      monthly_revenue_prorated_fcfa: prorated.total_subscriptions_fcfa,
      commission_paid_fcfa: paidResult.rows[0]?.paid ?? 0,
    };
  }

  async upsertCommissionPayment(params: {
    tenantId: string;
    periodMonth: string;
    amountFcfa: number;
    notes?: string;
    commissionPct: number;
    dueFcfa: number;
  }): Promise<void> {
    const monthDate = firstDayOfMonth(params.periodMonth);
    await publicDb.execute(sql`
      INSERT INTO public.edutrack_commission_records (
        tenant_id,
        period_month,
        total_subscriptions_fcfa,
        commission_pct,
        commission_due_fcfa,
        commission_paid_fcfa,
        last_payment_at,
        notes,
        created_at,
        updated_at
      )
      VALUES (
        ${params.tenantId}::uuid,
        ${monthDate}::date,
        0,
        ${params.commissionPct},
        ${params.dueFcfa},
        ${params.amountFcfa},
        NOW(),
        ${params.notes ?? null},
        NOW(),
        NOW()
      )
      ON CONFLICT (tenant_id, period_month)
      DO UPDATE SET
        commission_paid_fcfa = public.edutrack_commission_records.commission_paid_fcfa + EXCLUDED.commission_paid_fcfa,
        last_payment_at = NOW(),
        notes = COALESCE(EXCLUDED.notes, public.edutrack_commission_records.notes),
        updated_at = NOW()
    `);
  }

  async listRevenueHistory(params: { tenantId: string; months: number }): Promise<
    Array<{
      month: string;
      total_collected_fcfa: number;
      monthly_revenue_prorated_fcfa: number;
      commission_due_fcfa: number;
      commission_paid_fcfa: number;
    }>
  > {
    const items: Array<{
      month: string;
      total_collected_fcfa: number;
      monthly_revenue_prorated_fcfa: number;
      commission_due_fcfa: number;
      commission_paid_fcfa: number;
    }> = [];

    const now = new Date();
    for (let i = 0; i < params.months; i += 1) {
      const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const month = formatMonth(date);
      const summary = await this.getRevenueSummary({ tenantId: params.tenantId, month });
      const feature = await this.getSmsFeatureByTenantId(params.tenantId);
      const commissionPct = Number(feature?.commission_pct ?? 0);
      const due = Math.round((summary.monthly_revenue_prorated_fcfa * commissionPct) / 100);
      items.push({
        month,
        total_collected_fcfa: summary.total_collected_fcfa,
        monthly_revenue_prorated_fcfa: summary.monthly_revenue_prorated_fcfa,
        commission_due_fcfa: due,
        commission_paid_fcfa: summary.commission_paid_fcfa,
      });
    }
    return items;
  }

  async expireOutdatedSubscriptions(): Promise<number> {
    const result = await this.tenantDb.execute<{ count: number }>(sql`
      WITH updated AS (
        UPDATE parent_subscriptions
        SET status = 'expired'
        WHERE status = 'active'
          AND ends_at < CURRENT_DATE
        RETURNING id
      )
      SELECT COUNT(*)::int AS count FROM updated
    `);
    return result.rows[0]?.count ?? 0;
  }

  async listRenewalAlertsInSevenDays(): Promise<Array<{ parentPhone: string; parentName: string; endsAt: string }>> {
    const result = await this.tenantDb.execute<{ parent_phone: string; parent_name: string; ends_at: string }>(sql`
      SELECT p.phone AS parent_phone, p.full_name AS parent_name, ps.ends_at::text AS ends_at
      FROM parent_subscriptions ps
      INNER JOIN parents p ON p.id = ps.parent_id
      WHERE ps.status = 'active'
        AND ps.auto_renew_alert = true
        AND ps.ends_at = CURRENT_DATE + INTERVAL '7 days'
        AND p.phone IS NOT NULL
    `);
    return result.rows.map((row) => ({
      parentPhone: row.parent_phone,
      parentName: row.parent_name,
      endsAt: row.ends_at,
    }));
  }

  async insertSubscriptionExpiryAlertLog(params: {
    parentPhone: string;
    message: string;
  }): Promise<void> {
    await this.tenantDb.execute(sql`
      INSERT INTO notifications_log (type, recipient_phone, message, status)
      VALUES ('subscription_expiry_alert', ${params.parentPhone}, ${params.message}, 'queued')
    `);
  }

  computeStartsAndEnds(durationMonths: number): { startsAt: string; endsAt: string } {
    const startsAt = new Date().toISOString().slice(0, 10);
    const endsAt = addMonths(startsAt, durationMonths);
    return { startsAt, endsAt };
  }

  computeRenewalStartsAndEnds(lastEndsAt: string, durationMonths: number): { startsAt: string; endsAt: string } {
    const startsAt = addDays(lastEndsAt, 1);
    const endsAt = addMonths(startsAt, durationMonths);
    return { startsAt, endsAt };
  }
}
