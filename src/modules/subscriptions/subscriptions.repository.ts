import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { db as publicDb } from '../../shared/database/db.js';
import {
  addDaysIso,
  addMonthsIso,
  monthKeyInBusinessTimezone,
  todayInBusinessTimezone,
} from '../../shared/utils/business-time.js';
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
  created_at: string | null;
  active_total_amount_fcfa: number | null;
  active_duration_months: number | null;
  active_ends_at: string | null;
  month_total_amount_fcfa: number | null;
  month_duration_months: number | null;
  month_ends_at: string | null;
  month_created_at: string | null;
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

type ParentPhoneRow = { id: string };

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
  cancelled_at: string | null;
  cancelled_by_name: string | null;
};

type StudentRow = {
  id: string;
  full_name: string;
  class_name: string | null;
  registration_number: string | null;
};
type ActorRow = { id: string };
type ClassCatalogRow = { id: string; name: string; students_count: number };
type ClassStudentCatalogRow = {
  id: string;
  full_name: string;
  class_id: string;
  class_name: string;
  registration_number: string | null;
};
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

const firstDayOfMonth = (month: string): string => `${month}-01`;
const EDUTRACK_COMMISSION_PCT = 15;

export class SubscriptionsRepository {
  constructor(private readonly tenantDb: TenantDb) {}

  async resolveActorUserId(actorUserId: string): Promise<string | null> {
    const actorResult = await this.tenantDb.execute<ActorRow>(sql`
      SELECT id::text AS id
      FROM users
      WHERE id = ${actorUserId}::uuid
      LIMIT 1
    `);
    const actor = actorResult.rows[0]?.id;
    if (actor) {
      return actor;
    }

    const fallbackResult = await this.tenantDb.execute<ActorRow>(sql`
      SELECT id::text AS id
      FROM users
      WHERE role IN ('director', 'staff')
      ORDER BY created_at ASC
      LIMIT 1
    `);
    return fallbackResult.rows[0]?.id ?? null;
  }

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

