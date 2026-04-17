import { randomBytes } from 'node:crypto';

import argon2 from 'argon2';
import { SignJWT, importPKCS8 } from 'jose';
import { sql } from 'drizzle-orm';

import {
  type AdminMetricsResult,
  type CreateSchoolBody,
  type CreateTenantBody,
  type ListTenantsQuery,
  type ListSchoolsQuery,
  type RevenueMetricsResult,
  type RevenueSummaryResult,
  type SchoolDetailsResult,
  type SchoolListItem,
  type SchoolListResult,
  type SmsDashboardResult,
  type SmsTemplateItem,
  type SmsTemplateType,
  type TeachingType,
  type TenantListItem,
  type TenantListResult,
  type TenantStatsResult,
  type UpdateSmsTemplateBody,
  type UpdateSchoolConfigBody,
  type UpdateTenantBody,
} from './admin.types.js';
import { withTenantSchema, type TenantDb } from '../../shared/database/db.js';
import { createTenantSchema } from '../../shared/database/tenant-init.js';

type TenantRow = {
  id: string;
  name: string;
  subdomain: string;
  schema_name: string;
  plan: TenantListItem['plan'];
  status: TenantListItem['status'];
  estimated_mrr_fcfa: number;
};

type TenantMetricsRow = {
  active_users_48h: number;
  active_teachers: number;
  attendance_rate_7d: number;
  last_attendance_at: Date | null;
};

type TenantStatsHeadRow = {
  dau: number;
  wau: number;
  mau: number;
  sms_sent_30d: number;
};

type AttendanceDailyRow = {
  date: string;
  attendance_rate: number;
  total: number;
};

type TopTeacherRow = {
  teacher_id: string;
  teacher_name: string;
  absence_count: number;
};

type TenantLookupRow = {
  id: string;
  schema_name: string;
};

type SchoolLookupRow = {
  id: string;
  name: string;
  subdomain: string;
  schema_name: string;
  plan: TenantListItem['plan'];
  status: TenantListItem['status'];
  city: string | null;
  teaching_type: TeachingType | null;
  max_admin_positions: number;
  max_users: number;
  max_sms_per_month: number;
  student_label: string | null;
  director_title: string | null;
  can_edit_sms_template: boolean;
  can_export_data: boolean;
  created_at: Date;
  updated_at: Date;
};

type SchoolPlanRow = {
  plan: TenantListItem['plan'];
  count: number;
};

type SchoolRevenueRow = {
  month: string;
  mrr_fcfa: number;
  payments_count: number;
};

type RevenueSummaryRow = {
  month: string;
  mrr_fcfa: number;
  new_fcfa: number;
  churn_fcfa: number;
};

type RevenueSchoolRow = {
  tenant_id: string;
  school: string;
  plan: TenantListItem['plan'];
  status: TenantListItem['status'];
  amount_per_month: number;
  last_due_date: string | null;
  payment_mode: string | null;
};

type SmsTemplateRow = {
  id: string;
  tenant_id: string | null;
  type: SmsTemplateType;
  message_template: string;
  variables: string[] | null;
  updated_at: Date | string;
};

type SmsStatsBySchoolRow = {
  tenant_id: string;
  school: string;
  sent: number;
  quota: number;
  used_pct: number;
};

type SmsHistoryRow = {
  id: string;
  date: string;
  school: string;
  type: string;
  recipient_phone: string;
  status: string;
  message: string;
};

type DirectorInsertRow = { id: string };

type SubscriptionInsertRow = { id: string };
type TenantUpdateRow = { id: string };

type CreateTenantResult = {
  tenant: {
    id: string;
    name: string;
    subdomain: string;
    schemaName: string;
    plan: TenantListItem['plan'];
    status: TenantListItem['status'];
  };
  director: {
    userId: string;
    name: string;
    phone: string;
    email: string | null;
    temporaryPassword: string;
  };
  subscription: {
    id: string;
    status: 'active';
    currentPeriodStart: string;
    currentPeriodEnd: string;
  };
};

type ImpersonationResult = {
  token: string;
  tokenType: 'Bearer';
  expiresIn: '1h';
  tenantId: string;
  schemaName: string;
  readOnly: true;
};

const DEFAULT_TRIAL_DAYS = 14;
const SCHEMA_NAME_REGEX = /^[a-z][a-z0-9_]{2,63}$/;
const TENANT_METRICS_CONCURRENCY = 10;
const MAX_USERS_BY_PLAN: Record<TenantListItem['plan'], number> = {
  essential: 5,
  pro: 20,
  establishment: 50,
};

const normalizePem = (value: string): string => value.replace(/\\n/g, '\n');

const getRows = <T>(result: unknown): T[] => {
  if (typeof result !== 'object' || result === null || !('rows' in result)) {
    return [];
  }

  const rows = (result as { rows: T[] }).rows;
  return Array.isArray(rows) ? rows : [];
};

const quoteIdentifier = (identifier: string): string => {
  if (!SCHEMA_NAME_REGEX.test(identifier)) {
    throw new Error('Invalid schema name');
  }

  return `"${identifier}"`;
};

const toSchemaName = (subdomain: string): string => {
  const normalized = subdomain.replace(/-/g, '_').toLowerCase();
  const schemaName = `school_${normalized}`;

  if (!SCHEMA_NAME_REGEX.test(schemaName)) {
    throw new Error('Invalid generated schema name');
  }

  return schemaName;
};

const getPrivateKey = async () => {
  const privateKey = process.env.JWT_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('[admin] JWT_PRIVATE_KEY environment variable is required');
  }

  return importPKCS8(normalizePem(privateKey), 'RS256');
};

const generateTemporaryPassword = (): string => {
  const random = randomBytes(9).toString('base64url');
  return `Tmp-${random}A1!`;
};

const generateDirectorInitialPassword = (): string => randomBytes(8).toString('hex');

const parseNumeric = (value: unknown): number => {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
};

const ensureAdminPublicInfrastructure = async (publicDb: TenantDb): Promise<void> => {
  await publicDb.execute(sql.raw(`
    ALTER TABLE public.tenants
      ADD COLUMN IF NOT EXISTS student_label varchar(120) DEFAULT 'Élève',
      ADD COLUMN IF NOT EXISTS director_title varchar(120) DEFAULT 'Directeur',
      ADD COLUMN IF NOT EXISTS max_sms_per_month integer DEFAULT 2000,
      ADD COLUMN IF NOT EXISTS can_edit_sms_template boolean DEFAULT false,
      ADD COLUMN IF NOT EXISTS can_export_data boolean DEFAULT true;
  `));

  await publicDb.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS public.sms_templates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE,
      type varchar(50) NOT NULL,
      message_template text NOT NULL,
      variables text[] NOT NULL DEFAULT '{}',
      created_by uuid,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(tenant_id, type)
    );
  `));

  await publicDb.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS public.app_settings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      maintenance_mode boolean NOT NULL DEFAULT false,
      maintenance_message text NOT NULL DEFAULT 'Mise à jour en cours',
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `));

  await publicDb.execute(sql.raw(`
    INSERT INTO public.app_settings (maintenance_mode, maintenance_message)
    SELECT false, 'Mise à jour en cours'
    WHERE NOT EXISTS (SELECT 1 FROM public.app_settings);
  `));
};

