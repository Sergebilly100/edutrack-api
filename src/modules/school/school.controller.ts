import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import { ZodError, z } from 'zod';

import { db, withTenantSchema } from '../../shared/database/db.js';
import { authenticateRequest, requireDirectorOrSecretary } from '../../shared/middleware/auth.middleware.js';
import { logger } from '../../shared/observability/logger.js';
import {
  extractHostname,
  resolveTenantFromHostname,
} from '../../shared/tenancy/tenant-host.js';

type TenantInfoRow = {
  id: string;
  name: string;
  subdomain: string;
  plan: 'essential' | 'pro' | 'establishment';
  city: string | null;
  teaching_type: 'primaire' | 'secondaire' | 'superieur' | 'mixte' | null;
  max_users: number;
  student_label: string | null;
  director_title: string | null;
  max_sms_per_month: number | null;
  can_edit_sms_template: boolean | null;
  can_export_data: boolean | null;
  allow_teacher_qr_skip: boolean | null;
  use_real_hours: boolean | null;
  geo_check_enabled: boolean | null;
  onboarding_completed: boolean;
};

type DirectorPhoneRow = {
  phone: string | null;
};

const schoolInfoPatchSchema = z.object({
  name: z.string().trim().min(2).max(255).optional(),
  city: z.string().trim().min(2).max(100).optional(),
  phone: z.string().trim().min(6).max(20).optional(),
});

const SCHEMA_NAME_REGEX = /^[a-z][a-z0-9_]{2,63}$/;
const SUBDOMAIN_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_LOCAL_SCHEMA =
  (process.env.AUTH_DEFAULT_TENANT_SCHEMA ?? 'school_sainte_marie').trim();

const getRows = <TRow,>(result: unknown): TRow[] => {
  if (typeof result !== 'object' || result === null || !('rows' in result)) {
    return [];
  }
  const rows = (result as { rows: TRow[] }).rows;
  return Array.isArray(rows) ? rows : [];
};

const handleError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: 'Validation error',
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
  }

  if (error instanceof Error) {
    if (error.message === 'Missing Authorization header' || error.message === 'Invalid Authorization header') {
      return reply.code(401).send({
        error: error.message,
        code: 'UNAUTHORIZED',
        statusCode: 401,
      });
    }

    if (error.message === 'Tenant not found') {
      return reply.code(404).send({
        error: error.message,
        code: 'NOT_FOUND',
        statusCode: 404,
      });
    }
  }

  logger.error(
    { err: error instanceof Error ? error.message : String(error) },
    '[school] unhandled error'
  );

  return reply.code(500).send({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
    statusCode: 500,
  });
};

const resolveSchemaBySubdomain = async (subdomain: string): Promise<string | null> => {
  const result = await db.execute<{ schema_name: string }>(sql`
    SELECT schema_name
    FROM public.tenants
    WHERE subdomain = ${subdomain}
    LIMIT 1
  `);

  return getRows<{ schema_name: string }>(result)[0]?.schema_name ?? null;
};

const resolveSchemaNameFromPublicRequest = async (request: FastifyRequest): Promise<string> => {
  const headerValue = request.headers['x-tenant-schema'];
  if (typeof headerValue === 'string' && headerValue.trim().length > 0) {
    const schema = headerValue.trim();
    if (!SCHEMA_NAME_REGEX.test(schema)) {
      throw new Error('Invalid tenant schema');
    }
    return schema;
  }

  const subdomainHeader = request.headers['x-tenant-subdomain'];
  if (typeof subdomainHeader === 'string' && subdomainHeader.trim().length > 0) {
    const subdomain = subdomainHeader.trim().toLowerCase();
    if (!SUBDOMAIN_REGEX.test(subdomain)) {
      throw new Error('Invalid tenant subdomain');
    }
    const schema = await resolveSchemaBySubdomain(subdomain);
    if (!schema) {
      throw new Error('Tenant not found');
    }
    return schema;
  }

  const hostname = extractHostname(request);
  if (hostname) {
    const tenant = resolveTenantFromHostname(hostname);
    if (tenant?.type === 'schema') {
      if (!SCHEMA_NAME_REGEX.test(tenant.value)) {
        throw new Error('Invalid tenant schema');
      }
      return tenant.value;
    }
    if (tenant?.type === 'subdomain') {
      const schema = await resolveSchemaBySubdomain(tenant.value);
      if (!schema) {
        throw new Error('Tenant not found');
      }
      return schema;
    }

    const isLocalHost =
      hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    if (isLocalHost && SCHEMA_NAME_REGEX.test(DEFAULT_LOCAL_SCHEMA)) {
      return DEFAULT_LOCAL_SCHEMA;
    }
  }

  throw new Error('Tenant not found');
};

