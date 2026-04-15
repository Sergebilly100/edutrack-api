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
  type SchoolDetailsResult,
  type SchoolListItem,
  type SchoolListResult,
  type TeachingType,
  type TenantListItem,
  type TenantListResult,
  type TenantStatsResult,
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

const formatDateTime = (value: Date | null): string | null => {
  return value ? value.toISOString() : null;
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
      trial_ends_at
    )
    VALUES (
      ${payload.name},
      ${payload.subdomain},
      ${schemaName},
      ${payload.plan},
      'trial',
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
      createdAt: tenant.created_at.toISOString(),
      updatedAt: tenant.updated_at.toISOString(),
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
  const result = await publicDb.execute<{ id: string }>(sql`
    UPDATE public.tenants
    SET
      plan = CASE WHEN ${payload.plan !== undefined} THEN ${payload.plan ?? null}::tenant_plan ELSE plan END,
      status = CASE WHEN ${payload.status !== undefined} THEN ${payload.status ?? null}::tenant_status ELSE status END,
      max_admin_positions = CASE
        WHEN ${payload.max_admin_positions !== undefined}
          THEN ${payload.max_admin_positions ?? null}::integer
        ELSE max_admin_positions
      END,
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