const maskPhone = (phone: string): string => {
  if (phone.length <= 5) {
    return phone;
  }
  return `${phone.slice(0, 3)}XXXX${phone.slice(-3)}`;
};

const formatDateTime = (value: Date | string | null): string | null => {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const mapWithConcurrency = async <TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  worker: (item: TInput) => Promise<TOutput>
): Promise<TOutput[]> => {
  if (items.length === 0) {
    return [];
  }

  const boundedConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const results: TOutput[] = new Array(items.length);
  let index = 0;

  const runWorker = async (): Promise<void> => {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await worker(items[currentIndex]);
    }
  };

  await Promise.all(
    Array.from({ length: boundedConcurrency }, () => runWorker())
  );

  return results;
};

const getTenantOverviewMetrics = async (
  publicDb: TenantDb,
  schemaName: string
): Promise<TenantMetricsRow> => {
  const schema = quoteIdentifier(schemaName);

  const metricsResult = await publicDb.execute<TenantMetricsRow>(sql.raw(`
    SELECT
      (SELECT COUNT(*)::int
       FROM ${schema}.users u
       WHERE u.is_active = true
         AND u.last_login_at >= NOW() - INTERVAL '48 hours') AS active_users_48h,
      (SELECT COUNT(*)::int
       FROM ${schema}.teachers t
       JOIN ${schema}.users u ON u.id = t.user_id
       WHERE u.is_active = true) AS active_teachers,
      (SELECT COALESCE(
         ROUND(
           100.0 * SUM(CASE WHEN a.status IN ('present', 'late', 'excused') THEN 1 ELSE 0 END)::numeric
           / NULLIF(COUNT(*), 0),
           2
         ),
         0
       )
       FROM ${schema}.attendances_teacher a
       WHERE a.date >= CURRENT_DATE - INTERVAL '6 days') AS attendance_rate_7d,
      (SELECT MAX(COALESCE(a.checked_in_at, a.created_at))
       FROM ${schema}.attendances_teacher a) AS last_attendance_at
  `));

  const [metrics] = getRows<TenantMetricsRow>(metricsResult);

  return {
    active_users_48h: parseNumeric(metrics?.active_users_48h),
    active_teachers: parseNumeric(metrics?.active_teachers),
    attendance_rate_7d: parseNumeric(metrics?.attendance_rate_7d),
    last_attendance_at: metrics?.last_attendance_at ? new Date(metrics.last_attendance_at) : null,
  };
};

export const listTenants = async (
  publicDb: TenantDb,
  query: ListTenantsQuery
): Promise<TenantListResult> => {
  const tenantsResult = await publicDb.execute<TenantRow>(sql`
    SELECT
      t.id,
      t.name,
      t.subdomain,
      t.schema_name,
      t.plan,
      t.status,
      COALESCE(s.estimated_mrr_fcfa, 0) AS estimated_mrr_fcfa
    FROM public.tenants t
    LEFT JOIN (
      SELECT tenant_id, SUM(mrr_fcfa)::int AS estimated_mrr_fcfa
      FROM public.subscriptions
      WHERE status IN ('active', 'past_due')
      GROUP BY tenant_id
    ) s ON s.tenant_id = t.id
    ORDER BY t.created_at DESC
  `);

  const tenantRows = getRows<TenantRow>(tenantsResult);

  const tenantsWithMetrics = await mapWithConcurrency(
    tenantRows,
    TENANT_METRICS_CONCURRENCY,
    async (tenant) => {
      const metrics = await getTenantOverviewMetrics(publicDb, tenant.schema_name);
      const lastAttendanceAt = formatDateTime(metrics.last_attendance_at);

      return {
        id: tenant.id,
        name: tenant.name,
        subdomain: tenant.subdomain,
        schemaName: tenant.schema_name,
        plan: tenant.plan,
        status: tenant.status,
        activeUsers48h: metrics.active_users_48h,
        activeTeachers: metrics.active_teachers,
        attendanceRate7d: Number(metrics.attendance_rate_7d.toFixed(2)),
        lastAttendanceAt,
        estimatedMrrFcfa: parseNumeric(tenant.estimated_mrr_fcfa),
        churnRisk:
          !metrics.last_attendance_at ||
          metrics.last_attendance_at.getTime() < Date.now() - 7 * 24 * 60 * 60 * 1000,
      } satisfies TenantListItem;
    }
  );

  const summary = {
    activeTenants: tenantsWithMetrics.filter((tenant) => tenant.status === 'active').length,
    trialTenants: tenantsWithMetrics.filter((tenant) => tenant.status === 'trial').length,
    totalMrrFcfa: tenantsWithMetrics.reduce((sum, tenant) => sum + tenant.estimatedMrrFcfa, 0),
    churnRiskTenants: tenantsWithMetrics.filter((tenant) => tenant.churnRisk).length,
  };

  const filteredTenants = tenantsWithMetrics.filter((tenant) => {
    if (query.plan && tenant.plan !== query.plan) {
      return false;
    }

    if (query.status && tenant.status !== query.status) {
      return false;
    }

    if (typeof query.churnRisk === 'boolean' && tenant.churnRisk !== query.churnRisk) {
      return false;
    }

    return true;
  });

  const page = query.page;
  const limit = query.limit;
  const offset = (page - 1) * limit;
  const total = filteredTenants.length;
  const tenants = filteredTenants.slice(offset, offset + limit);

  return {
    tenants,
    summary,
    pagination: {
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    },
  };
};