const fetchSchoolInfoBySchema = async (schemaName: string) => {
  const tenantResult = await db.execute<TenantInfoRow>(sql`
    SELECT t.id, t.name, t.subdomain, t.plan, t.city, t.teaching_type, t.max_users,
           COALESCE(t.student_label, 'Élève') AS student_label,
           COALESCE(t.director_title, 'Directeur') AS director_title,
           COALESCE(t.max_sms_per_month, 2000) AS max_sms_per_month,
           COALESCE(t.can_edit_sms_template, false) AS can_edit_sms_template,
           COALESCE(t.can_export_data, true) AS can_export_data,
           COALESCE(t.allow_teacher_qr_skip, false) AS allow_teacher_qr_skip,
           COALESCE(features.use_real_hours, false) AS use_real_hours,
           COALESCE(features.geo_check_enabled, false) AS geo_check_enabled,
           t.onboarding_completed
    FROM public.tenants t
    LEFT JOIN public.school_sms_features features ON features.tenant_id = t.id
    WHERE t.schema_name = ${schemaName}
    LIMIT 1
  `);
  const tenant = getRows<TenantInfoRow>(tenantResult)[0];

  if (!tenant) {
    throw new Error('Tenant not found');
  }

  const tenantMetrics = await withTenantSchema(schemaName, async (tenantDb) => {
    const [directorResult, usersCountResult] = await Promise.all([
      tenantDb.execute<DirectorPhoneRow>(sql`
        SELECT phone
        FROM users
        WHERE role = 'director'
        ORDER BY created_at ASC
        LIMIT 1
      `),
      tenantDb.execute<{ count: number }>(sql`
        SELECT COUNT(*)::int AS count
        FROM users
        WHERE is_active = true
      `),
    ]);

    return {
      directorPhone: getRows<DirectorPhoneRow>(directorResult)[0]?.phone ?? null,
      currentUsers: getRows<{ count: number }>(usersCountResult)[0]?.count ?? 0,
    };
  });

  return {
    id: tenant.id,
    name: tenant.name,
    subdomain: tenant.subdomain,
    plan: tenant.plan,
    city: tenant.city,
    teaching_type: tenant.teaching_type,
    max_users: tenant.max_users,
    student_label: tenant.student_label,
    director_title: tenant.director_title,
    max_sms_per_month: tenant.max_sms_per_month ?? 2000,
    can_edit_sms_template: tenant.can_edit_sms_template ?? false,
    can_export_data: tenant.can_export_data ?? true,
    allow_teacher_qr_skip: tenant.allow_teacher_qr_skip ?? false,
    use_real_hours: tenant.use_real_hours ?? false,
    geo_check_enabled: tenant.geo_check_enabled ?? false,
    current_users: tenantMetrics.currentUsers,
    address: '',
    phone: tenantMetrics.directorPhone,
    onboarding_completed: tenant.onboarding_completed,
  };
};

export default async function schoolController(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/school/public-info', async (request, reply) => {
    try {
      const schemaName = await resolveSchemaNameFromPublicRequest(request);
      const tenantResult = await db.execute<{ name: string }>(sql`
        SELECT name
        FROM public.tenants
        WHERE schema_name = ${schemaName}
        LIMIT 1
      `);
      const school = getRows<{ name: string }>(tenantResult)[0];

      if (!school) {
        return reply.code(404).send({
          error: 'Tenant not found',
          code: 'NOT_FOUND',
          statusCode: 404,
        });
      }

      return reply.send({ name: school.name });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get('/api/v1/school/info', { preHandler: authenticateRequest }, async (request, reply) => {
    try {
      const claims = request.claims;
      if (!claims) {
        return reply.code(401).send({
          error: 'Unauthorized',
          code: 'UNAUTHORIZED',
          statusCode: 401,
        });
      }

      const school = await fetchSchoolInfoBySchema(claims.schemaName);
      return reply.send(school);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.patch('/api/v1/school/info', { preHandler: requireDirectorOrSecretary }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const body = schoolInfoPatchSchema.parse(request.body ?? {});

      if (body.name) {
        await db.execute(sql`
          UPDATE public.tenants
          SET name = ${body.name}, updated_at = NOW()
          WHERE schema_name = ${claims.schemaName}
        `);
      }

      if (body.city) {
        await db.execute(sql`
          UPDATE public.tenants
          SET city = ${body.city}, updated_at = NOW()
          WHERE schema_name = ${claims.schemaName}
        `);
      }

      if (body.phone) {
        await withTenantSchema(claims.schemaName, async (tenantDb) => {
          await tenantDb.execute(sql`
            UPDATE users
            SET phone = ${body.phone}
            WHERE id = (
              SELECT id
              FROM users
              WHERE role = 'director'
              ORDER BY created_at ASC
              LIMIT 1
            )
          `);
        });
      }

      const school = await fetchSchoolInfoBySchema(claims.schemaName);
      return reply.send(school);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.patch(
    '/api/v1/school/onboarding-complete',
    { preHandler: requireDirectorOrSecretary },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        await db.execute(sql`
          UPDATE public.tenants
          SET onboarding_completed = true, updated_at = NOW()
          WHERE schema_name = ${claims.schemaName}
        `);

        const school = await fetchSchoolInfoBySchema(claims.schemaName);
        return reply.send(school);
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );
}
