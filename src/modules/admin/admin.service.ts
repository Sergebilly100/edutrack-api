import { randomBytes } from 'node:crypto';

import argon2 from 'argon2';
import { sql } from 'drizzle-orm';
import { Redis } from 'ioredis';

import {
  type AdminMetricsResult,
  type CreateSchoolBody,
  type CreateTenantBody,
  type ListTenantsQuery,
  type PlanCatalogItem,
  type ListSchoolsQuery,
  type RevenueMetricsResult,
  type RevenueSummaryResult,
  type SchoolDetailsResult,
  type SchoolListItem,
  type SchoolListResult,
  type SchoolPaymentReminderResult,
  type SchoolUsersResult,
  type SmsDashboardResult,
  type SmsPlatformAuditItem,
  type SmsPlatformConfigResult,
  type SmsProvider,
  type SmsTemplateItem,
  type SmsTemplateType,
  type TeachingType,
  type TenantListItem,
  type TenantListResult,
  type TenantStatsResult,
  type UpdatePlanCatalogBody,
  type UpdateSmsPlatformConfigBody,
  type UpdateSmsTemplateBody,
  type UpdateSchoolConfigBody,
  type UpdateTenantBody,
} from './admin.types.js';
import { withTenantSchema, type TenantDb } from '../../shared/database/db.js';
import { createTenantSchema } from '../../shared/database/tenant-init.js';
import { signJwtRs256 } from '../../shared/auth/jwt.js';
import { emit } from '../../shared/events/event-bus.js';
import { SubscriptionsRepository } from '../subscriptions/subscriptions.repository.js';

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
  name?: string;
  schema_name: string;
  status: TenantListItem['status'];
};