export const createTenant = async (
  publicDb: TenantDb,
  payload: CreateTenantBody
): Promise<CreateTenantResult> => {
  const schemaName = toSchemaName(payload.subdomain);
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await argon2.hash(temporaryPassword);

  await createTenantSchema(schemaName);

  const now = new Date();
  const trialEndsAt = new Date(now);
  trialEndsAt.setUTCDate(trialEndsAt.getUTCDate() + DEFAULT_TRIAL_DAYS);

  const tenantResult = await publicDb.execute<TenantLookupRow>(sql`
    INSERT INTO public.tenants (
      name,
      subdomain,
      schema_name,
      plan,
      status,
      max_users,
      trial_ends_at
    )
    VALUES (
      ${payload.name},
      ${payload.subdomain},
      ${schemaName},
      ${payload.plan},
      'trial',
      ${MAX_USERS_BY_PLAN[payload.plan]},
      ${trialEndsAt}
    )
    RETURNING id, schema_name
  `);

  const tenant = getRows<TenantLookupRow>(tenantResult)[0];
  if (!tenant) {
    throw new Error('Unable to create tenant');
  }

  let directorResult: DirectorInsertRow;
  let subscription: SubscriptionInsertRow;

  try {
    directorResult = await withTenantSchema(schemaName, async (tenantDb) => {
      const directorInsert = await tenantDb.execute<DirectorInsertRow>(sql`
        INSERT INTO users (role, name, phone, email, password_hash, is_active)
        VALUES (
          'director',
          ${payload.directorName},
          ${payload.directorPhone},
          ${payload.directorEmail ?? null},
          ${passwordHash},
          true
        )
        RETURNING id
      `);

      const director = getRows<DirectorInsertRow>(directorInsert)[0];
      if (!director) {
        throw new Error('Unable to create tenant director');
      }

      return director;
    });

    const subscriptionResult = await publicDb.execute<SubscriptionInsertRow>(sql`
      INSERT INTO public.subscriptions (
        tenant_id,
        status,
        mrr_fcfa,
        billing_cycle,
        current_period_start,
        current_period_end
      )
      VALUES (
        ${tenant.id},
        'active',
        0,
        'monthly',
        ${now},
        ${trialEndsAt}
      )
      RETURNING id
    `);

    const insertedSubscription = getRows<SubscriptionInsertRow>(subscriptionResult)[0];
    if (!insertedSubscription) {
      throw new Error('Unable to create tenant subscription');
    }
    subscription = insertedSubscription;
  } catch (error) {
    await publicDb.execute(sql`
      DELETE FROM public.tenants
      WHERE id = ${tenant.id}
    `);
    throw error;
  }

  return {
    tenant: {
      id: tenant.id,
      name: payload.name,
      subdomain: payload.subdomain,
      schemaName,
      plan: payload.plan,
      status: 'trial',
    },
    director: {
      userId: directorResult.id,
      name: payload.directorName,
      phone: payload.directorPhone,
      email: payload.directorEmail ?? null,
      temporaryPassword,
    },
    subscription: {
      id: subscription.id,
      status: 'active',
      currentPeriodStart: now.toISOString(),
      currentPeriodEnd: trialEndsAt.toISOString(),
    },
  };
};

export const updateTenant = async (
  publicDb: TenantDb,
  tenantId: string,
  payload: UpdateTenantBody
): Promise<void> => {
  const plan = payload.plan;
  const status = payload.status;

  if (plan && status) {
    const result = await publicDb.execute<TenantUpdateRow>(sql`
      UPDATE public.tenants
      SET
        plan = ${plan},
        status = ${status},
        updated_at = NOW()
      WHERE id = ${tenantId}
      RETURNING id
    `);
    if (!getRows<TenantUpdateRow>(result)[0]) {
      throw new Error('Tenant not found');
    }
    return;
  }

  if (plan) {
    const result = await publicDb.execute<TenantUpdateRow>(sql`
      UPDATE public.tenants
      SET
        plan = ${plan},
        updated_at = NOW()
      WHERE id = ${tenantId}
      RETURNING id
    `);
    if (!getRows<TenantUpdateRow>(result)[0]) {
      throw new Error('Tenant not found');
    }
    return;
  }

  if (status) {
    const result = await publicDb.execute<TenantUpdateRow>(sql`
      UPDATE public.tenants
      SET
        status = ${status},
        updated_at = NOW()
      WHERE id = ${tenantId}
      RETURNING id
    `);
    if (!getRows<TenantUpdateRow>(result)[0]) {
      throw new Error('Tenant not found');
    }
  }
};

const getTenantById = async (publicDb: TenantDb, tenantId: string): Promise<TenantLookupRow> => {
  const result = await publicDb.execute<TenantLookupRow>(sql`
    SELECT id, schema_name
    FROM public.tenants
    WHERE id = ${tenantId}
    LIMIT 1
  `);

  const tenant = getRows<TenantLookupRow>(result)[0];
  if (!tenant) {
    throw new Error('Tenant not found');
  }

  return tenant;
};

export const getTenantStats = async (
  publicDb: TenantDb,
  tenantId: string
): Promise<TenantStatsResult> => {
  const tenant = await getTenantById(publicDb, tenantId);

  const statsHead = await withTenantSchema(tenant.schema_name, async (tenantDb) => {
    const result = await tenantDb.execute<TenantStatsHeadRow>(sql`
      SELECT
        COUNT(*) FILTER (WHERE u.is_active = true AND u.last_login_at >= NOW() - INTERVAL '24 hours')::int AS dau,
        COUNT(*) FILTER (WHERE u.is_active = true AND u.last_login_at >= NOW() - INTERVAL '7 days')::int AS wau,
        COUNT(*) FILTER (WHERE u.is_active = true AND u.last_login_at >= NOW() - INTERVAL '30 days')::int AS mau,
        (
          SELECT COUNT(*)::int
          FROM notifications_log n
          WHERE n.status IN ('sent', 'delivered')
            AND n.created_at >= NOW() - INTERVAL '30 days'
        ) AS sms_sent_30d
      FROM users u
    `);

    return getRows<TenantStatsHeadRow>(result)[0];
  });

  const attendanceRateByDay = await withTenantSchema(tenant.schema_name, async (tenantDb) => {
    const result = await tenantDb.execute<AttendanceDailyRow>(sql`
      WITH daily AS (
        SELECT
          a.date,
          COUNT(*)::int AS total,
          SUM(CASE WHEN a.status IN ('present', 'late', 'excused') THEN 1 ELSE 0 END)::int AS present_like
        FROM attendances_teacher a
        WHERE a.date >= CURRENT_DATE - INTERVAL '29 days'
        GROUP BY a.date
      )
      SELECT
        to_char(d.date::date, 'YYYY-MM-DD') AS date,
        COALESCE(ROUND((100.0 * d.present_like / NULLIF(d.total, 0))::numeric, 2), 0) AS attendance_rate,
        d.total
      FROM daily d
      ORDER BY d.date ASC
    `);

    return getRows<AttendanceDailyRow>(result).map((row) => ({
      date: row.date,
      attendanceRate: Number(parseNumeric(row.attendance_rate).toFixed(2)),
      total: parseNumeric(row.total),
    }));
  });

  const topTeachersByAbsence = await withTenantSchema(tenant.schema_name, async (tenantDb) => {
    const result = await tenantDb.execute<TopTeacherRow>(sql`
      SELECT
        t.id AS teacher_id,
        u.name AS teacher_name,
        COUNT(*)::int AS absence_count
      FROM attendances_teacher a
      JOIN teachers t ON t.id = a.teacher_id
      JOIN users u ON u.id = t.user_id
      WHERE a.date >= CURRENT_DATE - INTERVAL '29 days'
        AND a.status = 'absent'
      GROUP BY t.id, u.name
      ORDER BY absence_count DESC, u.name ASC
      LIMIT 5
    `);

    return getRows<TopTeacherRow>(result).map((row) => ({
      teacherId: row.teacher_id,
      teacherName: row.teacher_name,
      absenceCount: parseNumeric(row.absence_count),
    }));
  });

  return {
    tenantId,
    dau: parseNumeric(statsHead?.dau),
    wau: parseNumeric(statsHead?.wau),
    mau: parseNumeric(statsHead?.mau),
    smsSent30d: parseNumeric(statsHead?.sms_sent_30d),
    attendanceRateByDay,
    topTeachersByAbsence,
  };
};

