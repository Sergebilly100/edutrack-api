import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';

import {
  createSchoolBodySchema,
  createTenantBodySchema,
  listSchoolsQuerySchema,
  listTenantsQuerySchema,
  maintenanceConfigSchema,
  planParamsSchema,
  schoolTenantIdParamsSchema,
  smsPlatformAuditQuerySchema,
  smsTemplateTypeSchema,
  tenantParamsSchema,
  updateSmsPlatformConfigBodySchema,
  updateSmsTemplateBodySchema,
  updateSchoolConfigBodySchema,
  updateTenantBodySchema,
  updateTenantParamsSchema,
  updatePlanCatalogBodySchema,
} from './admin.types.js';
import {
  addManualPayment,
  clearAdminCache,
  createImpersonationToken,
  createSchool,
  createTenant,
  deleteTenantSmsTemplate,
  getAdminMetrics,
  getMaintenanceConfig,
  getRevenueMetrics,
  getRevenueSummary,
  getSchoolDetails,
  getSchoolUsers,
  getSmsDashboard,
  getSmsPlatformConfig,
  getTenantStats,
  listPlanCatalog,
  listSmsPlatformAudit,
  listSchoolPayments,
  listSmsTemplates,
  listSchools,
  listTenants,
  updateMaintenanceConfig,
  updatePlanCatalog,
  updateSmsPlatformConfig,
  upsertSmsTemplate,
  updateSchoolConfig,
  updateTenant,
} from './admin.service.js';
import { adminAuditOnSend } from '../../shared/middleware/admin-audit.middleware.js';
import {
  authenticateRequest,
  requireRole,
} from '../../shared/middleware/auth.middleware.js';
import {
  attachPublicDb,
  releaseTenantDb,
} from '../../shared/middleware/tenant.middleware.js';

const handleError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: 'Validation error',
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
  }

  const maybePgError = error as { code?: string; message?: string };
  if (maybePgError?.code === '23505') {
    return reply.code(409).send({
      error: 'Resource already exists',
      code: 'CONFLICT',
      statusCode: 409,
    });
  }

  const message = error instanceof Error ? error.message : 'Unexpected error';

  if (message === 'Tenant not found') {
    return reply.code(404).send({
      error: message,
      code: 'NOT_FOUND',
      statusCode: 404,
    });
  }

  if (
    message === 'Invalid access token' ||
    message === 'Unauthorized' ||
    message === 'Missing Authorization header' ||
    message === 'Invalid Authorization header'
  ) {
    return reply.code(401).send({
      error: message,
      code: 'UNAUTHORIZED',
      statusCode: 401,
    });
  }

  if (message.includes('Role')) {
    return reply.code(403).send({
      error: message,
      code: 'FORBIDDEN',
      statusCode: 403,
    });
  }

  return reply.code(400).send({
    error: message,
    code: 'BAD_REQUEST',
    statusCode: 400,
  });
};