type SchoolContactRow = {
  name: string;
  phone: string | null;
  email: string | null;
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
  active_school_year: string | null;
  logo_url: string | null;
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

type PlanCatalogRow = {
  plan: TenantListItem['plan'];
  monthly_price_fcfa: number;
  max_users: number;
  max_admin_positions: number;
  updated_at: string;
};

type SchoolListRow = {
  id: string;
  name: string;
  city: string | null;
  plan: TenantListItem['plan'];
  status: TenantListItem['status'];
  nb_users: number;
  mrr_fcfa: number;
  last_connection: string | null;
  total_count: number;
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

type TenantUserLookupRow = {
  id: string;
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

type SchoolSmsFeatureConfigResult = {
  is_enabled: boolean;
  commission_pct: number;
  sms_cap_per_student: number;
  monetize_parent_alerts: boolean;
  use_real_hours: boolean;
  geo_check_enabled: boolean;
};

type SmsHistoryRow = {
  id: string;
  tenant_id: string;
  date: string;
  school: string;
  type: string;
  recipient_phone: string;
  status: string;
  message: string;
};

type SmsPlatformConfigRow = {
  sms_provider: SmsProvider | null;
  sms_api_base_url: string | null;
  sms_api_key_last4: string | null;
  sms_api_key_updated_at: string | null;
  sms_sender_id: string | null;
  sms_fallback_sender_id: string | null;
  sms_default_country_code: string | null;
  sms_alert_quota_threshold_pct: number | null;
  sms_alert_failure_threshold_count: number | null;
  sms_alert_email: string | null;
  sms_maintenance_mode: boolean | null;
  sms_maintenance_message: string | null;
  updated_at: string | null;
};

type SmsPlatformAuditRow = {
  id: string;
  action: string;
  admin_id: string | null;
  created_at: string;
  details: unknown;
};

type SchoolUserRow = {
  id: string;
  role: string;
  name: string;
  phone: string | null;
  email: string | null;
  username: string | null;
  positions: string[] | null;
  last_login_at: string | null;
  is_active: boolean;
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
const EDUTRACK_COMMISSION_PCT = 15;
const SCHEMA_NAME_REGEX = /^[a-z][a-z0-9_]{2,63}$/;
const TENANT_METRICS_CONCURRENCY = 10;
const MAX_USERS_BY_PLAN: Record<TenantListItem['plan'], number> = {
  essential: 5,
  pro: 20,
  establishment: 50,
};

const normalizePem = (value: string): string => {
  const trimmed = value.trim();
  const unquoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1)
      : trimmed;

  return unquoted.replace(/\\n/g, '\n').replace(/\r\n/g, '\n');
};

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

  return normalizePem(privateKey);
};

const generateTemporaryPassword = (): string => {
  const random = randomBytes(9).toString('base64url');
  return `Tmp-${random}A1!`;
};

const generateDirectorInitialPassword = (): string => randomBytes(8).toString('hex');

const addDays = (date: Date, days: number): Date => {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
};

const addMonths = (date: Date, months: number): Date => {
  const copy = new Date(date);
  copy.setUTCMonth(copy.getUTCMonth() + months);
  return copy;
};

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

const toPgTextArrayLiteral = (values: readonly string[]): string => {
  if (values.length === 0) {
    return '{}';
  }

  const escaped = values.map((value) => {
    const sanitized = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${sanitized}"`;
  });

  return `{${escaped.join(',')}}`;
};

const toTextArraySql = (values: readonly string[]) =>
  sql`CAST(${toPgTextArrayLiteral(values)} AS text[])`;

const ensureAdminPublicInfrastructure = async (publicDb: TenantDb): Promise<void> => {
  await publicDb.execute(sql.raw(`
    ALTER TABLE public.tenants
      ADD COLUMN IF NOT EXISTS student_label varchar(120) DEFAULT 'Élève',
      ADD COLUMN IF NOT EXISTS director_title varchar(120) DEFAULT 'Directeur',
      ADD COLUMN IF NOT EXISTS max_sms_per_month integer DEFAULT 2000,
      ADD COLUMN IF NOT EXISTS can_edit_sms_template boolean DEFAULT false,
      ADD COLUMN IF NOT EXISTS can_export_data boolean DEFAULT true,
      ADD COLUMN IF NOT EXISTS active_school_year varchar(20),
      ADD COLUMN IF NOT EXISTS logo_url text;
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
    ALTER TABLE public.app_settings
      ADD COLUMN IF NOT EXISTS sms_provider varchar(50) NOT NULL DEFAULT 'mock',
      ADD COLUMN IF NOT EXISTS sms_api_base_url varchar(255),
      ADD COLUMN IF NOT EXISTS sms_api_key text,
      ADD COLUMN IF NOT EXISTS sms_api_key_last4 varchar(4),
      ADD COLUMN IF NOT EXISTS sms_api_key_updated_at timestamptz,
      ADD COLUMN IF NOT EXISTS sms_sender_id varchar(20) NOT NULL DEFAULT 'EduTrack',
      ADD COLUMN IF NOT EXISTS sms_fallback_sender_id varchar(20),
      ADD COLUMN IF NOT EXISTS sms_default_country_code varchar(8) NOT NULL DEFAULT '+225',
      ADD COLUMN IF NOT EXISTS sms_alert_quota_threshold_pct integer NOT NULL DEFAULT 80,
      ADD COLUMN IF NOT EXISTS sms_alert_failure_threshold_count integer NOT NULL DEFAULT 5,
      ADD COLUMN IF NOT EXISTS sms_alert_email varchar(255),
      ADD COLUMN IF NOT EXISTS sms_maintenance_mode boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS sms_maintenance_message text NOT NULL DEFAULT 'Service SMS en maintenance';
  `));

  await publicDb.execute(sql.raw(`
    ALTER TABLE public.app_settings
      DROP CONSTRAINT IF EXISTS app_settings_sms_provider_check;
    ALTER TABLE public.app_settings
      ADD CONSTRAINT app_settings_sms_provider_check
      CHECK (sms_provider IN ('mock', 'infobip', 'africas_talking', 'twilio', 'orange_api', 'custom'));
  `));

  await publicDb.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS public.sms_admin_audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      admin_id uuid,
      action varchar(80) NOT NULL,
      details jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `));

  await publicDb.execute(sql.raw(`
    INSERT INTO public.app_settings (maintenance_mode, maintenance_message)
    SELECT false, 'Mise à jour en cours'
    WHERE NOT EXISTS (SELECT 1 FROM public.app_settings);
  `));

  await publicDb.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS public.plan_catalog (
      plan tenant_plan PRIMARY KEY,
      monthly_price_fcfa integer NOT NULL DEFAULT 0,
      annual_price_fcfa integer NOT NULL DEFAULT 0,
      default_billing_cycle billing_cycle NOT NULL DEFAULT 'monthly',
      max_users integer NOT NULL DEFAULT 10,
      max_admin_positions integer NOT NULL DEFAULT 5,
      max_sms_per_month integer NOT NULL DEFAULT 2000,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `));

  await publicDb.execute(sql.raw(`
    INSERT INTO public.plan_catalog (
      plan,
      monthly_price_fcfa,
      annual_price_fcfa,
      default_billing_cycle,
      max_users,
      max_admin_positions,
      max_sms_per_month
    )
    VALUES
      ('essential', 15000, 162000, 'monthly', 5, 5, 2000),
      ('pro', 30000, 324000, 'monthly', 20, 15, 6000),
      ('establishment', 50000, 540000, 'monthly', 50, 30, 12000)
    ON CONFLICT (plan) DO NOTHING;
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

const toRecord = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
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
    SELECT id, name, schema_name, status
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

type SchoolSubscriptionSnapshot = {
  mrrFcfa: number;
  subscriptionStartedAt: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  billingCycle: 'monthly' | 'annual' | null;
  paidCurrentPeriodFcfa: number;
  remainingCurrentPeriodFcfa: number;
  nextDueDate: string | null;
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
  try {
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
  } catch {
    return [];
  }
};

const getSchoolLastPaymentReminderAt = async (
  publicDb: TenantDb,
  schemaName: string
): Promise<string | null> => {
  const schema = quoteIdentifier(schemaName);
  try {
    const result = await publicDb.execute<{ sent_at: string | null; created_at: string | null }>(
      sql.raw(`
        SELECT sent_at::text, created_at::text
        FROM ${schema}.notifications_log
        WHERE type = 'payment_reminder'
        ORDER BY COALESCE(sent_at, created_at) DESC
        LIMIT 1
      `)
    );

    const row = getRows<{ sent_at: string | null; created_at: string | null }>(result)[0];
    return row?.sent_at ?? row?.created_at ?? null;
  } catch {
    return null;
  }
};

const getSchoolContactForPaymentReminder = async (
  publicDb: TenantDb,
  schemaName: string
): Promise<SchoolContactRow | null> => {
  return withTenantSchema(schemaName, async (tenantDb) => {
    const directorResult = await tenantDb.execute<SchoolContactRow>(sql`
      SELECT name, phone, email
      FROM users
      WHERE is_active = true
        AND role = 'director'
      ORDER BY created_at ASC
      LIMIT 1
    `);

    const director = getRows<SchoolContactRow>(directorResult)[0];
    if (director?.phone) {
      return director;
    }

    const staffResult = await tenantDb.execute<SchoolContactRow>(sql`
      SELECT name, phone, email
      FROM users
      WHERE is_active = true
        AND role = 'staff'
        AND (phone IS NOT NULL OR email IS NOT NULL)
      ORDER BY created_at ASC
      LIMIT 1
    `);

    const staff = getRows<SchoolContactRow>(staffResult)[0];
    return staff ?? director ?? null;
  });
};

const getTenantDauLast7d = async (
  publicDb: TenantDb,
  schemaName: string
): Promise<Array<{ date: string; uniqueUsers: number }>> => {
  const schema = quoteIdentifier(schemaName);
  try {
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
  } catch {
    return [];
  }
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

const getSchoolSubscriptionSnapshot = async (
  publicDb: TenantDb,
  tenantId: string
): Promise<SchoolSubscriptionSnapshot> => {
  const result = await publicDb.execute<{
    mrr_fcfa: number;
    subscription_started_at: string | null;
    current_period_start: string | null;
    current_period_end: string | null;
    billing_cycle: 'monthly' | 'annual' | null;
    next_due_date: string | null;
    paid_current_period_fcfa: number;
  }>(sql`
    SELECT
      COALESCE(s.mrr_fcfa, 0)::int AS mrr_fcfa,
      s.created_at::text AS subscription_started_at,
      s.current_period_start::text AS current_period_start,
      s.current_period_end::text AS current_period_end,
      s.billing_cycle::text AS billing_cycle,
      s.current_period_end::text AS next_due_date,
      COALESCE((
        SELECT SUM(pe.amount_fcfa)::int
        FROM public.payment_events pe
        WHERE pe.subscription_id = s.id
          AND pe.status = 'success'
          AND pe.created_at >= s.current_period_start
          AND pe.created_at < (s.current_period_end + INTERVAL '1 day')
      ), 0)::int AS paid_current_period_fcfa
    FROM public.subscriptions s
    WHERE s.tenant_id = ${tenantId}
    ORDER BY s.created_at DESC
    LIMIT 1
  `);

  const row = getRows<{
    mrr_fcfa: number;
    subscription_started_at: string | null;
    current_period_start: string | null;
    current_period_end: string | null;
    billing_cycle: 'monthly' | 'annual' | null;
    next_due_date: string | null;
    paid_current_period_fcfa: number;
  }>(result)[0];
  const mrr = parseNumeric(row?.mrr_fcfa);
  const paidCurrentPeriodFcfa = parseNumeric(row?.paid_current_period_fcfa);
  return {
    mrrFcfa: mrr,
    subscriptionStartedAt: row?.subscription_started_at ?? null,
    currentPeriodStart: row?.current_period_start ?? null,
    currentPeriodEnd: row?.current_period_end ?? null,
    billingCycle: row?.billing_cycle ?? null,
    paidCurrentPeriodFcfa,
    remainingCurrentPeriodFcfa: Math.max(0, mrr - paidCurrentPeriodFcfa),
    nextDueDate: row?.next_due_date ?? null,
  };
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
  const trialEndsAt = payload.trial_days > 0 ? addDays(now, payload.trial_days) : null;
  const tenantStatus = payload.trial_days > 0 ? 'trial' : 'active';
  const subscriptionPeriodStart = trialEndsAt ?? now;
  const subscriptionPeriodEnd = addMonths(subscriptionPeriodStart, 1);

  const planRow = await publicDb.execute<{ max_users: number; max_admin_positions: number }>(sql`
    SELECT max_users, max_admin_positions
    FROM public.plan_catalog
    WHERE plan = ${payload.plan}
    LIMIT 1
  `);
  const planConfig = getRows<{ max_users: number; max_admin_positions: number }>(planRow)[0] ?? {
    max_users: 10,
    max_admin_positions: 5,
  };

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
      active_school_year,
      trial_ends_at
    )
    VALUES (
      ${payload.name},
      ${payload.subdomain},
      ${schemaName},
      ${payload.plan},
      ${tenantStatus}::tenant_status,
      ${payload.city},
      ${payload.teaching_type},
      ${planConfig.max_admin_positions},
      ${planConfig.max_users},
      ${payload.active_school_year},
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
        ${subscriptionPeriodStart},
        ${subscriptionPeriodEnd}
      )
    `);

    await ensureSchoolSmsFeatureMonetizationColumn(publicDb);
    await publicDb.execute(sql`
      INSERT INTO public.school_sms_features (
        tenant_id,
        is_enabled,
        commission_pct,
        sms_cap_per_student,
        monetize_parent_alerts,
        updated_at
      )
      VALUES (
        ${tenant.id},
        false,
        0,
        60,
        ${payload.monetizeParentAlerts},
        NOW()
      )
      ON CONFLICT (tenant_id)
      DO UPDATE SET
        monetize_parent_alerts = EXCLUDED.monetize_parent_alerts,
        updated_at = NOW()
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
  const page = query.page;
  const limit = query.limit;
  const offset = (page - 1) * limit;
  const plan = query.plan ?? null;
  const status = query.status ?? null;
  const search = query.search?.trim() ? query.search.trim() : null;

  const result = await publicDb.execute<SchoolListRow>(sql`
    WITH total AS (
      SELECT COUNT(*)::int AS cnt
      FROM public.tenants t
      WHERE (${plan}::text IS NULL OR t.plan::text = ${plan})
        AND (${status}::text IS NULL OR t.status::text = ${status})
        AND (${search}::text IS NULL OR t.name ILIKE '%' || ${search} || '%')
    )
    SELECT
      t.id,
      t.name,
      t.city,
      t.plan,
      t.status,
      0::int AS nb_users,
      COALESCE(s.mrr_fcfa, 0)::int AS mrr_fcfa,
      t.updated_at::text AS last_connection,
      total.cnt AS total_count
    FROM public.tenants t
    LEFT JOIN LATERAL (
      SELECT mrr_fcfa
      FROM public.subscriptions
      WHERE tenant_id = t.id
        AND status IN ('active', 'past_due')
      ORDER BY created_at DESC
      LIMIT 1
    ) s ON true
    CROSS JOIN total
    WHERE (${plan}::text IS NULL OR t.plan::text = ${plan})
      AND (${status}::text IS NULL OR t.status::text = ${status})
      AND (${search}::text IS NULL OR t.name ILIKE '%' || ${search} || '%')
    ORDER BY t.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const rows = getRows<SchoolListRow>(result);
  const total = rows[0]?.total_count ?? 0;

  return {
    schools: rows.map((row) => ({
      tenantId: row.id,
      name: row.name,
      city: row.city,
      plan: row.plan,
      status: row.status,
      nbUsers: parseNumeric(row.nb_users),
      lastConnection: row.last_connection,
      mrrFcfa: parseNumeric(row.mrr_fcfa),
    })),
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
      t.active_school_year,
      t.logo_url,
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

  const [usage, subscription, connectionHistory30d, lastPaymentReminderAt] = await Promise.all([
    getSchoolUsageMetrics(publicDb, tenant.schema_name),
    getSchoolSubscriptionSnapshot(publicDb, tenant.id),
    getSchoolConnectionHistory30d(publicDb, tenant.schema_name),
    getSchoolLastPaymentReminderAt(publicDb, tenant.schema_name),
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
      activeSchoolYear: tenant.active_school_year,
      logoUrl: tenant.logo_url,
      createdAt: formatDateTime(tenant.created_at) ?? new Date(0).toISOString(),
      updatedAt: formatDateTime(tenant.updated_at) ?? new Date(0).toISOString(),
    },
    usageStats: {
      nbUsers: usage.nbUsers,
      activeUsers7d: usage.activeUsers7d,
      teachersCount: usage.teachersCount,
      studentsCount: usage.studentsCount,
      attendanceRecords30d: usage.attendanceRecords30d,
      mrrFcfa: subscription.mrrFcfa,
      subscriptionStartedAt: subscription.subscriptionStartedAt,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
      billingCycle: subscription.billingCycle,
      paidCurrentPeriodFcfa: subscription.paidCurrentPeriodFcfa,
      remainingCurrentPeriodFcfa: subscription.remainingCurrentPeriodFcfa,
      nextDueDate: subscription.nextDueDate,
      lastPaymentReminderAt,
      lastConnection: usage.lastConnection,
    },
    connectionHistory30d,
  };
};

export const getSchoolUsers = async (
  publicDb: TenantDb,
  tenantId: string
): Promise<SchoolUsersResult> => {
  const toSchoolRole = (
    role: string
  ): 'director' | 'teacher' | 'staff' | null => {
    if (role === 'secretary' || role === 'staff') {
      return 'staff';
    }
    if (role === 'director' || role === 'teacher') {
      return role;
    }
    return null;
  };

  const tenantResult = await publicDb.execute<TenantLookupRow>(sql`
    SELECT id, schema_name
    FROM public.tenants
    WHERE id = ${tenantId}
    LIMIT 1
  `);
  const tenant = getRows<TenantLookupRow>(tenantResult)[0];
  if (!tenant) {
    throw new Error('Tenant not found');
  }

  const rows = await withTenantSchema(tenant.schema_name, async (tenantDb) => {
    const result = await tenantDb.execute<SchoolUserRow>(sql`
      SELECT
        u.id::text,
        u.role::text,
        u.name,
        u.phone,
        u.email,
        t.username,
        COALESCE(ARRAY_REMOVE(ARRAY_AGG(DISTINCT ap.name), NULL), '{}')::text[] AS positions,
        u.last_login_at::text,
        u.is_active
      FROM users u
      LEFT JOIN teachers t ON t.user_id = u.id
      LEFT JOIN position_assignments pa ON pa.user_id = u.id
      LEFT JOIN admin_positions ap ON ap.id = pa.position_id
      WHERE u.role <> 'super_admin'
      GROUP BY u.id, u.role, u.name, u.phone, u.email, t.username, u.last_login_at, u.is_active
      ORDER BY u.role ASC, u.name ASC
    `);
    return getRows<SchoolUserRow>(result);
  });

  const mapped = rows
    .map((row) => {
      const role = toSchoolRole(row.role);
      if (!role) {
        return null;
      }
      return {
        id: row.id,
        role,
        name: row.name,
        phone: row.phone,
        email: row.email,
        username: row.username,
        positions: row.positions ?? [],
        lastLoginAt: row.last_login_at,
        isActive: row.is_active,
      };
    })
    .filter((item): item is SchoolUsersResult['staff'][number] => item !== null);

  const director = mapped.find((item) => item.role === 'director') ?? null;
  const staff = mapped.filter((item) => item.role === 'staff');
  const teachers = mapped.filter((item) => item.role === 'teacher');

  return { director, staff, teachers };
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
      name = CASE WHEN ${payload.name !== undefined} THEN ${payload.name ?? null} ELSE name END,
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
      active_school_year = CASE WHEN ${payload.active_school_year !== undefined}
        THEN ${payload.active_school_year ?? null}
        ELSE active_school_year END,
      logo_url = CASE WHEN ${payload.logo_url !== undefined}
        THEN ${payload.logo_url ?? null}
        ELSE logo_url END,
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
      t.active_school_year,
      t.logo_url,
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

export const listPlanCatalog = async (publicDb: TenantDb): Promise<PlanCatalogItem[]> => {
  await ensureAdminPublicInfrastructure(publicDb);
  const result = await publicDb.execute<PlanCatalogRow>(sql`
    SELECT
      plan::text AS plan,
      monthly_price_fcfa,
      max_users,
      max_admin_positions,
      updated_at::text
    FROM public.plan_catalog
    ORDER BY plan ASC
  `);

  return getRows<PlanCatalogRow>(result).map((row) => ({
    plan: row.plan,
    monthlyPriceFcfa: parseNumeric(row.monthly_price_fcfa),
    maxUsers: parseNumeric(row.max_users),
    maxAdminPositions: parseNumeric(row.max_admin_positions),
    updatedAt: row.updated_at,
  }));
};

export const updatePlanCatalog = async (
  publicDb: TenantDb,
  plan: TenantListItem['plan'],
  payload: UpdatePlanCatalogBody
): Promise<void> => {
  await ensureAdminPublicInfrastructure(publicDb);
  await publicDb.execute(sql`
    INSERT INTO public.plan_catalog (
      plan,
      monthly_price_fcfa,
      max_users,
      max_admin_positions,
      updated_at
    )
    VALUES (
      ${plan},
      ${payload.monthly_price_fcfa ?? 0},
      ${payload.max_users ?? 10},
      ${payload.max_admin_positions ?? 5},
      NOW()
    )
    ON CONFLICT (plan)
    DO UPDATE SET
      monthly_price_fcfa = CASE WHEN ${payload.monthly_price_fcfa !== undefined} THEN ${payload.monthly_price_fcfa ?? null}::integer ELSE plan_catalog.monthly_price_fcfa END,
      max_users = CASE WHEN ${payload.max_users !== undefined} THEN ${payload.max_users ?? null}::integer ELSE plan_catalog.max_users END,
      max_admin_positions = CASE WHEN ${payload.max_admin_positions !== undefined} THEN ${payload.max_admin_positions ?? null}::integer ELSE plan_catalog.max_admin_positions END,
      updated_at = NOW()
  `);
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

export const listAllRecentPayments = async (
  publicDb: TenantDb,
  tenantId?: string
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
    INNER JOIN public.tenants t ON t.id = s.tenant_id
    WHERE (
      (${tenantId ?? null}::uuid IS NOT NULL AND s.tenant_id = ${tenantId ?? null})
      OR (${tenantId ?? null}::uuid IS NULL AND t.status = 'active')
    )
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
  let subscriptionId = getRows<{ id: string }>(subscriptionResult)[0]?.id;

  if (!subscriptionId) {
    const now = new Date();
    const nextMonth = new Date(now);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);

    const createSubscriptionResult = await publicDb.execute<{ id: string }>(sql`
      INSERT INTO public.subscriptions (
        tenant_id,
        status,
        mrr_fcfa,
        billing_cycle,
        current_period_start,
        current_period_end
      )
      VALUES (
        ${tenantId},
        'active',
        0,
        'monthly',
        ${now},
        ${nextMonth}
      )
      RETURNING id
    `);

    subscriptionId = getRows<{ id: string }>(createSubscriptionResult)[0]?.id;
  }

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

const toDateLabel = (value: string | null): string => {
  if (!value) {
    return 'N/A';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return 'N/A';
  }

  return parsed.toISOString().slice(0, 10);
};

export const sendSchoolPaymentReminder = async (
  publicDb: TenantDb,
  tenantId: string
): Promise<SchoolPaymentReminderResult> => {
  const tenant = await getTenantById(publicDb, tenantId);
  if (tenant.status === 'suspended' || tenant.status === 'cancelled') {
    throw new Error("Relance SMS indisponible: l'école est suspendue ou annulée");
  }

  const subscription = await getSchoolSubscriptionSnapshot(publicDb, tenantId);

  if (!subscription.nextDueDate || subscription.remainingCurrentPeriodFcfa <= 0) {
    throw new Error('Aucune relance requise pour cette école');
  }

  const dueDate = new Date(subscription.nextDueDate);
  if (Number.isNaN(dueDate.getTime())) {
    throw new Error('Date d’échéance invalide');
  }

  if (dueDate.getTime() > Date.now()) {
    throw new Error('Relance indisponible: échéance non dépassée');
  }

  const contact = await getSchoolContactForPaymentReminder(publicDb, tenant.schema_name);
  if (!contact?.phone) {
    throw new Error("Impossible d'envoyer la relance: aucun numéro responsable disponible");
  }

  const periodLabel = `${toDateLabel(subscription.currentPeriodStart)} -> ${toDateLabel(subscription.currentPeriodEnd)}`;

  emit('subscription.expired', {
    tenantId: tenant.id,
    schemaName: tenant.schema_name,
    schoolName: tenant.name ?? 'École',
    periodLabel,
    dueDate: toDateLabel(subscription.nextDueDate),
    remainingAmountFcfa: subscription.remainingCurrentPeriodFcfa,
    directorPhone: contact.phone,
    directorEmail: contact.email,
  });

  return {
    sentAt: new Date().toISOString(),
    recipientPhone: contact.phone,
  };
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
    try {
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
          '${tenant.id}'::text AS tenant_id,
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
    } catch {
      bySchool.push({
        tenant_id: tenant.id,
        school: tenant.name,
        sent: 0,
        quota: tenant.max_sms_per_month,
        used_pct: 0,
      });
    }
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
      tenantId: row.tenant_id,
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
    SELECT DISTINCT ON (type)
      id::text,
      tenant_id::text,
      type::text,
      message_template,
      variables,
      updated_at
    FROM public.sms_templates
    WHERE (${tenantId ?? null}::uuid IS NULL AND tenant_id IS NULL)
       OR (${tenantId ?? null}::uuid IS NOT NULL AND tenant_id = ${tenantId ?? null}::uuid)
    ORDER BY type ASC, updated_at DESC
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
  if (params.tenantId === null) {
    const updateResult = await publicDb.execute(sql`
      UPDATE public.sms_templates
      SET
        message_template = ${params.body.message_template},
        variables = ${toTextArraySql(params.body.variables)},
        updated_at = NOW(),
        created_by = COALESCE(${params.adminId ?? null}::uuid, created_by)
      WHERE tenant_id IS NULL
        AND type = ${params.type}
    `);

    if ((updateResult.rowCount ?? 0) === 0) {
      await publicDb.execute(sql`
        INSERT INTO public.sms_templates (tenant_id, type, message_template, variables, created_by, updated_at)
        VALUES (
          NULL,
          ${params.type},
          ${params.body.message_template},
          ${toTextArraySql(params.body.variables)},
          ${params.adminId ?? null},
          NOW()
        )
      `);
    }

    return;
  }

  const updateResult = await publicDb.execute(sql`
    UPDATE public.sms_templates
    SET
      message_template = ${params.body.message_template},
      variables = ${toTextArraySql(params.body.variables)},
      updated_at = NOW(),
      created_by = COALESCE(${params.adminId ?? null}::uuid, created_by)
    WHERE tenant_id = ${params.tenantId}::uuid
      AND type = ${params.type}
  `);

  if ((updateResult.rowCount ?? 0) === 0) {
    await publicDb.execute(sql`
      INSERT INTO public.sms_templates (tenant_id, type, message_template, variables, created_by, updated_at)
      VALUES (
        ${params.tenantId}::uuid,
        ${params.type},
        ${params.body.message_template},
        ${toTextArraySql(params.body.variables)},
        ${params.adminId ?? null},
        NOW()
      )
    `);
  }
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

export const getSmsPlatformConfig = async (
  publicDb: TenantDb
): Promise<SmsPlatformConfigResult> => {
  await ensureAdminPublicInfrastructure(publicDb);
  const result = await publicDb.execute<SmsPlatformConfigRow>(sql`
    SELECT
      sms_provider,
      sms_api_base_url,
      sms_api_key_last4,
      sms_api_key_updated_at::text,
      sms_sender_id,
      sms_fallback_sender_id,
      sms_default_country_code,
      sms_alert_quota_threshold_pct,
      sms_alert_failure_threshold_count,
      sms_alert_email,
      sms_maintenance_mode,
      sms_maintenance_message,
      updated_at::text
    FROM public.app_settings
    ORDER BY updated_at DESC
    LIMIT 1
  `);
  const row = getRows<SmsPlatformConfigRow>(result)[0];
  return {
    provider: row?.sms_provider ?? 'mock',
    apiBaseUrl: row?.sms_api_base_url ?? null,
    hasApiKey: Boolean(row?.sms_api_key_last4),
    apiKeyLast4: row?.sms_api_key_last4 ?? null,
    apiKeyUpdatedAt: row?.sms_api_key_updated_at ?? null,
    senderId: row?.sms_sender_id ?? 'EduTrack',
    fallbackSenderId: row?.sms_fallback_sender_id ?? null,
    defaultCountryCode: row?.sms_default_country_code ?? '+225',
    alertQuotaThresholdPct: row?.sms_alert_quota_threshold_pct ?? 80,
    alertFailureThresholdCount: row?.sms_alert_failure_threshold_count ?? 5,
    alertEmail: row?.sms_alert_email ?? null,
    smsMaintenanceMode: row?.sms_maintenance_mode ?? false,
    smsMaintenanceMessage: row?.sms_maintenance_message ?? 'Service SMS en maintenance',
    updatedAt: row?.updated_at ?? new Date().toISOString(),
  };
};

export const updateSmsPlatformConfig = async (
  publicDb: TenantDb,
  payload: UpdateSmsPlatformConfigBody,
  adminId?: string
): Promise<void> => {
  await ensureAdminPublicInfrastructure(publicDb);

  let apiKeyLast4: string | null = null;
  if (payload.api_key !== undefined) {
    const compact = payload.api_key.trim();
    apiKeyLast4 = compact.slice(-4);
  }

  await publicDb.execute(sql`
    UPDATE public.app_settings
    SET
      sms_provider = CASE WHEN ${payload.provider !== undefined} THEN ${payload.provider ?? null}::varchar(50) ELSE sms_provider END,
      sms_api_base_url = CASE WHEN ${payload.api_base_url !== undefined} THEN ${payload.api_base_url ?? null}::varchar(255) ELSE sms_api_base_url END,
      sms_api_key = CASE WHEN ${payload.api_key !== undefined} THEN ${payload.api_key ?? null}::text ELSE sms_api_key END,
      sms_api_key_last4 = CASE WHEN ${payload.api_key !== undefined} THEN ${apiKeyLast4}::varchar(4) ELSE sms_api_key_last4 END,
      sms_api_key_updated_at = CASE WHEN ${payload.api_key !== undefined} THEN NOW() ELSE sms_api_key_updated_at END,
      sms_sender_id = CASE WHEN ${payload.sender_id !== undefined} THEN ${payload.sender_id ?? null}::varchar(20) ELSE sms_sender_id END,
      sms_fallback_sender_id = CASE WHEN ${payload.fallback_sender_id !== undefined} THEN ${payload.fallback_sender_id ?? null}::varchar(20) ELSE sms_fallback_sender_id END,
      sms_default_country_code = CASE WHEN ${payload.default_country_code !== undefined} THEN ${payload.default_country_code ?? null}::varchar(8) ELSE sms_default_country_code END,
      sms_alert_quota_threshold_pct = CASE WHEN ${payload.alert_quota_threshold_pct !== undefined} THEN ${payload.alert_quota_threshold_pct ?? null}::integer ELSE sms_alert_quota_threshold_pct END,
      sms_alert_failure_threshold_count = CASE WHEN ${payload.alert_failure_threshold_count !== undefined} THEN ${payload.alert_failure_threshold_count ?? null}::integer ELSE sms_alert_failure_threshold_count END,
      sms_alert_email = CASE WHEN ${payload.alert_email !== undefined} THEN ${payload.alert_email ?? null}::varchar(255) ELSE sms_alert_email END,
      sms_maintenance_mode = CASE WHEN ${payload.sms_maintenance_mode !== undefined} THEN ${payload.sms_maintenance_mode ?? null}::boolean ELSE sms_maintenance_mode END,
      sms_maintenance_message = CASE WHEN ${payload.sms_maintenance_message !== undefined} THEN ${payload.sms_maintenance_message ?? null}::text ELSE sms_maintenance_message END,
      updated_at = NOW()
    WHERE id = (SELECT id FROM public.app_settings ORDER BY updated_at DESC LIMIT 1)
  `);

  await publicDb.execute(sql`
    INSERT INTO public.sms_admin_audit_log (admin_id, action, details)
    VALUES (
      ${adminId ?? null},
      'sms_platform_config_updated',
      ${JSON.stringify({
        fields: Object.keys(payload),
      })}::jsonb
    )
  `);
};

export const listSmsPlatformAudit = async (
  publicDb: TenantDb,
  limit = 50
): Promise<SmsPlatformAuditItem[]> => {
  await ensureAdminPublicInfrastructure(publicDb);
  const result = await publicDb.execute<SmsPlatformAuditRow>(sql`
    SELECT id::text, action::text, admin_id::text, created_at::text, details
    FROM public.sms_admin_audit_log
    ORDER BY created_at DESC
    LIMIT ${limit}
  `);
  return getRows<SmsPlatformAuditRow>(result).map((row) => ({
    id: row.id,
    action: row.action,
    adminId: row.admin_id,
    createdAt: row.created_at,
    details: toRecord(row.details),
  }));
};

const monthStart = (month: string): string => `${month}-01`;
const monthFromDate = (date: Date): string =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;

const getTenantSmsFeatureConfig = async (
  publicDb: TenantDb,
  tenantId: string
): Promise<SchoolSmsFeatureConfigResult | null> => {
  await ensureSchoolSmsFeatureMonetizationColumn(publicDb);
  const result = await publicDb.execute<{
    is_enabled: boolean;
    commission_pct: string | number;
    sms_cap_per_student: number;
    monetize_parent_alerts: boolean;
    use_real_hours: boolean;
    geo_check_enabled: boolean;
  }>(sql`
    SELECT
      is_enabled,
      commission_pct,
      sms_cap_per_student,
      COALESCE(monetize_parent_alerts, false) AS monetize_parent_alerts,
      COALESCE(use_real_hours, false) AS use_real_hours,
      COALESCE(geo_check_enabled, false) AS geo_check_enabled
    FROM public.school_sms_features
    WHERE tenant_id = ${tenantId}::uuid
    LIMIT 1
  `);

  const row = getRows<{
    is_enabled: boolean;
    commission_pct: string | number;
    sms_cap_per_student: number;
    monetize_parent_alerts: boolean;
    use_real_hours: boolean;
    geo_check_enabled: boolean;
  }>(result)[0];
  if (!row) {
    return null;
  }

  return {
    is_enabled: row.is_enabled,
    commission_pct: parseNumeric(row.commission_pct),
    sms_cap_per_student: row.sms_cap_per_student,
    monetize_parent_alerts: row.monetize_parent_alerts,
    use_real_hours: row.use_real_hours,
    geo_check_enabled: row.geo_check_enabled,
  };
};

const ensureSchoolSmsFeatureMonetizationColumn = async (publicDb: TenantDb): Promise<void> => {
  await publicDb.execute(sql`
    ALTER TABLE public.school_sms_features
    ADD COLUMN IF NOT EXISTS monetize_parent_alerts boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS use_real_hours boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS geo_check_enabled boolean NOT NULL DEFAULT false
  `);
};

export const activateSchoolSmsFeature = async (
  publicDb: TenantDb,
  tenantId: string,
  payload: { commission_pct: number },
  adminId?: string
): Promise<{ is_enabled: boolean; commission_pct: number; activated_at: string }> => {
  await ensureAdminPublicInfrastructure(publicDb);
  await getTenantById(publicDb, tenantId);

  const result = await publicDb.execute<{
    is_enabled: boolean;
    commission_pct: string | number;
    activated_at: string;
  }>(sql`
    INSERT INTO public.school_sms_features (
      tenant_id, is_enabled, commission_pct, activated_at, activated_by, updated_at
    )
    VALUES (${tenantId}::uuid, true, ${payload.commission_pct}, NOW(), ${adminId ?? null}::uuid, NOW())
    ON CONFLICT (tenant_id)
    DO UPDATE SET
      is_enabled = true,
      commission_pct = EXCLUDED.commission_pct,
      activated_at = NOW(),
      activated_by = EXCLUDED.activated_by,
      updated_at = NOW()
    RETURNING is_enabled, commission_pct, activated_at::text
  `);
  const row = getRows<{
    is_enabled: boolean;
    commission_pct: string | number;
    activated_at: string;
  }>(result)[0]!;
  return {
    is_enabled: row.is_enabled,
    commission_pct: parseNumeric(row.commission_pct),
    activated_at: row.activated_at,
  };
};

export const deactivateSchoolSmsFeature = async (
  publicDb: TenantDb,
  tenantId: string
): Promise<{ is_enabled: boolean }> => {
  await ensureAdminPublicInfrastructure(publicDb);
  await getTenantById(publicDb, tenantId);

  await publicDb.execute(sql`
    INSERT INTO public.school_sms_features (tenant_id, is_enabled, commission_pct, updated_at)
    VALUES (${tenantId}::uuid, false, 0, NOW())
    ON CONFLICT (tenant_id)
    DO UPDATE SET
      is_enabled = false,
      updated_at = NOW()
  `);

  return { is_enabled: false };
};

export const updateSchoolSmsFeatureConfig = async (
  publicDb: TenantDb,
  tenantId: string,
  payload: {
    commission_pct?: number;
    sms_cap_per_student?: number;
    monetizeParentAlerts?: boolean;
    useRealHours?: boolean;
    geoCheckEnabled?: boolean;
  },
  audit?: { actorId?: string | null; actorRole?: string | null }
): Promise<SchoolSmsFeatureConfigResult> => {
  await ensureAdminPublicInfrastructure(publicDb);
  await getTenantById(publicDb, tenantId);
  const before = await getTenantSmsFeatureConfig(publicDb, tenantId);

  await publicDb.execute(sql`
    INSERT INTO public.school_sms_features (
      tenant_id, is_enabled, commission_pct, sms_cap_per_student, monetize_parent_alerts,
      use_real_hours, geo_check_enabled, updated_at
    )
    VALUES (
      ${tenantId}::uuid,
      false,
      ${payload.commission_pct ?? 0},
      ${payload.sms_cap_per_student ?? 60},
      ${payload.monetizeParentAlerts ?? false},
      ${payload.useRealHours ?? false},
      ${payload.geoCheckEnabled ?? false},
      NOW()
    )
    ON CONFLICT (tenant_id)
    DO UPDATE SET
      commission_pct = CASE
        WHEN ${payload.commission_pct !== undefined}
          THEN ${payload.commission_pct ?? 0}
        ELSE public.school_sms_features.commission_pct
      END,
      sms_cap_per_student = CASE
        WHEN ${payload.sms_cap_per_student !== undefined}
          THEN ${payload.sms_cap_per_student ?? 60}
        ELSE public.school_sms_features.sms_cap_per_student
      END,
      monetize_parent_alerts = CASE
        WHEN ${payload.monetizeParentAlerts !== undefined}
          THEN ${payload.monetizeParentAlerts ?? false}
        ELSE public.school_sms_features.monetize_parent_alerts
      END,
      use_real_hours = CASE
        WHEN ${payload.useRealHours !== undefined}
          THEN ${payload.useRealHours ?? false}
        ELSE public.school_sms_features.use_real_hours
      END,
      geo_check_enabled = CASE
        WHEN ${payload.geoCheckEnabled !== undefined}
          THEN ${payload.geoCheckEnabled ?? false}
        ELSE public.school_sms_features.geo_check_enabled
      END,
      updated_at = NOW()
  `);

  const config = await getTenantSmsFeatureConfig(publicDb, tenantId);
  const resolved = (
    config ?? {
      is_enabled: false,
      commission_pct: payload.commission_pct ?? 0,
      sms_cap_per_student: payload.sms_cap_per_student ?? 60,
      monetize_parent_alerts: payload.monetizeParentAlerts ?? false,
      use_real_hours: payload.useRealHours ?? false,
      geo_check_enabled: payload.geoCheckEnabled ?? false,
    }
  );

  if (payload.monetizeParentAlerts !== undefined) {
    await publicDb.execute(sql`
      INSERT INTO public.audit_financial_events (
        tenant_id,
        actor_id,
        actor_role,
        action,
        payload_before,
        payload_after
      )
      VALUES (
        ${tenantId}::uuid,
        ${audit?.actorId ?? null}::uuid,
        ${audit?.actorRole ?? 'super_admin'},
        'update_monetize_parent_alerts',
        ${before ? JSON.stringify({ value: before.monetize_parent_alerts }) : null}::jsonb,
        ${JSON.stringify({ value: payload.monetizeParentAlerts })}::jsonb
      )
    `);
  }

  if (payload.useRealHours !== undefined || payload.geoCheckEnabled !== undefined) {
    await publicDb.execute(sql`
      INSERT INTO public.audit_financial_events (
        tenant_id,
        actor_id,
        actor_role,
        action,
        payload_before,
        payload_after
      )
      VALUES (
        ${tenantId}::uuid,
        ${audit?.actorId ?? null}::uuid,
        ${audit?.actorRole ?? 'super_admin'},
        'update_school_features',
        ${before ? JSON.stringify({
          use_real_hours: before.use_real_hours,
          geo_check_enabled: before.geo_check_enabled,
        }) : null}::jsonb,
        ${JSON.stringify({
          use_real_hours: resolved.use_real_hours,
          geo_check_enabled: resolved.geo_check_enabled,
        })}::jsonb
      )
    `);
  }

  return resolved;
};

export const syncSchoolSmsCommission = async (
  publicDb: TenantDb,
  tenantId: string,
  month: string,
  actor?: { actorId: string | null; actorRole: string }
): Promise<{
  tenant_id: string;
  period_month: string;
  total_subscriptions_fcfa: number;
  commission_pct: number;
  commission_due_fcfa: number;
  commission_paid_fcfa: number;
}> => {
  const tenant = await getTenantById(publicDb, tenantId);
  const config = await getTenantSmsFeatureConfig(publicDb, tenantId);
  const commissionPct = config?.commission_pct ?? 0;

  const revenue = await withTenantSchema(tenant.schema_name, async (tenantDb) => {
    const repository = new SubscriptionsRepository(tenantDb);
    return repository.computeMonthlyRevenue(month);
  });

  const total = revenue.total_subscriptions_fcfa;
  const due = Math.round((total * commissionPct) / 100);
  const periodMonth = monthStart(month);
  const beforeResult = await publicDb.execute<{
    period_month: string;
    total_subscriptions_fcfa: number;
    commission_pct: string | number;
    commission_due_fcfa: number;
    commission_paid_fcfa: number;
  }>(sql`
    SELECT
      period_month::text,
      total_subscriptions_fcfa,
      commission_pct,
      commission_due_fcfa,
      commission_paid_fcfa
    FROM public.edutrack_commission_records
    WHERE tenant_id = ${tenantId}::uuid
      AND period_month = ${periodMonth}::date
    LIMIT 1
  `);
  const beforeRow = getRows<{
    period_month: string;
    total_subscriptions_fcfa: number;
    commission_pct: string | number;
    commission_due_fcfa: number;
    commission_paid_fcfa: number;
  }>(beforeResult)[0] ?? null;

  const result = await publicDb.execute<{
    tenant_id: string;
    period_month: string;
    total_subscriptions_fcfa: number;
    commission_pct: string | number;
    commission_due_fcfa: number;
    commission_paid_fcfa: number;
  }>(sql`
    INSERT INTO public.edutrack_commission_records (
      tenant_id,
      period_month,
      total_subscriptions_fcfa,
      commission_pct,
      commission_due_fcfa,
      commission_paid_fcfa,
      created_at,
      updated_at
    )
    VALUES (
      ${tenantId}::uuid,
      ${periodMonth}::date,
      ${total},
      ${commissionPct},
      ${due},
      0,
      NOW(),
      NOW()
    )
    ON CONFLICT (tenant_id, period_month)
    DO UPDATE SET
      total_subscriptions_fcfa = EXCLUDED.total_subscriptions_fcfa,
      commission_pct = EXCLUDED.commission_pct,
      commission_due_fcfa = EXCLUDED.commission_due_fcfa,
      updated_at = NOW()
    RETURNING
      tenant_id::text,
      period_month::text,
      total_subscriptions_fcfa,
      commission_pct,
      commission_due_fcfa,
      commission_paid_fcfa
  `);

  const row = getRows<{
    tenant_id: string;
    period_month: string;
    total_subscriptions_fcfa: number;
    commission_pct: string | number;
    commission_due_fcfa: number;
    commission_paid_fcfa: number;
  }>(result)[0]!;
  const payloadAfter = {
    tenant_id: row.tenant_id,
    period_month: row.period_month,
    total_subscriptions_fcfa: row.total_subscriptions_fcfa,
    commission_pct: parseNumeric(row.commission_pct),
    commission_due_fcfa: row.commission_due_fcfa,
    commission_paid_fcfa: row.commission_paid_fcfa,
  };

  await publicDb.execute(sql`
    INSERT INTO public.audit_financial_events (
      tenant_id,
      actor_id,
      actor_role,
      action,
      payload_before,
      payload_after
    )
    VALUES (
      ${tenantId}::uuid,
      ${actor?.actorId ?? null}::uuid,
      ${actor?.actorRole ?? 'system'},
      ${'admin.sync_commission'},
      ${beforeRow ? JSON.stringify(beforeRow) : null}::jsonb,
      ${JSON.stringify(payloadAfter)}::jsonb
    )
  `);

  return payloadAfter;
};

export const recordSchoolCommissionReceived = async (
  publicDb: TenantDb,
  tenantId: string,
  payload: {
    period_month: string;
    amount_fcfa: number;
    payment_method?: 'cash' | 'momo_mtn' | 'momo_orange' | 'bank_transfer';
    notes?: string;
    idempotency_key: string;
  },
  actor: { actorId: string | null; actorRole: string }
): Promise<{
  period_month: string;
  commission_due_fcfa: number;
  commission_paid_fcfa: number;
  commission_remaining_fcfa: number;
  overpaid: boolean;
  idempotency_replayed: boolean;
}> => {
  const periodMonth = monthStart(payload.period_month);
  const action = 'admin.record_commission_received';
  await syncSchoolSmsCommission(publicDb, tenantId, payload.period_month, actor);

  return publicDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${action}:${tenantId}:${payload.idempotency_key}`}))`);

    const replay = await tx.execute<{ payload_after: unknown }>(sql`
      SELECT payload_after
      FROM public.audit_financial_events
      WHERE action = ${action}
        AND tenant_id = ${tenantId}::uuid
        AND idempotency_key = ${payload.idempotency_key}::uuid
      LIMIT 1
    `);
    const replayRow = getRows<{ payload_after: unknown }>(replay)[0];
    if (replayRow?.payload_after && typeof replayRow.payload_after === 'object') {
      return {
        ...(replayRow.payload_after as {
          period_month: string;
          commission_due_fcfa: number;
          commission_paid_fcfa: number;
          commission_remaining_fcfa: number;
          overpaid: boolean;
        }),
        idempotency_replayed: true,
      };
    }

    const beforeResult = await tx.execute<{
      period_month: string;
      commission_due_fcfa: number;
      commission_paid_fcfa: number;
    }>(sql`
      SELECT period_month::text, commission_due_fcfa, commission_paid_fcfa
      FROM public.edutrack_commission_records
      WHERE tenant_id = ${tenantId}::uuid
        AND period_month = ${periodMonth}::date
      LIMIT 1
    `);
    const beforeRow = getRows<{
      period_month: string;
      commission_due_fcfa: number;
      commission_paid_fcfa: number;
    }>(beforeResult)[0] ?? null;

    const result = await tx.execute<{
      period_month: string;
      commission_due_fcfa: number;
      commission_paid_fcfa: number;
    }>(sql`
      UPDATE public.edutrack_commission_records
      SET
        commission_paid_fcfa = commission_paid_fcfa + ${payload.amount_fcfa},
        last_payment_at = NOW(),
        notes = COALESCE(${payload.notes ?? null}, notes),
        updated_at = NOW()
      WHERE tenant_id = ${tenantId}::uuid
        AND period_month = ${periodMonth}::date
      RETURNING period_month::text, commission_due_fcfa, commission_paid_fcfa
    `);

    const row = getRows<{
      period_month: string;
      commission_due_fcfa: number;
      commission_paid_fcfa: number;
    }>(result)[0]!;
    const remaining = Math.max(0, row.commission_due_fcfa - row.commission_paid_fcfa);
    const overpaid = row.commission_paid_fcfa > row.commission_due_fcfa;
    const payloadAfter = {
      period_month: row.period_month,
      commission_due_fcfa: row.commission_due_fcfa,
      commission_paid_fcfa: row.commission_paid_fcfa,
      commission_remaining_fcfa: remaining,
      overpaid,
      amount_fcfa: payload.amount_fcfa,
      payment_method: payload.payment_method ?? null,
      notes: payload.notes ?? null,
    };

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
        ${tenantId}::uuid,
        ${actor.actorId}::uuid,
        ${actor.actorRole},
        ${action},
        ${payload.idempotency_key}::uuid,
        ${beforeRow ? JSON.stringify(beforeRow) : null}::jsonb,
        ${JSON.stringify(payloadAfter)}::jsonb
      )
    `);

    return { ...payloadAfter, idempotency_replayed: false };
  });
};

export const listSchoolCommissionPayments = async (
  publicDb: TenantDb,
  tenantId: string,
  month?: string
): Promise<
  Array<{
    id: string;
    period_month: string;
    amount_fcfa: number;
    payment_method: string | null;
    notes: string | null;
    created_at: string;
  }>
> => {
  const targetMonth = month ?? monthFromDate(new Date());
  const result = await publicDb.execute<{
    id: string;
    period_month: string;
    amount_fcfa: number;
    payment_method: string | null;
    notes: string | null;
    created_at: string;
  }>(sql`
    SELECT
      id::text AS id,
      payload_after->>'period_month' AS period_month,
      COALESCE((payload_after->>'amount_fcfa')::int, 0) AS amount_fcfa,
      payload_after->>'payment_method' AS payment_method,
      payload_after->>'notes' AS notes,
      created_at::text AS created_at,
      payload_before,
      payload_after
    FROM public.audit_financial_events
    WHERE action = 'admin.record_commission_received'
      AND tenant_id = ${tenantId}::uuid
      AND LEFT(COALESCE(payload_after->>'period_month', ''), 7) = ${targetMonth}
    ORDER BY created_at DESC
  `);
  const rows = getRows<{
    id: string;
    period_month: string;
    amount_fcfa: number;
    payment_method: string | null;
    notes: string | null;
    created_at: string;
    payload_before?: unknown;
    payload_after?: unknown;
  }>(result);

  const mapped = rows.map((row) => {
    if (row.amount_fcfa > 0) {
      return row;
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
      ...row,
      amount_fcfa: fallbackAmount,
    };
  });

  const ascByCreatedAt = [...rows].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
  const firstRow = ascByCreatedAt[0];
  const firstBefore =
    typeof firstRow?.payload_before === 'object' && firstRow.payload_before !== null
      ? Number((firstRow.payload_before as { commission_paid_fcfa?: number }).commission_paid_fcfa ?? 0)
      : 0;
  if (firstBefore > 0) {
    return [
      ...mapped,
      {
        id: `opening-${tenantId}-${targetMonth}`,
        period_month: targetMonth,
        amount_fcfa: firstBefore,
        payment_method: null,
        notes: 'Solde reporté (reversements antérieurs)',
        created_at: firstRow?.created_at ?? `${targetMonth}-01T00:00:00.000Z`,
      },
    ];
  }

  return mapped;
};

export const getSchoolSmsFeatureStats = async (
  publicDb: TenantDb,
  tenantId: string
): Promise<{
  config: SchoolSmsFeatureConfigResult;
  current_month: {
    subscriptions_active: number;
    subscriptions_new: number;
    total_collected_fcfa: number;
    commission_due_fcfa: number;
    commission_paid_fcfa: number;
    commission_remaining_fcfa: number;
  };
  history: Array<{
    month: string;
    subscriptions_active: number;
    subscriptions_new: number;
    total_collected_fcfa: number;
    commission_due_fcfa: number;
    commission_paid_fcfa: number;
    commission_remaining_fcfa: number;
  }>;
  sms_sent_this_month: number;
}> => {
  const tenant = await getTenantById(publicDb, tenantId);
  const config =
    (await getTenantSmsFeatureConfig(publicDb, tenantId)) ?? {
      is_enabled: false,
      commission_pct: 0,
      sms_cap_per_student: 60,
      monetize_parent_alerts: false,
      use_real_hours: false,
      geo_check_enabled: false,
    };
  const currentMonth = monthFromDate(new Date());

  const [currentMonthStats, history, smsSentThisMonth] = await withTenantSchema(
    tenant.schema_name,
    async (tenantDb) => {
      const repo = new SubscriptionsRepository(tenantDb);
      const current = await repo.getRevenueSummary({ tenantId, month: currentMonth });
      const due = Math.round((current.total_collected_fcfa * EDUTRACK_COMMISSION_PCT) / 100);
      const currentStats = {
        subscriptions_active: current.subscriptions_active_count,
        subscriptions_new: current.subscriptions_new_this_month,
        total_collected_fcfa: current.total_collected_fcfa,
        commission_due_fcfa: due,
        commission_paid_fcfa: current.commission_paid_fcfa,
        commission_remaining_fcfa: Math.max(0, due - current.commission_paid_fcfa),
      };

      const historyItems: Array<{
        month: string;
        subscriptions_active: number;
        subscriptions_new: number;
        total_collected_fcfa: number;
        commission_due_fcfa: number;
        commission_paid_fcfa: number;
        commission_remaining_fcfa: number;
      }> = [];
      for (let i = 0; i < 12; i += 1) {
        const date = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - i, 1));
        const month = monthFromDate(date);
        const summary = await repo.getRevenueSummary({ tenantId, month });
        const commissionDue = Math.round((summary.total_collected_fcfa * EDUTRACK_COMMISSION_PCT) / 100);
        historyItems.push({
          month,
          subscriptions_active: summary.subscriptions_active_count,
          subscriptions_new: summary.subscriptions_new_this_month,
          total_collected_fcfa: summary.total_collected_fcfa,
          commission_due_fcfa: commissionDue,
          commission_paid_fcfa: summary.commission_paid_fcfa,
          commission_remaining_fcfa: Math.max(0, commissionDue - summary.commission_paid_fcfa),
        });
      }

      const smsResult = await tenantDb.execute<{ total: string | number }>(sql`
        SELECT COALESCE(SUM(sms_sent_count), 0) AS total
        FROM sms_usage_log
        WHERE month = ${currentMonth}
      `);

      return [
        currentStats,
        historyItems,
        Math.round(parseNumeric(getRows<{ total: string | number }>(smsResult)[0]?.total ?? 0)),
      ] as const;
    }
  );

  return {
    config,
    current_month: currentMonthStats,
    history,
    sms_sent_this_month: smsSentThisMonth,
  };
};

export const getSmsFeatureGlobalStats = async (
  publicDb: TenantDb,
  month?: string
): Promise<
  Array<{
    school_name: string;
    tenant_id: string;
    subscriptions_active: number;
    total_collected_fcfa: number;
    sms_sent_this_month: number;
    commission_remaining_fcfa: number;
    is_overdue: boolean;
    last_payment_at: string | null;
  }>
> => {
  const rows = await publicDb.execute<{ tenant_id: string; school_name: string; schema_name: string }>(sql`
    SELECT t.id::text AS tenant_id, t.name AS school_name, t.schema_name
    FROM public.tenants t
    INNER JOIN public.school_sms_features f ON f.tenant_id = t.id
    WHERE f.is_enabled = true
    ORDER BY t.name ASC
  `);

  const schools = getRows<{ tenant_id: string; school_name: string; schema_name: string }>(rows);
  const targetMonth = month ?? monthFromDate(new Date());
  const resolved = await Promise.all(
    schools.map(async (school) => {
      try {
        const metrics = await withTenantSchema(school.schema_name, async (tenantDb) => {
          const repo = new SubscriptionsRepository(tenantDb);
          const summary = await repo.getRevenueSummary({ tenantId: school.tenant_id, month: targetMonth });
          const due = Math.round((summary.total_collected_fcfa * EDUTRACK_COMMISSION_PCT) / 100);
          const smsResult = await tenantDb.execute<{ total: string | number }>(sql`
            SELECT COALESCE(SUM(sms_sent_count), 0) AS total
            FROM sms_usage_log
            WHERE month = ${targetMonth}
          `);
          return {
            subscriptions_active: summary.subscriptions_active_count,
            total_collected_fcfa: summary.total_collected_fcfa,
            sms_sent_this_month: Math.round(parseNumeric(getRows<{ total: string | number }>(smsResult)[0]?.total ?? 0)),
            commission_remaining_fcfa: Math.max(0, due - summary.commission_paid_fcfa),
          };
        });
        const monthDate = `${targetMonth}-01`;
        const lastPaymentResult = await publicDb.execute<{ last_payment_at: string | null }>(sql`
          SELECT last_payment_at::text
          FROM public.edutrack_commission_records
          WHERE tenant_id = ${school.tenant_id}::uuid
            AND period_month = ${monthDate}::date
          LIMIT 1
        `);
        const lastPaymentAt = lastPaymentResult.rows[0]?.last_payment_at ?? null;
        const remaining = metrics.commission_remaining_fcfa;
        return {
          school_name: school.school_name,
          tenant_id: school.tenant_id,
          subscriptions_active: metrics.subscriptions_active,
          total_collected_fcfa: metrics.total_collected_fcfa,
          sms_sent_this_month: metrics.sms_sent_this_month,
          commission_remaining_fcfa: remaining,
          is_overdue: remaining > 0,
          last_payment_at: lastPaymentAt,
        };
      } catch {
        return null;
      }
    })
  );

  return resolved
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => b.commission_remaining_fcfa - a.commission_remaining_fcfa);
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

export const clearAdminCache = async (): Promise<void> => {
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });

  try {
    await redis.flushdb('ASYNC');
  } finally {
    await redis.quit();
  }
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
  const targetUser = await withTenantSchema(tenant.schema_name, async (tenantDb) => {
    const userResult = await tenantDb.execute<TenantUserLookupRow>(sql`
      SELECT id
      FROM users
      WHERE is_active = true
        AND role IN ('director', 'staff')
      ORDER BY CASE
        WHEN role = 'director' THEN 0
        WHEN role = 'staff' THEN 1
        ELSE 2
      END, created_at ASC
      LIMIT 1
    `);

    return getRows<TenantUserLookupRow>(userResult)[0] ?? null;
  });

  if (!targetUser) {
    throw new Error('Tenant has no active staff user to impersonate');
  }

  const privateKey = await getPrivateKey();

  const token = signJwtRs256({
    payload: {
      sub: targetUser.id,
      role: 'director',
      schemaName: tenant.schema_name,
      tenantId: tenant.id,
      readOnly: true,
      impersonation: true,
      impersonatedBy: adminId,
    },
    privateKeyPem: privateKey,
    expiresIn: '1h',
  });

  return {
    token,
    tokenType: 'Bearer',
    expiresIn: '1h',
    tenantId: tenant.id,
    schemaName: tenant.schema_name,
    readOnly: true,
  };
};