type SchoolUsageMetrics = {
  nbUsers: number;
  lastConnection: string | null;
  activeUsers7d: number;
  teachersCount: number;
  studentsCount: number;
  attendanceRecords30d: number;
};

const getSchoolUsageMetrics = async (
  publicDb: TenantDb,
  schemaName: string
): Promise<SchoolUsageMetrics> => {
  const schema = quoteIdentifier(schemaName);
  try {
    const result = await publicDb.execute<{
      nb_users: number;
      last_connection: Date | null;
      active_users_7d: number;
      teachers_count: number;
      students_count: number;
      attendance_records_30d: number;
    }>(sql.raw(`
      SELECT
        (SELECT COUNT(*)::int FROM ${schema}.users) AS nb_users,
        (SELECT MAX(last_login_at) FROM ${schema}.users) AS last_connection,
        (SELECT COUNT(*)::int FROM ${schema}.users WHERE last_login_at >= NOW() - INTERVAL '7 days') AS active_users_7d,
        (SELECT COUNT(*)::int FROM ${schema}.teachers) AS teachers_count,
        (SELECT COUNT(*)::int FROM ${schema}.students) AS students_count,
        (SELECT COUNT(*)::int FROM ${schema}.attendances_teacher WHERE date >= CURRENT_DATE - INTERVAL '29 days') AS attendance_records_30d
    `));

    const [row] = getRows<{
      nb_users: number;
      last_connection: Date | null;
      active_users_7d: number;
      teachers_count: number;
      students_count: number;
      attendance_records_30d: number;
    }>(result);

    return {
      nbUsers: parseNumeric(row?.nb_users),
      lastConnection: formatDateTime(row?.last_connection ?? null),
      activeUsers7d: parseNumeric(row?.active_users_7d),
      teachersCount: parseNumeric(row?.teachers_count),
      studentsCount: parseNumeric(row?.students_count),
      attendanceRecords30d: parseNumeric(row?.attendance_records_30d),
    };
  } catch {
    // Keep admin school listing resilient when a tenant schema is partially provisioned or corrupted.
    return {
      nbUsers: 0,
      lastConnection: null,
      activeUsers7d: 0,
      teachersCount: 0,
      studentsCount: 0,
      attendanceRecords30d: 0,
    };
  }
};

const getSchoolConnectionHistory30d = async (
  publicDb: TenantDb,
  schemaName: string
): Promise<Array<{ date: string; uniqueUsers: number }>> => {
  const schema = quoteIdentifier(schemaName);
  const result = await publicDb.execute<{ date: string; unique_users: number }>(sql.raw(`
    SELECT
      to_char(date_trunc('day', u.last_login_at), 'YYYY-MM-DD') AS date,
      COUNT(DISTINCT u.id)::int AS unique_users
    FROM ${schema}.users u
    WHERE u.last_login_at >= NOW() - INTERVAL '30 days'
    GROUP BY 1
    ORDER BY 1 ASC
  `));

  return getRows<{ date: string; unique_users: number }>(result).map((row) => ({
    date: row.date,
    uniqueUsers: parseNumeric(row.unique_users),
  }));
};

const getTenantDauLast7d = async (
  publicDb: TenantDb,
  schemaName: string
): Promise<Array<{ date: string; uniqueUsers: number }>> => {
  const schema = quoteIdentifier(schemaName);
  const result = await publicDb.execute<{ date: string; unique_users: number }>(sql.raw(`
    SELECT
      to_char(date_trunc('day', u.last_login_at), 'YYYY-MM-DD') AS date,
      COUNT(DISTINCT u.id)::int AS unique_users
    FROM ${schema}.users u
    WHERE u.last_login_at >= CURRENT_DATE - INTERVAL '6 days'
    GROUP BY 1
    ORDER BY 1 ASC
  `));

  return getRows<{ date: string; unique_users: number }>(result).map((row) => ({
    date: row.date,
    uniqueUsers: parseNumeric(row.unique_users),
  }));
};

const getSchoolMrr = async (publicDb: TenantDb, tenantId: string): Promise<number> => {
  const result = await publicDb.execute<{ mrr_fcfa: number }>(sql`
    SELECT COALESCE(SUM(s.mrr_fcfa), 0)::int AS mrr_fcfa
    FROM public.subscriptions s
    WHERE s.tenant_id = ${tenantId}
      AND s.status IN ('active', 'past_due')
  `);

  const [row] = getRows<{ mrr_fcfa: number }>(result);
  return parseNumeric(row?.mrr_fcfa);
};

export const createSchool = async (
  publicDb: TenantDb,
  payload: CreateSchoolBody
): Promise<{
  tenantId: string;
  schoolSchemaName: string;
  directorCredentials: {
    userId: string;
    name: string;
    phone: string;
    email: string | null;
    password: string;
  };
}> => {
  const schemaName = toSchemaName(payload.subdomain);
  const directorPassword = generateDirectorInitialPassword();
  const passwordHash = await argon2.hash(directorPassword);

  await createTenantSchema(schemaName);

  const now = new Date();
  const trialEndsAt = new Date(now);
  trialEndsAt.setUTCDate(trialEndsAt.getUTCDate() + DEFAULT_TRIAL_DAYS);

  const tenantResult = await publicDb.execute<TenantLookupRow>(sql`
    INSERT INTO public.tenants (
      name,
      subdomain,
      schema_name,
      plan,
      status,
      city,
      teaching_type,
      max_admin_positions,
      max_users,
      trial_ends_at
    )
    VALUES (
      ${payload.name},
      ${payload.subdomain},
      ${schemaName},
      ${payload.plan},
      'trial',
      ${payload.city},
      ${payload.teaching_type},
      ${payload.max_admin_positions},
      ${MAX_USERS_BY_PLAN[payload.plan]},
      ${trialEndsAt}
    )
    RETURNING id, schema_name
  `);

  const tenant = getRows<TenantLookupRow>(tenantResult)[0];
  if (!tenant) {
    throw new Error('Unable to create tenant');
  }

  let directorResult: DirectorInsertRow;

  try {
    directorResult = await withTenantSchema(schemaName, async (tenantDb) => {
      const directorInsert = await tenantDb.execute<DirectorInsertRow>(sql`
        INSERT INTO users (role, name, phone, email, password_hash, is_active)
        VALUES (
          'director',
          ${payload.director_name},
          ${payload.director_phone},
          ${payload.director_email ?? null},
          ${passwordHash},
          true
        )
        RETURNING id
      `);

      const director = getRows<DirectorInsertRow>(directorInsert)[0];
      if (!director) {
        throw new Error('Unable to create tenant director');
      }

      return director;
    });

    await publicDb.execute(sql`
      INSERT INTO public.subscriptions (
        tenant_id,
        status,
        mrr_fcfa,
        billing_cycle,
        current_period_start,
        current_period_end
      )
      VALUES (
        ${tenant.id},
        'active',
        0,
        'monthly',
        ${now},
        ${trialEndsAt}
      )
    `);
  } catch (error) {
    await publicDb.execute(sql`
      DELETE FROM public.tenants
      WHERE id = ${tenant.id}
    `);
    throw error;
  }

  return {
    tenantId: tenant.id,
    schoolSchemaName: schemaName,
    directorCredentials: {
      userId: directorResult.id,
      name: payload.director_name,
      phone: payload.director_phone,
      email: payload.director_email ?? null,
      password: directorPassword,
    },
  };
};