export default async function adminController(app: FastifyInstance): Promise<void> {
  app.addHook('onSend', adminAuditOnSend);
  app.addHook('onResponse', async (request) => {
    await releaseTenantDb(request);
  });

  const preHandlers = [authenticateRequest, requireRole('super_admin'), attachPublicDb];

  const ensurePublicDb = (request: FastifyRequest) => {
    if (!request.db) {
      throw new Error('Public database not initialized');
    }

    return request.db;
  };

  const manualPaymentBodySchema = z.object({
    date: z.string().min(10),
    amount_fcfa: z.coerce.number().int().min(1),
    provider: z.enum(['manual', 'mtn_momo', 'orange_money']).default('manual'),
    reference: z.string().optional(),
    period_from: z.string().optional(),
    period_to: z.string().optional(),
  });

  app.get('/api/v1/admin/tenants', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const query = listTenantsQuerySchema.parse(request.query);
      const result = await listTenants(ensurePublicDb(request), query);
      return reply.send(result);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post('/api/v1/admin/schools', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const payload = createSchoolBodySchema.parse(request.body);
      const result = await createSchool(ensurePublicDb(request), payload);
      return reply.code(201).send(result);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get('/api/v1/admin/schools', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const query = listSchoolsQuerySchema.parse(request.query);
      const result = await listSchools(ensurePublicDb(request), query);
      return reply.send(result);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get('/api/v1/admin/schools/:tenantId', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const { tenantId } = schoolTenantIdParamsSchema.parse(request.params);
      const result = await getSchoolDetails(ensurePublicDb(request), tenantId);
      return reply.send(result);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get('/api/v1/admin/schools/:tenantId/users', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const { tenantId } = schoolTenantIdParamsSchema.parse(request.params);
      const result = await getSchoolUsers(ensurePublicDb(request), tenantId);
      return reply.send(result);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.patch(
    '/api/v1/admin/schools/:tenantId/config',
    { preHandler: preHandlers },
    async (request, reply) => {
      try {
        const { tenantId } = schoolTenantIdParamsSchema.parse(request.params);
        const payload = updateSchoolConfigBodySchema.parse(request.body);
        await updateSchoolConfig(ensurePublicDb(request), tenantId, payload);
        return reply.send({ success: true });
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.get(
    '/api/v1/admin/schools/:tenantId/payments',
    { preHandler: preHandlers },
    async (request, reply) => {
      try {
        const { tenantId } = schoolTenantIdParamsSchema.parse(request.params);
        const data = await listSchoolPayments(ensurePublicDb(request), tenantId);
        return reply.send({ items: data });
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.post(
    '/api/v1/admin/schools/:tenantId/payments',
    { preHandler: preHandlers },
    async (request, reply) => {
      try {
        const { tenantId } = schoolTenantIdParamsSchema.parse(request.params);
        const payload = manualPaymentBodySchema.parse(request.body);
        await addManualPayment(ensurePublicDb(request), tenantId, payload);
        return reply.code(201).send({ success: true });
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.get('/api/v1/admin/metrics', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const result = await getAdminMetrics(ensurePublicDb(request));
      return reply.send(result);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get('/api/v1/admin/metrics/revenue', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const result = await getRevenueMetrics(ensurePublicDb(request));
      return reply.send(result);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get('/api/v1/admin/plans', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const items = await listPlanCatalog(ensurePublicDb(request));
      return reply.send({ items });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.patch('/api/v1/admin/plans/:plan', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const { plan } = planParamsSchema.parse(request.params);
      const payload = updatePlanCatalogBodySchema.parse(request.body);
      await updatePlanCatalog(ensurePublicDb(request), plan, payload);
      return reply.send({ success: true });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get('/api/v1/admin/sms/dashboard', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const result = await getSmsDashboard(ensurePublicDb(request));
      return reply.send(result);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get('/api/v1/admin/sms/platform-config', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const result = await getSmsPlatformConfig(ensurePublicDb(request));
      return reply.send(result);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.patch('/api/v1/admin/sms/platform-config', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const payload = updateSmsPlatformConfigBodySchema.parse(request.body);
      await updateSmsPlatformConfig(ensurePublicDb(request), payload, request.auth?.sub);
      return reply.send({ success: true });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get('/api/v1/admin/sms/platform-audit', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const query = smsPlatformAuditQuerySchema.parse(request.query);
      const items = await listSmsPlatformAudit(ensurePublicDb(request), query.limit);
      return reply.send({ items });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get('/api/v1/admin/sms/templates', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const templates = await listSmsTemplates(ensurePublicDb(request));
      return reply.send({ items: templates });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.put(
    '/api/v1/admin/sms/templates/:type',
    { preHandler: preHandlers },
    async (request, reply) => {
      try {
        const type = smsTemplateTypeSchema.parse((request.params as { type?: string })?.type);
        const body = updateSmsTemplateBodySchema.parse(request.body);
        await upsertSmsTemplate(ensurePublicDb(request), {
          tenantId: null,
          type,
          body,
          adminId: request.auth?.sub,
        });
        return reply.send({ success: true });
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.get(
    '/api/v1/admin/sms/templates/:tenantId',
    { preHandler: preHandlers },
    async (request, reply) => {
      try {
        const { tenantId } = schoolTenantIdParamsSchema.parse(request.params);
        const templates = await listSmsTemplates(ensurePublicDb(request), tenantId);
        return reply.send({ items: templates });
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.put(
    '/api/v1/admin/sms/templates/:tenantId/:type',
    { preHandler: preHandlers },
    async (request, reply) => {
      try {
        const { tenantId } = schoolTenantIdParamsSchema.parse({ tenantId: (request.params as { tenantId?: string }).tenantId });
        const type = smsTemplateTypeSchema.parse((request.params as { type?: string }).type);
        const body = updateSmsTemplateBodySchema.parse(request.body);
        await upsertSmsTemplate(ensurePublicDb(request), {
          tenantId,
          type,
          body,
          adminId: request.auth?.sub,
        });
        return reply.send({ success: true });
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.delete(
    '/api/v1/admin/sms/templates/:tenantId/:type',
    { preHandler: preHandlers },
    async (request, reply) => {
      try {
        const { tenantId } = schoolTenantIdParamsSchema.parse({ tenantId: (request.params as { tenantId?: string }).tenantId });
        const type = smsTemplateTypeSchema.parse((request.params as { type?: string }).type);
        await deleteTenantSmsTemplate(ensurePublicDb(request), tenantId, type);
        return reply.send({ success: true });
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.get('/api/v1/admin/maintenance', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const config = await getMaintenanceConfig(ensurePublicDb(request));
      return reply.send(config);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.patch('/api/v1/admin/maintenance', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const payload = maintenanceConfigSchema.parse(request.body);
      await updateMaintenanceConfig(ensurePublicDb(request), payload);
      return reply.send({ success: true });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.delete('/api/v1/admin/cache', { preHandler: preHandlers }, async (_request, reply) => {
    try {
      await clearAdminCache();
      return reply.send({ success: true });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get('/api/v1/admin/revenue/summary', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const result = await getRevenueSummary(ensurePublicDb(request));
      return reply.send(result);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post('/api/v1/admin/tenants', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const payload = createTenantBodySchema.parse(request.body);
      const result = await createTenant(ensurePublicDb(request), payload);
      return reply.code(201).send(result);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.patch(
    '/api/v1/admin/tenants/:id',
    { preHandler: preHandlers },
    async (request, reply) => {
      try {
        const { id } = updateTenantParamsSchema.parse(request.params);
        const payload = updateTenantBodySchema.parse(request.body);

        await updateTenant(ensurePublicDb(request), id, payload);

        return reply.send({
          success: true,
        });
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.get(
    '/api/v1/admin/tenants/:id/stats',
    { preHandler: preHandlers },
    async (request, reply) => {
      try {
        const { id } = tenantParamsSchema.parse(request.params);
        const result = await getTenantStats(ensurePublicDb(request), id);
        return reply.send(result);
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.post(
    '/api/v1/admin/tenants/:id/impersonate',
    { preHandler: preHandlers },
    async (request, reply) => {
      try {
        const { id } = tenantParamsSchema.parse(request.params);
        const result = await createImpersonationToken(
          ensurePublicDb(request),
          id,
          request.auth?.sub
        );
        return reply.send(result);
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );
}