  async updateSmsUnitPriceByTenantId(
    tenantId: string,
    smsUnitPriceFcfa: number
  ): Promise<PublicFeatureRow> {
    const result = await publicDb.execute<PublicFeatureRow>(sql`
      INSERT INTO public.school_sms_features (
        tenant_id,
        is_enabled,
        commission_pct,
        sms_cap_per_student,
        sms_unit_price_fcfa,
        updated_at
      )
      VALUES (
        ${tenantId}::uuid,
        false,
        0,
        0,
        ${smsUnitPriceFcfa},
        NOW()
      )
      ON CONFLICT (tenant_id)
      DO UPDATE SET
        sms_unit_price_fcfa = EXCLUDED.sms_unit_price_fcfa,
        updated_at = NOW()
      RETURNING
        tenant_id::text,
        is_enabled,
        sms_cap_per_student,
        commission_pct,
        sms_unit_price_fcfa
    `);

    const row = result.rows[0];
    if (!row) {
      throw new Error('Failed to update sms feature price');
    }
    return row;
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
    month?: string;
  }): Promise<{ rows: ParentListRow[]; total: number }> {
    const offset = (params.page - 1) * params.limit;
    const searchLike = params.search ? `%${params.search}%` : null;
    const statusFilter = params.status ?? null;
    const monthDate = params.month ? `${params.month}-01` : null;
    const countResult = await this.tenantDb.execute<{ total: number }>(sql`
      WITH latest_sub AS (
        SELECT DISTINCT ON (ps.parent_id)
          ps.parent_id,
          ps.status,
          ps.created_at,
          ps.ends_at
        FROM parent_subscriptions ps
        ORDER BY ps.parent_id, ps.created_at DESC
      ),
      month_rollup AS (
        SELECT
          ps.parent_id,
          SUM(ps.total_amount_fcfa)::int AS month_total_amount_fcfa,
          SUM(ps.duration_months)::int AS month_duration_months,
          MAX(ps.ends_at)::text AS month_ends_at,
          MAX(ps.created_at)::text AS month_created_at
        FROM parent_subscriptions ps
        WHERE DATE_TRUNC('month', ps.created_at)::date = ${monthDate}::date
        GROUP BY ps.parent_id
      )
      SELECT COUNT(*)::int AS total
      FROM parents p
      LEFT JOIN latest_sub ls ON ls.parent_id = p.id
      LEFT JOIN month_rollup mr ON mr.parent_id = p.id
      WHERE (${searchLike}::text IS NULL OR p.full_name ILIKE ${searchLike} OR p.phone ILIKE ${searchLike})
        AND (${statusFilter}::text IS NULL OR ls.status::text = ${statusFilter})
        AND (${monthDate}::date IS NULL OR mr.parent_id IS NOT NULL)
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
          ps.duration_months,
          ps.created_at
        FROM parent_subscriptions ps
        ORDER BY ps.parent_id, ps.created_at DESC
      ),
      month_rollup AS (
        SELECT
          ps.parent_id,
          SUM(ps.total_amount_fcfa)::int AS month_total_amount_fcfa,
          SUM(ps.duration_months)::int AS month_duration_months,
          MAX(ps.ends_at)::text AS month_ends_at,
          MAX(ps.created_at)::text AS month_created_at
        FROM parent_subscriptions ps
        WHERE (${monthDate}::date IS NOT NULL AND DATE_TRUNC('month', ps.created_at)::date = ${monthDate}::date)
        GROUP BY ps.parent_id
      ),
      active_rollup AS (
        SELECT
          parent_id,
          SUM(total_amount_fcfa)::int AS active_total_amount_fcfa,
          SUM(duration_months)::int AS active_duration_months,
          MAX(ends_at)::text AS active_ends_at
        FROM parent_subscriptions
        WHERE status = 'active'
        GROUP BY parent_id
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
        ls.created_at::text AS created_at,
        ar.active_total_amount_fcfa,
        ar.active_duration_months,
        ar.active_ends_at,
        mr.month_total_amount_fcfa,
        mr.month_duration_months,
        mr.month_ends_at,
        mr.month_created_at,
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
      LEFT JOIN active_rollup ar ON ar.parent_id = p.id
      LEFT JOIN month_rollup mr ON mr.parent_id = p.id
      WHERE (${searchLike}::text IS NULL OR p.full_name ILIKE ${searchLike} OR p.phone ILIKE ${searchLike})
        AND (${statusFilter}::text IS NULL OR ls.status::text = ${statusFilter})
        AND (${monthDate}::date IS NULL OR mr.parent_id IS NOT NULL)
      ORDER BY p.created_at DESC
      LIMIT ${params.limit}
      OFFSET ${offset}
    `);
    return { rows: result.rows, total };
  }

  async listSubscriptionClasses(params: {
    search?: string;
  }): Promise<Array<{ id: string; name: string; students_count: number }>> {
    const searchLike = params.search ? `%${params.search}%` : null;
    const result = await this.tenantDb.execute<ClassCatalogRow>(sql`
      SELECT
        c.id::text AS id,
        c.name,
        COUNT(s.id)::int AS students_count
      FROM classes c
      LEFT JOIN students s ON s.class_id = c.id AND s.is_active = true
      WHERE (${searchLike}::text IS NULL OR c.name ILIKE ${searchLike})
      GROUP BY c.id, c.name
      ORDER BY c.name ASC
    `);

    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      students_count: row.students_count ?? 0,
    }));
  }

  async listSubscriptionStudentsByClass(params: {
    classId: string;
    page: number;
    limit: number;
    search?: string;
  }): Promise<{
    data: Array<{
      id: string;
      full_name: string;
      class_id: string;
      class_name: string;
      registration_number: string | null;
    }>;
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const offset = (params.page - 1) * params.limit;
    const searchLike = params.search ? `%${params.search}%` : null;

    const countResult = await this.tenantDb.execute<{ total: number }>(sql`
      SELECT COUNT(*)::int AS total
      FROM students s
      WHERE s.class_id = ${params.classId}::uuid
        AND s.is_active = true
        AND (
          ${searchLike}::text IS NULL
          OR CONCAT(s.last_name, ' ', s.first_name) ILIKE ${searchLike}
          OR CONCAT(s.first_name, ' ', s.last_name) ILIKE ${searchLike}
          OR COALESCE(s.matricule, '') ILIKE ${searchLike}
        )
    `);
    const total = countResult.rows[0]?.total ?? 0;

    const result = await this.tenantDb.execute<ClassStudentCatalogRow>(sql`
      SELECT
        s.id::text AS id,
        CONCAT(s.last_name, ' ', s.first_name) AS full_name,
        c.id::text AS class_id,
        c.name AS class_name,
        s.matricule::text AS registration_number
      FROM students s
      INNER JOIN classes c ON c.id = s.class_id
      WHERE s.class_id = ${params.classId}::uuid
        AND s.is_active = true
        AND (
          ${searchLike}::text IS NULL
          OR CONCAT(s.last_name, ' ', s.first_name) ILIKE ${searchLike}
          OR CONCAT(s.first_name, ' ', s.last_name) ILIKE ${searchLike}
          OR COALESCE(s.matricule, '') ILIKE ${searchLike}
        )
      ORDER BY s.last_name ASC, s.first_name ASC
      LIMIT ${params.limit}
      OFFSET ${offset}
    `);

    return {
      data: result.rows.map((row) => ({
        id: row.id,
        full_name: row.full_name,
        class_id: row.class_id,
        class_name: row.class_name,
        registration_number: row.registration_number,
      })),
      pagination: {
        page: params.page,
        limit: params.limit,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / params.limit),
      },
    };
  }

  async createParent(params: {
    fullName: string;
    phone: string;
    email?: string;
    passwordHash: string;
  }): Promise<string> {
    const result = await this.tenantDb.execute<{ id: string }>(sql`
      INSERT INTO parents (full_name, phone, email, password_hash, must_change_password, is_active)
      VALUES (${params.fullName}, ${params.phone}, ${params.email ?? null}, ${params.passwordHash}, true, true)
      RETURNING id::text
    `);
    return result.rows[0]!.id;
  }

  async findParentByPhone(phone: string): Promise<ParentPhoneRow | null> {
    const result = await this.tenantDb.execute<ParentPhoneRow>(sql`
      SELECT id::text AS id
      FROM parents
      WHERE phone = ${phone}
      LIMIT 1
    `);
    return result.rows[0] ?? null;
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
        ON CONFLICT (parent_id, student_id)
        DO UPDATE SET
          subscription_id = EXCLUDED.subscription_id
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
    try {
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
          created_at::text,
          cancelled_at::text,
          (
            SELECT u.name
            FROM users u
            WHERE u.id = parent_subscriptions.cancelled_by
            LIMIT 1
          ) AS cancelled_by_name
        FROM parent_subscriptions
        WHERE parent_id = ${parentId}::uuid
        ORDER BY created_at DESC
      `);
      return result.rows;
    } catch {
      const fallback = await this.tenantDb.execute<SubscriptionRow>(sql`
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
          created_at::text,
          NULL::text AS cancelled_at,
          NULL::text AS cancelled_by_name
        FROM parent_subscriptions
        WHERE parent_id = ${parentId}::uuid
        ORDER BY created_at DESC
      `);
      return fallback.rows;
    }
  }

  async getSubscriptionStudents(subscriptionId: string): Promise<StudentRow[]> {
    const result = await this.tenantDb.execute<StudentRow>(sql`
      SELECT
        s.id::text AS id,
        CONCAT(s.first_name, ' ', s.last_name) AS full_name,
        c.name AS class_name,
        s.matricule::text AS registration_number
      FROM parent_student_links psl
      INNER JOIN students s ON s.id = psl.student_id
      LEFT JOIN classes c ON c.id = s.class_id
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

  async updateSubscriptionStatus(
    subscriptionId: string,
    status: SubscriptionStatus,
    actorUserId?: string
  ): Promise<void> {
    try {
      await this.tenantDb.execute(sql`
        UPDATE parent_subscriptions
        SET status = ${status}
        ${status === 'cancelled'
          ? sql`, cancelled_at = NOW(), cancelled_by = ${actorUserId ?? null}::uuid`
          : sql``}
        WHERE id = ${subscriptionId}::uuid
      `);
    } catch {
      await this.tenantDb.execute(sql`
        UPDATE parent_subscriptions
        SET status = ${status}
        WHERE id = ${subscriptionId}::uuid
      `);
    }
  }

  async updateParentPassword(parentId: string, passwordHash: string): Promise<void> {
    try {
      await this.tenantDb.execute(sql`
        UPDATE parents
        SET password_hash = ${passwordHash},
            must_change_password = true
        WHERE id = ${parentId}::uuid
      `);
    } catch {
      await this.tenantDb.execute(sql`
        UPDATE parents
        SET password_hash = ${passwordHash}
        WHERE id = ${parentId}::uuid
      `);
    }
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
        AND ps.status <> 'cancelled'
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
    const businessToday = todayInBusinessTimezone();
    const activeResult = await this.tenantDb.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM parent_subscriptions
      WHERE status = 'active'
        AND ends_at >= ${businessToday}::date
    `);
    const newResult = await this.tenantDb.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM parent_subscriptions
      WHERE DATE_TRUNC('month', created_at)::date = ${monthDate}::date
    `);
    const collectedResult = await this.tenantDb.execute<{ total: string | number }>(sql`
      SELECT COALESCE(SUM(sp.amount_fcfa), 0) AS total
      FROM subscription_payments sp
      INNER JOIN parent_subscriptions ps ON ps.id = sp.subscription_id
      WHERE DATE_TRUNC('month', sp.paid_at)::date = ${monthDate}::date
        AND ps.status <> 'cancelled'
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

  async findFinancialAuditReplay<T>(params: {
    tenantId: string;
    action: string;
    idempotencyKey: string;
  }): Promise<T | null> {
    const result = await publicDb.execute<{ payload_after: unknown }>(sql`
      SELECT payload_after
      FROM public.audit_financial_events
      WHERE tenant_id = ${params.tenantId}::uuid
        AND action = ${params.action}
        AND idempotency_key = ${params.idempotencyKey}::uuid
      LIMIT 1
    `);
    const payload = result.rows[0]?.payload_after;
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    return payload as T;
  }

  async runCommissionPaymentWithAudit(params: {
    tenantId: string;
    periodMonth: string;
    amountFcfa: number;
    paymentMethod?: 'cash' | 'momo_mtn' | 'momo_orange' | 'bank_transfer';
    notes?: string;
    commissionPct: number;
    dueFcfa: number;
    action: string;
    idempotencyKey: string;
    actorId: string;
    actorRole: string;
  }): Promise<{ replayed: boolean }> {
    const monthDate = firstDayOfMonth(params.periodMonth);
    return publicDb.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(hashtext(${`${params.action}:${params.tenantId}:${params.idempotencyKey}`}))
      `);

      const replay = await tx.execute<{ payload_after: unknown }>(sql`
        SELECT payload_after
        FROM public.audit_financial_events
        WHERE tenant_id = ${params.tenantId}::uuid
          AND action = ${params.action}
          AND idempotency_key = ${params.idempotencyKey}::uuid
        LIMIT 1
      `);
      const replayPayload = replay.rows[0]?.payload_after;
      if (replayPayload && typeof replayPayload === 'object') {
        return { replayed: true };
      }

      const before = await tx.execute<{
        period_month: string;
        commission_due_fcfa: number;
        commission_paid_fcfa: number;
      }>(sql`
        SELECT period_month::text, commission_due_fcfa, commission_paid_fcfa
        FROM public.edutrack_commission_records
        WHERE tenant_id = ${params.tenantId}::uuid
          AND period_month = ${monthDate}::date
        LIMIT 1
      `);
      const beforeRow = before.rows[0] ?? null;

      await tx.execute(sql`
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

      const after = await tx.execute<{
        period_month: string;
        commission_due_fcfa: number;
        commission_paid_fcfa: number;
      }>(sql`
        SELECT period_month::text, commission_due_fcfa, commission_paid_fcfa
        FROM public.edutrack_commission_records
        WHERE tenant_id = ${params.tenantId}::uuid
          AND period_month = ${monthDate}::date
        LIMIT 1
      `);
      const afterRow = after.rows[0]!;

      const paidBefore = beforeRow?.commission_paid_fcfa ?? 0;
      await tx.execute(sql`
        INSERT INTO public.audit_financial_events (
          tenant_id,
          actor_id,
          actor_role,
          action,
          idempotency_key,
          payload_before,
          payload_after
        )
        VALUES (
          ${params.tenantId}::uuid,
          ${params.actorId}::uuid,
          ${params.actorRole},
          ${params.action},
          ${params.idempotencyKey}::uuid,
          ${beforeRow ? JSON.stringify(beforeRow) : null}::jsonb,
          ${JSON.stringify({
            success: true,
            period_month: params.periodMonth,
            amount_fcfa: params.amountFcfa,
            payment_method: params.paymentMethod ?? null,
            notes: params.notes ?? null,
            commission_paid_before_fcfa: paidBefore,
            commission_paid_after_fcfa: afterRow.commission_paid_fcfa,
          })}::jsonb
        )
      `);

      void afterRow;
      return { replayed: false };
    });
  }

  async listCommissionPaymentsForMonth(params: {
    tenantId: string;
    month: string;
  }): Promise<Array<{ id: string; period_month: string; amount_fcfa: number; notes: string | null; created_at: string; payment_method: string | null }>> {
    const result = await publicDb.execute<{
      id: string;
      action: string;
      period_month: string;
      amount_fcfa: number;
      notes: string | null;
      created_at: string;
      payment_method: string | null;
      payload_before: unknown;
      payload_after: unknown;
    }>(sql`
      SELECT
        id::text AS id,
        action,
        payload_after->>'period_month' AS period_month,
        COALESCE((payload_after->>'amount_fcfa')::int, 0) AS amount_fcfa,
        payload_after->>'notes' AS notes,
        payload_after->>'payment_method' AS payment_method,
        created_at::text AS created_at,
        payload_before,
        payload_after
      FROM public.audit_financial_events
      WHERE tenant_id = ${params.tenantId}::uuid
        AND action IN ('subscriptions.record_commission_payment', 'admin.record_commission_received')
        AND LEFT(COALESCE(payload_after->>'period_month', ''), 7) = ${params.month}
      ORDER BY created_at DESC
    `);
    if (result.rows.length > 0) {
      const mapped = result.rows.map((row) => {
        if (row.amount_fcfa > 0) {
          return {
            id: row.id,
            period_month: row.period_month,
            amount_fcfa: row.amount_fcfa,
            notes: row.notes,
            created_at: row.created_at,
            payment_method: row.payment_method,
          };
        }

        const before =
          typeof row.payload_before === 'object' && row.payload_before !== null
            ? (row.payload_before as { commission_paid_fcfa?: number })
            : null;
        const after =
          typeof row.payload_after === 'object' && row.payload_after !== null
            ? (row.payload_after as { commission_paid_fcfa?: number })
            : null;
        const fallbackAmount = Math.max(
          0,
          Number(after?.commission_paid_fcfa ?? 0) - Number(before?.commission_paid_fcfa ?? 0)
        );

        return {
          id: row.id,
          period_month: row.period_month,
          amount_fcfa: fallbackAmount,
          notes: row.notes,
          created_at: row.created_at,
          payment_method: row.payment_method,
        };
      });

      // Reconcile legacy carried balance: if the first event of the month already had paid amount,
      // expose it as an opening line so monthly reversement total matches commission_paid_fcfa.
      const ascByCreatedAt = [...result.rows].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
      const firstRow = ascByCreatedAt[0];
      const firstBefore =
        typeof firstRow?.payload_before === 'object' && firstRow.payload_before !== null
          ? Number((firstRow.payload_before as { commission_paid_fcfa?: number }).commission_paid_fcfa ?? 0)
          : 0;
      if (firstBefore > 0) {
        const openingLine = {
          id: `opening-${params.tenantId}-${params.month}`,
          period_month: params.month,
          amount_fcfa: firstBefore,
          notes: 'Solde reporté (reversements antérieurs)',
          created_at: firstRow?.created_at ?? `${params.month}-01T00:00:00.000Z`,
          payment_method: null as string | null,
        };
        return [...mapped, openingLine];
      }

      return mapped;
    }

    const monthDate = `${params.month}-01`;
    const fallback = await publicDb.execute<{
      period_month: string;
      amount_fcfa: number;
      created_at: string;
    }>(sql`
      SELECT
        period_month::text AS period_month,
        commission_paid_fcfa::int AS amount_fcfa,
        COALESCE(last_payment_at, updated_at)::text AS created_at
      FROM public.edutrack_commission_records
      WHERE tenant_id = ${params.tenantId}::uuid
        AND period_month = ${monthDate}::date
        AND commission_paid_fcfa > 0
      LIMIT 1
    `);

    if (!fallback.rows[0]) {
      return [];
    }

    return [
      {
        id: `fallback-${params.tenantId}-${params.month}`,
        period_month: fallback.rows[0].period_month.slice(0, 7),
        amount_fcfa: fallback.rows[0].amount_fcfa,
        notes: 'Historique importé (reversement cumulé)',
        created_at: fallback.rows[0].created_at,
        payment_method: null,
      },
    ];
  }

  async listRevenueHistory(params: { tenantId: string; months: number }): Promise<
    Array<{
      month: string;
      subscriptions_active_count: number;
      subscriptions_new_this_month: number;
      total_collected_fcfa: number;
      monthly_revenue_prorated_fcfa: number;
      commission_due_fcfa: number;
      commission_paid_fcfa: number;
      commission_remaining_fcfa: number;
      payment_status: 'paid' | 'partial' | 'pending';
    }>
  > {
    const items: Array<{
      month: string;
      subscriptions_active_count: number;
      subscriptions_new_this_month: number;
      total_collected_fcfa: number;
      monthly_revenue_prorated_fcfa: number;
      commission_due_fcfa: number;
      commission_paid_fcfa: number;
      commission_remaining_fcfa: number;
      payment_status: 'paid' | 'partial' | 'pending';
    }> = [];

    const now = new Date();
    for (let i = 0; i < params.months; i += 1) {
      const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const month = monthKeyInBusinessTimezone(date);
      const summary = await this.getRevenueSummary({ tenantId: params.tenantId, month });
      const due = Math.round((summary.total_collected_fcfa * EDUTRACK_COMMISSION_PCT) / 100);
      const remaining = Math.max(0, due - summary.commission_paid_fcfa);
      items.push({
        month,
        subscriptions_active_count: summary.subscriptions_active_count,
        subscriptions_new_this_month: summary.subscriptions_new_this_month,
        total_collected_fcfa: summary.total_collected_fcfa,
        monthly_revenue_prorated_fcfa: summary.monthly_revenue_prorated_fcfa,
        commission_due_fcfa: due,
        commission_paid_fcfa: summary.commission_paid_fcfa,
        commission_remaining_fcfa: remaining,
        payment_status: remaining === 0 ? 'paid' : summary.commission_paid_fcfa > 0 ? 'partial' : 'pending',
      });
    }
    return items;
  }

  async expireOutdatedSubscriptions(): Promise<number> {
    const businessToday = todayInBusinessTimezone();
    const result = await this.tenantDb.execute<{ count: number }>(sql`
      WITH updated AS (
        UPDATE parent_subscriptions
        SET status = 'expired'
        WHERE status = 'active'
          AND ends_at < ${businessToday}::date
        RETURNING id
      )
      SELECT COUNT(*)::int AS count FROM updated
    `);
    return result.rows[0]?.count ?? 0;
  }

  async listRenewalAlertsInSevenDays(): Promise<Array<{ parentPhone: string; parentName: string; endsAt: string }>> {
    const targetDate = addDaysIso(todayInBusinessTimezone(), 7);
    const result = await this.tenantDb.execute<{ parent_phone: string; parent_name: string; ends_at: string }>(sql`
      SELECT p.phone AS parent_phone, p.full_name AS parent_name, ps.ends_at::text AS ends_at
      FROM parent_subscriptions ps
      INNER JOIN parents p ON p.id = ps.parent_id
      WHERE ps.status = 'active'
        AND ps.auto_renew_alert = true
        AND ps.ends_at = ${targetDate}::date
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
    const startsAt = todayInBusinessTimezone();
    const endsAt = addMonthsIso(startsAt, durationMonths);
    return { startsAt, endsAt };
  }

  computeRenewalStartsAndEnds(lastEndsAt: string, durationMonths: number): { startsAt: string; endsAt: string } {
    const startsAt = addDaysIso(lastEndsAt, 1);
    const endsAt = addMonthsIso(startsAt, durationMonths);
    return { startsAt, endsAt };
  }
}