export const listSchools = async (
  publicDb: TenantDb,
  query: ListSchoolsQuery
): Promise<SchoolListResult> => {
  const tenantsResult = await publicDb.execute<SchoolLookupRow>(sql`
    SELECT
      t.id,
      t.name,
      t.subdomain,
      t.schema_name,
      t.plan,
      t.status,
      t.city,
      t.teaching_type,
      t.max_admin_positions,
      t.max_users,
      COALESCE(t.max_sms_per_month, 2000) AS max_sms_per_month,
      COALESCE(t.student_label, 'Élève') AS student_label,
      COALESCE(t.director_title, 'Directeur') AS director_title,
      COALESCE(t.can_edit_sms_template, false) AS can_edit_sms_template,
      COALESCE(t.can_export_data, true) AS can_export_data,
      t.created_at,
      t.updated_at
    FROM public.tenants t
    ORDER BY t.created_at DESC
  `);

  const tenants = getRows<SchoolLookupRow>(tenantsResult);

  const schoolsWithMetrics = await mapWithConcurrency(tenants, TENANT_METRICS_CONCURRENCY, async (tenant) => {
    const usage = await getSchoolUsageMetrics(publicDb, tenant.schema_name);
    const mrr = await getSchoolMrr(publicDb, tenant.id);

    return {
      tenantId: tenant.id,
      name: tenant.name,
      plan: tenant.plan,
      status: tenant.status,
      nbUsers: usage.nbUsers,
      lastConnection: usage.lastConnection,
      mrrFcfa: mrr,
    } satisfies SchoolListItem;
  });

  const page = query.page;
  const limit = query.limit;
  const offset = (page - 1) * limit;
  const total = schoolsWithMetrics.length;

  return {
    schools: schoolsWithMetrics.slice(offset, offset + limit),
    pagination: {
      page,
      limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    },
  };
};

export const getSchoolDetails = async (
  publicDb: TenantDb,
  tenantId: string
): Promise<SchoolDetailsResult> => {
  const result = await publicDb.execute<SchoolLookupRow>(sql`
    SELECT
      t.id,
      t.name,
      t.subdomain,
      t.schema_name,
      t.plan,
      t.status,
      t.city,
      t.teaching_type,
      t.max_admin_positions,
      t.max_users,
      COALESCE(t.max_sms_per_month, 2000) AS max_sms_per_month,
      COALESCE(t.student_label, 'Élève') AS student_label,
      COALESCE(t.director_title, 'Directeur') AS director_title,
      COALESCE(t.can_edit_sms_template, false) AS can_edit_sms_template,
      COALESCE(t.can_export_data, true) AS can_export_data,
      t.created_at,
      t.updated_at
    FROM public.tenants t
    WHERE t.id = ${tenantId}
    LIMIT 1
  `);

  const tenant = getRows<SchoolLookupRow>(result)[0];
  if (!tenant) {
    throw new Error('Tenant not found');
  }

  const [usage, mrrFcfa, connectionHistory30d] = await Promise.all([
    getSchoolUsageMetrics(publicDb, tenant.schema_name),
    getSchoolMrr(publicDb, tenant.id),
    getSchoolConnectionHistory30d(publicDb, tenant.schema_name),
  ]);

  return {
    tenantId: tenant.id,
    metadata: {
      name: tenant.name,
      subdomain: tenant.subdomain,
      schemaName: tenant.schema_name,
      plan: tenant.plan,
      status: tenant.status,
      city: tenant.city,
      teachingType: tenant.teaching_type,
      maxAdminPositions: tenant.max_admin_positions,
      maxUsers: tenant.max_users,
      maxSmsPerMonth: tenant.max_sms_per_month,
      studentLabel: tenant.student_label,
      directorTitle: tenant.director_title,
      canEditSmsTemplate: tenant.can_edit_sms_template,
      canExportData: tenant.can_export_data,
      createdAt: formatDateTime(tenant.created_at) ?? new Date(0).toISOString(),
      updatedAt: formatDateTime(tenant.updated_at) ?? new Date(0).toISOString(),
    },
    usageStats: {
      nbUsers: usage.nbUsers,
      activeUsers7d: usage.activeUsers7d,
      teachersCount: usage.teachersCount,
      studentsCount: usage.studentsCount,
      attendanceRecords30d: usage.attendanceRecords30d,
      mrrFcfa,
      lastConnection: usage.lastConnection,
    },
    connectionHistory30d,
  };
};

export const updateSchoolConfig = async (
  publicDb: TenantDb,
  tenantId: string,
  payload: UpdateSchoolConfigBody
): Promise<void> => {
  await ensureAdminPublicInfrastructure(publicDb);

  const result = await publicDb.execute<{ id: string }>(sql`
    UPDATE public.tenants
    SET
      plan = CASE WHEN ${payload.plan !== undefined} THEN ${payload.plan ?? null}::tenant_plan ELSE plan END,
      status = CASE WHEN ${payload.status !== undefined} THEN ${payload.status ?? null}::tenant_status ELSE status END,
      city = CASE WHEN ${payload.city !== undefined} THEN ${payload.city ?? null} ELSE city END,
      teaching_type = CASE WHEN ${payload.teaching_type !== undefined}
        THEN ${payload.teaching_type ?? null}::teaching_type
        ELSE teaching_type END,
      student_label = CASE WHEN ${payload.student_label !== undefined}
        THEN ${payload.student_label ?? null}
        ELSE student_label END,
      director_title = CASE WHEN ${payload.director_title !== undefined}
        THEN ${payload.director_title ?? null}
        ELSE director_title END,
      max_users = CASE WHEN ${payload.max_users !== undefined}
        THEN ${payload.max_users ?? null}::integer
        ELSE max_users END,
      max_admin_positions = CASE
        WHEN ${payload.max_admin_positions !== undefined}
          THEN ${payload.max_admin_positions ?? null}::integer
        ELSE max_admin_positions
      END,
      max_sms_per_month = CASE WHEN ${payload.max_sms_per_month !== undefined}
        THEN ${payload.max_sms_per_month ?? null}::integer
        ELSE max_sms_per_month END,
      can_edit_sms_template = CASE WHEN ${payload.can_edit_sms_template !== undefined}
        THEN ${payload.can_edit_sms_template ?? null}::boolean
        ELSE can_edit_sms_template END,
      can_export_data = CASE WHEN ${payload.can_export_data !== undefined}
        THEN ${payload.can_export_data ?? null}::boolean
        ELSE can_export_data END,
      updated_at = NOW()
    WHERE id = ${tenantId}
    RETURNING id
  `);

  if (!getRows<{ id: string }>(result)[0]) {
    throw new Error('Tenant not found');
  }
};

export const getAdminMetrics = async (publicDb: TenantDb): Promise<AdminMetricsResult> => {
  const tenantsResult = await publicDb.execute<SchoolLookupRow>(sql`
    SELECT
      t.id,
      t.name,
      t.subdomain,
      t.schema_name,
      t.plan,
      t.status,
      t.city,
      t.teaching_type,
      t.max_admin_positions,
      t.max_users,
      COALESCE(t.max_sms_per_month, 2000) AS max_sms_per_month,
      COALESCE(t.student_label, 'Élève') AS student_label,
      COALESCE(t.director_title, 'Directeur') AS director_title,
      COALESCE(t.can_edit_sms_template, false) AS can_edit_sms_template,
      COALESCE(t.can_export_data, true) AS can_export_data,
      t.created_at,
      t.updated_at
    FROM public.tenants t
  `);
  const tenants = getRows<SchoolLookupRow>(tenantsResult);

  const usageByTenant = await mapWithConcurrency(tenants, TENANT_METRICS_CONCURRENCY, async (tenant) => {
    return {
      tenantId: tenant.id,
      plan: tenant.plan,
      usage: await getSchoolUsageMetrics(publicDb, tenant.schema_name),
      dauLast7d: await getTenantDauLast7d(publicDb, tenant.schema_name),
    };
  });

  const schoolPlanResult = await publicDb.execute<SchoolPlanRow>(sql`
    SELECT plan, COUNT(*)::int AS count
    FROM public.tenants
    GROUP BY plan
    ORDER BY plan
  `);

  const mrrResult = await publicDb.execute<{ total_mrr: number }>(sql`
    SELECT COALESCE(SUM(s.mrr_fcfa), 0)::int AS total_mrr
    FROM public.subscriptions s
    WHERE s.status IN ('active', 'past_due')
  `);
  const [mrrRow] = getRows<{ total_mrr: number }>(mrrResult);

  const dauByDate = new Map<string, number>();
  for (const tenantUsage of usageByTenant) {
    for (const daily of tenantUsage.dauLast7d) {
      dauByDate.set(daily.date, (dauByDate.get(daily.date) ?? 0) + daily.uniqueUsers);
    }
  }

  const dauLast7d = Array.from({ length: 7 }, (_, idx) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - (6 - idx));
    const key = date.toISOString().slice(0, 10);
    return {
      date: key,
      uniqueUsers: dauByDate.get(key) ?? 0,
    };
  });

  return {
    totalSchools: tenants.length,
    activeSchools: usageByTenant.filter((item) => {
      if (!item.usage.lastConnection) {
        return false;
      }
      return new Date(item.usage.lastConnection).getTime() >= Date.now() - 7 * 24 * 60 * 60 * 1000;
    }).length,
    mrrTotalFcfa: parseNumeric(mrrRow?.total_mrr),
    dauLast7d,
    schoolsByPlan: getRows<SchoolPlanRow>(schoolPlanResult).map((row) => ({
      plan: row.plan,
      count: parseNumeric(row.count),
    })),
  };
};

export const getRevenueMetrics = async (publicDb: TenantDb): Promise<RevenueMetricsResult> => {
  const result = await publicDb.execute<SchoolRevenueRow>(sql`
    WITH months AS (
      SELECT to_char(date_trunc('month', CURRENT_DATE) - (gs || ' months')::interval, 'YYYY-MM') AS month_key
      FROM generate_series(11, 0, -1) gs
    ),
    payments AS (
      SELECT
        to_char(date_trunc('month', pe.created_at), 'YYYY-MM') AS month_key,
        COUNT(*)::int AS payments_count,
        COALESCE(SUM(pe.amount_fcfa), 0)::int AS mrr_fcfa
      FROM public.payment_events pe
      WHERE pe.status = 'success'
        AND pe.created_at >= date_trunc('month', CURRENT_DATE) - INTERVAL '11 months'
      GROUP BY 1
    )
    SELECT
      m.month_key AS month,
      COALESCE(p.mrr_fcfa, 0)::int AS mrr_fcfa,
      COALESCE(p.payments_count, 0)::int AS payments_count
    FROM months m
    LEFT JOIN payments p ON p.month_key = m.month_key
    ORDER BY m.month_key ASC
  `);

  return getRows<SchoolRevenueRow>(result).map((row) => ({
    month: row.month,
    mrr_fcfa: parseNumeric(row.mrr_fcfa),
    payments_count: parseNumeric(row.payments_count),
  }));
};

export const getRevenueSummary = async (publicDb: TenantDb): Promise<RevenueSummaryResult> => {
  await ensureAdminPublicInfrastructure(publicDb);

  const [mrrResult, monthlyResult, schoolsResult, cardsResult] = await Promise.all([
    publicDb.execute<{ total_mrr: number }>(sql`
      SELECT COALESCE(SUM(s.mrr_fcfa), 0)::int AS total_mrr
      FROM public.subscriptions s
      WHERE s.status IN ('active', 'past_due')
    `),
    publicDb.execute<RevenueSummaryRow>(sql`
      WITH months AS (
        SELECT to_char(date_trunc('month', CURRENT_DATE) - (gs || ' months')::interval, 'YYYY-MM') AS month_key
        FROM generate_series(11, 0, -1) gs
      ),
      metrics AS (
        SELECT
          to_char(date_trunc('month', pe.created_at), 'YYYY-MM') AS month_key,
          COALESCE(SUM(CASE WHEN pe.status = 'success' THEN pe.amount_fcfa ELSE 0 END), 0)::int AS mrr_fcfa,
          COALESCE(SUM(CASE WHEN pe.status = 'success' THEN pe.amount_fcfa ELSE 0 END), 0)::int AS new_fcfa,
          COALESCE(SUM(CASE WHEN pe.status = 'failed' THEN pe.amount_fcfa ELSE 0 END), 0)::int AS churn_fcfa
        FROM public.payment_events pe
        WHERE pe.created_at >= date_trunc('month', CURRENT_DATE) - INTERVAL '11 months'
        GROUP BY 1
      )
      SELECT
        m.month_key AS month,
        COALESCE(mt.mrr_fcfa, 0)::int AS mrr_fcfa,
        COALESCE(mt.new_fcfa, 0)::int AS new_fcfa,
        COALESCE(mt.churn_fcfa, 0)::int AS churn_fcfa
      FROM months m
      LEFT JOIN metrics mt ON mt.month_key = m.month_key
      ORDER BY m.month_key ASC
    `),
    publicDb.execute<RevenueSchoolRow>(sql`
      SELECT
        t.id AS tenant_id,
        t.name AS school,
        t.plan,
        t.status,
        COALESCE(s.mrr_fcfa, 0)::int AS amount_per_month,
        s.current_period_end::text AS last_due_date,
        COALESCE(s.momo_phone, 'manual') AS payment_mode
      FROM public.tenants t
      LEFT JOIN LATERAL (
        SELECT mrr_fcfa, current_period_end, momo_phone
        FROM public.subscriptions
        WHERE tenant_id = t.id
        ORDER BY created_at DESC
        LIMIT 1
      ) s ON true
      ORDER BY t.name ASC
    `),
    publicDb.execute<{
      new_subscriptions: number;
      churn: number;
    }>(sql`
      SELECT
        (
          SELECT COUNT(*)::int
          FROM public.subscriptions s
          WHERE date_trunc('month', s.created_at) = date_trunc('month', CURRENT_DATE)
        ) AS new_subscriptions,
        (
          SELECT COUNT(*)::int
          FROM public.subscriptions s
          WHERE s.status = 'cancelled'
            AND date_trunc('month', s.created_at) = date_trunc('month', CURRENT_DATE)
        ) AS churn
    `),
  ]);

  const mrr = parseNumeric(getRows<{ total_mrr: number }>(mrrResult)[0]?.total_mrr);
  const cards = getRows<{ new_subscriptions: number; churn: number }>(cardsResult)[0];

  return {
    cards: {
      mrrTotalFcfa: mrr,
      arrFcfa: mrr * 12,
      newSubscriptionsThisMonth: parseNumeric(cards?.new_subscriptions),
      churnThisMonth: parseNumeric(cards?.churn),
    },
    monthly: getRows<RevenueSummaryRow>(monthlyResult).map((row) => ({
      month: row.month,
      mrr_fcfa: parseNumeric(row.mrr_fcfa),
      new_fcfa: parseNumeric(row.new_fcfa),
      churn_fcfa: parseNumeric(row.churn_fcfa),
    })),
    schools: getRows<RevenueSchoolRow>(schoolsResult).map((row) => ({
      tenantId: row.tenant_id,
      school: row.school,
      plan: row.plan,
      status: row.status,
      amountPerMonth: parseNumeric(row.amount_per_month),
      lastDueDate: row.last_due_date,
      paymentMode: row.payment_mode,
    })),
  };
};

export const listSchoolPayments = async (
  publicDb: TenantDb,
  tenantId: string
): Promise<
  Array<{
    id: string;
    date: string;
    amountFcfa: number;
    provider: string;
    reference: string | null;
    status: string;
  }>
> => {
  const result = await publicDb.execute<{
    id: string;
    date: string;
    amount_fcfa: number;
    provider: string;
    provider_ref: string | null;
    status: string;
  }>(sql`
    SELECT
      pe.id::text AS id,
      pe.created_at::text AS date,
      pe.amount_fcfa,
      pe.provider::text AS provider,
      pe.provider_ref,
      pe.status::text AS status
    FROM public.payment_events pe
    INNER JOIN public.subscriptions s ON s.id = pe.subscription_id
    WHERE s.tenant_id = ${tenantId}
    ORDER BY pe.created_at DESC
    LIMIT 100
  `);

  return getRows<{
    id: string;
    date: string;
    amount_fcfa: number;
    provider: string;
    provider_ref: string | null;
    status: string;
  }>(result).map((row) => ({
    id: row.id,
    date: row.date,
    amountFcfa: parseNumeric(row.amount_fcfa),
    provider: row.provider,
    reference: row.provider_ref,
    status: row.status,
  }));
};

export const addManualPayment = async (
  publicDb: TenantDb,
  tenantId: string,
  payload: {
    date: string;
    amount_fcfa: number;
    provider: 'manual' | 'mtn_momo' | 'orange_money';
    reference?: string;
    period_from?: string;
    period_to?: string;
  }
): Promise<void> => {
  const subscriptionResult = await publicDb.execute<{ id: string }>(sql`
    SELECT id
    FROM public.subscriptions
    WHERE tenant_id = ${tenantId}
    ORDER BY created_at DESC
    LIMIT 1
  `);
  const subscriptionId = getRows<{ id: string }>(subscriptionResult)[0]?.id;
  if (!subscriptionId) {
    throw new Error('Tenant not found');
  }

  await publicDb.execute(sql`
    INSERT INTO public.payment_events (subscription_id, amount_fcfa, provider, provider_ref, status, created_at)
    VALUES (
      ${subscriptionId},
      ${payload.amount_fcfa},
      ${payload.provider},
      ${payload.reference ?? null},
      'success',
      ${payload.date}
    )
  `);

  if (payload.period_from && payload.period_to) {
    await publicDb.execute(sql`
      UPDATE public.subscriptions
      SET current_period_start = ${payload.period_from},
          current_period_end = ${payload.period_to},
          status = 'active'
      WHERE id = ${subscriptionId}
    `);
  }
};

export const getSmsDashboard = async (publicDb: TenantDb): Promise<SmsDashboardResult> => {
  await ensureAdminPublicInfrastructure(publicDb);

  const tenantsResult = await publicDb.execute<{ id: string; name: string; schema_name: string; max_sms_per_month: number }>(sql`
    SELECT id, name, schema_name, COALESCE(max_sms_per_month, 2000)::int AS max_sms_per_month
    FROM public.tenants
    ORDER BY name ASC
  `);
  const tenants = getRows<{
    id: string;
    name: string;
    schema_name: string;
    max_sms_per_month: number;
  }>(tenantsResult);

  const bySchool: SmsStatsBySchoolRow[] = [];
  const history: SmsHistoryRow[] = [];
  let sentThisMonth = 0;
  let delivered = 0;
  let total = 0;

  for (const tenant of tenants) {
    const schema = quoteIdentifier(tenant.schema_name);
    const escapedSchoolName = tenant.name.replace(/'/g, "''");
    const statsResult = await publicDb.execute<{ sent: number; delivered: number; total: number }>(sql.raw(`
      SELECT
        COUNT(*) FILTER (WHERE nl.status IN ('sent', 'delivered')
          AND date_trunc('month', COALESCE(nl.sent_at, nl.created_at)) = date_trunc('month', CURRENT_DATE))::int AS sent,
        COUNT(*) FILTER (WHERE nl.status = 'delivered')::int AS delivered,
        COUNT(*)::int AS total
      FROM ${schema}.notifications_log nl
    `));
    const stats = getRows<{ sent: number; delivered: number; total: number }>(statsResult)[0] ?? {
      sent: 0,
      delivered: 0,
      total: 0,
    };
    sentThisMonth += parseNumeric(stats.sent);
    delivered += parseNumeric(stats.delivered);
    total += parseNumeric(stats.total);

    const usedPct = tenant.max_sms_per_month > 0
      ? Math.min(100, Math.round((parseNumeric(stats.sent) / tenant.max_sms_per_month) * 100))
      : 0;

    bySchool.push({
      tenant_id: tenant.id,
      school: tenant.name,
      sent: parseNumeric(stats.sent),
      quota: tenant.max_sms_per_month,
      used_pct: usedPct,
    });

    const historyResult = await publicDb.execute<SmsHistoryRow>(sql.raw(`
      SELECT
        nl.id::text AS id,
        COALESCE(nl.sent_at, nl.created_at)::text AS date,
        '${escapedSchoolName}'::text AS school,
        nl.type::text AS type,
        nl.recipient_phone,
        nl.status::text AS status,
        nl.message
      FROM ${schema}.notifications_log nl
      ORDER BY COALESCE(nl.sent_at, nl.created_at) DESC
      LIMIT 20
    `));
    history.push(...getRows<SmsHistoryRow>(historyResult));
  }

  history.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return {
    sentThisMonth,
    deliveryRate: total > 0 ? Number(((delivered / total) * 100).toFixed(2)) : 0,
    activeSchools: bySchool.filter((row) => row.sent > 0).length,
    estimatedCostFcfa: sentThisMonth * 12,
    bySchool: bySchool.map((row) => ({
      tenantId: row.tenant_id,
      school: row.school,
      sent: row.sent,
      quota: row.quota,
      usedPct: row.used_pct,
    })),
    history: history.slice(0, 200).map((row) => ({
      id: row.id,
      date: row.date,
      school: row.school,
      type: row.type,
      recipientMasked: maskPhone(row.recipient_phone),
      status: row.status,
      message: row.message,
    })),
  };
};

export const listSmsTemplates = async (
  publicDb: TenantDb,
  tenantId?: string
): Promise<SmsTemplateItem[]> => {
  await ensureAdminPublicInfrastructure(publicDb);
  const result = await publicDb.execute<SmsTemplateRow>(sql`
    SELECT id::text, tenant_id::text, type::text, message_template, variables, updated_at
    FROM public.sms_templates
    WHERE (${tenantId ?? null}::uuid IS NULL AND tenant_id IS NULL)
       OR (${tenantId ?? null}::uuid IS NOT NULL AND tenant_id = ${tenantId ?? null}::uuid)
    ORDER BY type ASC
  `);

  return getRows<SmsTemplateRow>(result).map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    type: row.type,
    messageTemplate: row.message_template,
    variables: row.variables ?? [],
    updatedAt: formatDateTime(row.updated_at) ?? new Date().toISOString(),
  }));
};

export const upsertSmsTemplate = async (
  publicDb: TenantDb,
  params: {
    tenantId: string | null;
    type: SmsTemplateType;
    body: UpdateSmsTemplateBody;
    adminId?: string;
  }
): Promise<void> => {
  await ensureAdminPublicInfrastructure(publicDb);
  await publicDb.execute(sql`
    INSERT INTO public.sms_templates (tenant_id, type, message_template, variables, created_by, updated_at)
    VALUES (
      ${params.tenantId},
      ${params.type},
      ${params.body.message_template},
      ${params.body.variables},
      ${params.adminId ?? null},
      NOW()
    )
    ON CONFLICT (tenant_id, type)
    DO UPDATE SET
      message_template = EXCLUDED.message_template,
      variables = EXCLUDED.variables,
      updated_at = NOW()
  `);
};

export const deleteTenantSmsTemplate = async (
  publicDb: TenantDb,
  tenantId: string,
  type: SmsTemplateType
): Promise<void> => {
  await ensureAdminPublicInfrastructure(publicDb);
  await publicDb.execute(sql`
    DELETE FROM public.sms_templates
    WHERE tenant_id = ${tenantId}
      AND type = ${type}
  `);
};

export const getMaintenanceConfig = async (
  publicDb: TenantDb
): Promise<{ maintenanceMode: boolean; maintenanceMessage: string; updatedAt: string }> => {
  await ensureAdminPublicInfrastructure(publicDb);
  const result = await publicDb.execute<{
    maintenance_mode: boolean;
    maintenance_message: string;
    updated_at: string;
  }>(sql`
    SELECT maintenance_mode, maintenance_message, updated_at::text
    FROM public.app_settings
    ORDER BY updated_at DESC
    LIMIT 1
  `);
  const row = getRows<{
    maintenance_mode: boolean;
    maintenance_message: string;
    updated_at: string;
  }>(result)[0];
  return {
    maintenanceMode: row?.maintenance_mode ?? false,
    maintenanceMessage: row?.maintenance_message ?? 'Mise à jour en cours',
    updatedAt: row?.updated_at ?? new Date().toISOString(),
  };
};

export const updateMaintenanceConfig = async (
  publicDb: TenantDb,
  payload: { maintenance_mode: boolean; maintenance_message: string }
): Promise<void> => {
  await ensureAdminPublicInfrastructure(publicDb);
  await publicDb.execute(sql`
    UPDATE public.app_settings
    SET maintenance_mode = ${payload.maintenance_mode},
        maintenance_message = ${payload.maintenance_message},
        updated_at = NOW()
  `);
};

export const createImpersonationToken = async (
  publicDb: TenantDb,
  tenantId: string,
  adminId: string | undefined
): Promise<ImpersonationResult> => {
  if (!adminId) {
    throw new Error('Unauthorized');
  }

  const tenant = await getTenantById(publicDb, tenantId);
  const privateKey = await getPrivateKey();

  const token = await new SignJWT({
    sub: adminId,
    role: 'super_admin',
    schemaName: tenant.schema_name,
    tenantId: tenant.id,
    readOnly: true,
    impersonation: true,
  })
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject(adminId)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);

  return {
    token,
    tokenType: 'Bearer',
    expiresIn: '1h',
    tenantId: tenant.id,
    schemaName: tenant.schema_name,
    readOnly: true,
  };
};
