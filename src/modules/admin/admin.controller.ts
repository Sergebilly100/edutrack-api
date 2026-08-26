import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';

import {
  createSchoolBodySchema,
  createTenantBodySchema,
  listSchoolsQuerySchema,
  listTenantsQuerySchema,
  maintenanceConfigSchema,
  openSchoolYearBodySchema,
  smsFeatureActivateBodySchema,
  smsFeatureCommissionPaymentBodySchema,
  smsFeatureConfigBodySchema,
  smsFeatureMonthQuerySchema,
  planParamsSchema,
  schoolTenantIdParamsSchema,
  schoolUserParamsSchema,
  smsPlatformAuditQuerySchema,
  smsTemplateTypeSchema,
  tenantParamsSchema,
  updateSmsPlatformConfigBodySchema,
  updateSmsTemplateBodySchema,
  updateSchoolConfigBodySchema,
  updateSchoolDirectorBodySchema,
  updateSchoolSubscriptionBodySchema,
  updateTenantBodySchema,
  updateTenantParamsSchema,
  updatePlanCatalogBodySchema,
} from './admin.types.js';
import {
  addManualPayment,
  clearAdminCache,
  createImpersonationToken,
  deactivateSchoolSmsFeature,
  createSchool,
  createTenant,
  deleteTenantSmsTemplate,
  getAdminMetrics,
  getMaintenanceConfig,
  getRevenueMetrics,
  getRevenueSummary,
  getSchoolSmsFeatureStats,
  getSmsFeatureGlobalStats,
  getSchoolDetails,
  setMidYearFlag,
  getSchoolYearStatus,
  listSchoolCommissionPayments,
  sendSchoolPaymentReminder,
  syncSchoolSmsCommission,
  getSchoolUsers,
  getSmsDashboard,
  getSmsPlatformConfig,
  getTenantStats,
  listPlanCatalog,
  listAllRecentPayments,
  listSmsPlatformAudit,
  listSchoolPayments,
  listSmsTemplates,
  listSchools,
  listTenants,
  openSchoolYear,
  updateMaintenanceConfig,
  activateSchoolSmsFeature,
  recordSchoolCommissionReceived,
  updatePlanCatalog,
  updateSmsPlatformConfig,
  upsertSmsTemplate,
  updateSchoolConfig,
  updateSchoolDirector,
  updateSchoolSubscription,
  updateSchoolSmsFeatureConfig,
  updateTenant,
} from './admin.service.js';
import { buildMidyearImportService, MidyearImportError } from '../finance/midyear-import.service.js';
import { adminAuditOnSend } from '../../shared/middleware/admin-audit.middleware.js';
import { sql } from 'drizzle-orm';
import { withTenantSchema } from '../../shared/database/db.js';
import {
  authenticateRequest,
  requireRole,
} from '../../shared/middleware/auth.middleware.js';
import {
  attachPublicDb,
  releaseTenantDb,
} from '../../shared/middleware/tenant.middleware.js';
import { getPoolStats } from '../../shared/database/db.js';
import type { Queue } from 'bullmq';
import type { DeadLetterPayload } from '../../shared/queue/dead-letter-queue.js';

type AdminControllerOptions = {
  deadLetterQueue?: Queue<DeadLetterPayload>;
};

const handleError = (reply: FastifyReply, error: unknown, request?: FastifyRequest): FastifyReply => {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: 'Validation error',
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
  }

  const maybePgError = error as {
    code?: string;
    message?: string;
    cause?: { code?: string; message?: string; constraint?: string };
  };
  const pgCode = maybePgError?.code ?? maybePgError?.cause?.code;
  const pgConstraint = maybePgError?.cause?.constraint;

  // Toujours logger côté serveur, avec la cause complète, pour ne plus jamais
  // être aveugle sur une erreur SQL comme celle-ci.
  request?.log.error({ err: error, cause: maybePgError?.cause }, 'Admin request failed');

  if (pgCode === '23505') {
    const fieldLabel =
      pgConstraint === 'users_phone_unique' ? 'Ce numéro de téléphone'
      : pgConstraint === 'users_email_unique' ? 'Cette adresse email'
      : 'Cette valeur';

    return reply.code(409).send({
      error: `${fieldLabel} est déjà utilisé(e) par un autre compte de cette école.`,
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

export default async function adminController(
  app: FastifyInstance,
  options: AdminControllerOptions = {}
): Promise<void> {
  const { deadLetterQueue } = options;
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

  const recentPaymentsQuerySchema = z.object({
    tenantId: z.string().uuid().optional(),
  });

  app.get('/api/v1/admin/tenants', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const query = listTenantsQuerySchema.parse(request.query);
      const result = await listTenants(ensurePublicDb(request), query);
      return reply.send(result);
    } catch (error) {
      return handleError(reply, error, request);
    }
  });

  app.get(
    '/api/v1/admin/internal/pool-stats',
    { preHandler: preHandlers },
    async (_request, reply) => {
      return reply.send(getPoolStats());
    }
  );

  app.get(
    '/api/v1/admin/internal/dlq',
    { preHandler: preHandlers },
    async (_request, reply) => {
      if (!deadLetterQueue) {
        return reply.send({ jobs: [], counts: {} });
      }
      const [counts, jobs] = await Promise.all([
        deadLetterQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
        deadLetterQueue.getJobs(['waiting', 'delayed', 'active', 'failed'], 0, 49, false),
      ]);
      return reply.send({
        counts,
        jobs: jobs.map((j) => ({
          id: j.id,
          name: j.name,
          data: j.data,
          attemptsMade: j.attemptsMade,
          timestamp: j.timestamp,
          failedReason: j.failedReason,
        })),
      });
    }
  );

  app.post(
    '/api/v1/admin/internal/dlq/:jobId/replay',
    { preHandler: preHandlers },
    async (request, reply) => {
      if (!deadLetterQueue) {
        return reply.code(503).send({ error: 'DLQ unavailable', code: 'DLQ_UNAVAILABLE' });
      }
      const { jobId } = z.object({ jobId: z.string().min(1) }).parse(request.params);
      const job = await deadLetterQueue.getJob(jobId);
      if (!job) {
        return reply.code(404).send({ error: 'Job not found', code: 'NOT_FOUND' });
      }
      await job.remove();
      return reply.send({ success: true, replayed: jobId, originalQueue: job.data?.originalQueue });
    }
  );

  app.post('/api/v1/admin/schools', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const payload = createSchoolBodySchema.parse(request.body);
      const result = await createSchool(ensurePublicDb(request), payload);
      return reply.code(201).send(result);
    } catch (error) {
      return handleError(reply, error, request);
    }
  });

  app.get('/api/v1/admin/schools', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const query = listSchoolsQuerySchema.parse(request.query);
      const result = await listSchools(ensurePublicDb(request), query);
      return reply.send(result);
    } catch (error) {
      return handleError(reply, error, request);
    }
  });

  app.get('/api/v1/admin/schools/:tenantId', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const { tenantId } = schoolTenantIdParamsSchema.parse(request.params);
      const result = await getSchoolDetails(ensurePublicDb(request), tenantId);
      return reply.send(result);
    } catch (error) {
      return handleError(reply, error, request);
    }
  });

  app.get('/api/v1/admin/schools/:tenantId/users', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const { tenantId } = schoolTenantIdParamsSchema.parse(request.params);
      const result = await getSchoolUsers(ensurePublicDb(request), tenantId);
      return reply.send(result);
    } catch (error) {
      return handleError(reply, error, request);
    }
  });

  app.patch(
    '/api/v1/admin/schools/:tenantId/users/:userId/director',
    { preHandler: preHandlers },
    async (request, reply) => {
      try {
        const { tenantId, userId } = schoolUserParamsSchema.parse(request.params);
        const payload = updateSchoolDirectorBodySchema.parse(request.body);
        const director = await updateSchoolDirector(ensurePublicDb(request), tenantId, userId, payload);
        return reply.send({ director });
      } catch (error) {
        return handleError(reply, error, request);
      }
    }
  );

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
        return handleError(reply, error, request);
      }
    }
  );

  // ── Import « prise en main » (Tâche 8b) : moteur générique par mapping ────
  const midyearFile = async (
    request: FastifyRequest,
    reply: FastifyReply,
    action: 'analyze' | 'confirm',
    routeImportType: string,
  ): Promise<FastifyReply> => {
    try {
      const { tenantId } = schoolTenantIdParamsSchema.parse(request.params);
      const importType = z
        .enum(['levels', 'subjects', 'rooms', 'classes', 'students', 'payments'])
        .parse(routeImportType);
      const data = await request.file();
      if (!data) return reply.code(400).send({ error: 'No file provided', code: 'BAD_REQUEST', statusCode: 400 });
      const chunks: Buffer[] = [];
      for await (const chunk of data.file) chunks.push(chunk as Buffer);
      const fileBuffer = Buffer.concat(chunks);

      const schemaNameResult = await ensurePublicDb(request).execute<{ schema_name: string }>(
        sql`SELECT schema_name FROM public.tenants WHERE id = ${tenantId} LIMIT 1`
      );
      const targetSchema = schemaNameResult.rows?.[0]?.schema_name;
      if (!targetSchema) return reply.code(404).send({ error: 'Tenant not found', code: 'NOT_FOUND', statusCode: 404 });

      const result = await withTenantSchema(targetSchema, async (tenantDb) => {
        const service = buildMidyearImportService(tenantDb);
        return action === 'analyze' ? service.analyze(importType, fileBuffer) : service.confirm(importType, fileBuffer);
      });
      return reply.send(result);
    } catch (error) {
      if (error instanceof MidyearImportError) {
        return reply.code(error.statusCode).send({ error: error.message, code: error.code, statusCode: error.statusCode });
      }
      return handleError(reply, error, request);
    }
  };

  for (const importType of ['levels', 'subjects', 'rooms', 'classes', 'students', 'payments'] as const) {
    app.post(
      `/api/v1/admin/schools/:tenantId/midyear-import/${importType}/analyze`,
      { preHandler: preHandlers },
      async (request, reply) => midyearFile(request, reply, 'analyze', importType),
    );
    app.post(
      `/api/v1/admin/schools/:tenantId/midyear-import/${importType}/confirm`,
      { preHandler: preHandlers },
      async (request, reply) => midyearFile(request, reply, 'confirm', importType),
    );
  }

  app.patch(
    '/api/v1/admin/schools/:tenantId/mid-year-flag',
    { preHandler: preHandlers },
    async (request, reply) => {
      try {
        const { tenantId } = schoolTenantIdParamsSchema.parse(request.params);
        const body = z.object({ enabled: z.boolean() }).parse(request.body);
        await setMidYearFlag(ensurePublicDb(request), tenantId, body.enabled);
        return reply.send({ success: true });
      } catch (error) {
        return handleError(reply, error, request);
      }
    }
  );

  app.get(
    '/api/v1/admin/schools/:tenantId/school-year',
    { preHandler: preHandlers },
    async (request, reply) => {
      try {
        const { tenantId } = schoolTenantIdParamsSchema.parse(request.params);
        const result = await getSchoolYearStatus(ensurePublicDb(request), tenantId);
        return reply.send(result);
      } catch (error) {
        return handleError(reply, error, request);
      }
    }
  );

  app.post(
    '/api/v1/admin/schools/:tenantId/school-year/open',
    { preHandler: preHandlers },
    async (request, reply) => {
      try {
        const { tenantId } = schoolTenantIdParamsSchema.parse(request.params);
        const payload = openSchoolYearBodySchema.parse(request.body);
        const result = await openSchoolYear(ensurePublicDb(request), tenantId, payload);
        return reply.code(201).send(result);
      } catch (error) {
        return handleError(reply, error, request);
      }
    }
  );

  app.patch(
    '/api/v1/admin/schools/:tenantId/subscription',
    { preHandler: preHandlers },
    async (request, reply) => {
      try {
        const { tenantId } = schoolTenantIdParamsSchema.parse(request.params);
        const payload = updateSchoolSubscriptionBodySchema.parse(request.body);
        await updateSchoolSubscription(ensurePublicDb(request), tenantId, payload);
        return reply.send({ success: true });
      } catch (error) {
        return handleError(reply, error, request);
      }
    }
  );

  app.get(
    '/api/v1/admin/payments/recent',
    { preHandler: preHandlers },
    async (request, reply) => {
      try {
        const query = recentPaymentsQuerySchema.parse(request.query ?? {});
        const data = await listAllRecentPayments(ensurePublicDb(request), query.tenantId);
        return reply.send(data);
      } catch (error) {
        return handleError(reply, error, request);
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
        return handleError(reply, error, request);
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
        return handleError(reply, error, request);
      }
    }
  );

  app.get(
    '/api/v1/admin/schools/:tenantId/sms-feature/payments',
    { preHandler: preHandlers },
    async (request, reply) => {
      try {
        const { tenantId } = schoolTenantIdParamsSchema.parse(request.params);
        const query = smsFeatureMonthQuerySchema.parse(request.query ?? {});
        const result = await listSchoolCommissionPayments(ensurePublicDb(request), tenantId, query.month);
        return reply.send({ items: result });
      } catch (error) {
        return handleError(reply, error, request);
      }
    }
  );

  app.post(
    '/api/v1/admin/schools/:tenantId/payments/reminder',
    { preHandler: preHandlers },
    async (request, reply) => {
      try {
        const { tenantId } = schoolTenantIdParamsSchema.parse(request.params);
        const result = await sendSchoolPaymentReminder(ensurePublicDb(request), tenantId);
        return reply.send(result);
      } catch (error) {
        return handleError(reply, error, request);
      }
    }
  );

  app.post(
    '/api/v1/admin/schools/:tenantId/sms-feature/activate',
    { preHandler: preHandlers },
    async (request, reply) => {
      try {
        const { tenantId } = schoolTenantIdParamsSchema.parse(request.params);
        const body = smsFeatureActivateBodySchema.parse(request.body);
        const result = await activateSchoolSmsFeature(
          ensurePublicDb(request),
          tenantId,
          body,
          request.auth?.sub
        );
        return reply.send(result);
      } catch (error) {
        return handleError(reply, error, request);
      }
    }
  );

  app.post(
    '/api/v1/admin/schools/:tenantId/sms-feature/deactivate',
    { preHandler: preHandlers },
    async (request, reply) => {
      try {
        const { tenantId } = schoolTenantIdParamsSchema.parse(request.params);
        const result = await deactivateSchoolSmsFeature(ensurePublicDb(request), tenantId);
        return reply.send(result);
      } catch (error) {
        return handleError(reply, error, request);
      }
    }
  );

  app.patch(
    '/api/v1/admin/schools/:tenantId/sms-feature/config',
    { preHandler: preHandlers },
    async (request, reply) => {
      try {
        const { tenantId } = schoolTenantIdParamsSchema.parse(request.params);
        const body = smsFeatureConfigBodySchema.parse(request.body);
        const result = await updateSchoolSmsFeatureConfig(ensurePublicDb(request), tenantId, body, {
          actorId: request.auth?.sub,
          actorRole: request.auth?.role,
        });
        return reply.send(result);
      } catch (error) {
        return handleError(reply, error, request);
      }
    }
  );

  app.patch(
    '/api/v1/admin/schools/:tenantId/sms-features',
    { preHandler: preHandlers },
    async (request, reply) => {
      try {
        const { tenantId } = schoolTenantIdParamsSchema.parse(request.params);
        const body = smsFeatureConfigBodySchema.parse(request.body);
        const result = await updateSchoolSmsFeatureConfig(ensurePublicDb(request), tenantId, body, {
          actorId: request.auth?.sub,
          actorRole: request.auth?.role,
        });
        return reply.send(result);
      } catch (error) {
        return handleError(reply, error, request);
      }
    }
  );

  app.patch(
    '/api/v1/admin/schools/:tenantId/features',
    { preHandler: preHandlers },
    async (request, reply) => {
      try {
        const { tenantId } = schoolTenantIdParamsSchema.parse(request.params);
        const body = smsFeatureConfigBodySchema.parse(request.body);
        const result = await updateSchoolSmsFeatureConfig(ensurePublicDb(request), tenantId, body, {
          actorId: request.auth?.sub,
          actorRole: request.auth?.role,
        });
        return reply.send(result);
      } catch (error) {
        return handleError(reply, error, request);
      }
    }
  );

  app.post(
    '/api/v1/admin/schools/:tenantId/sms-feature/sync-commission',
    { preHandler: preHandlers },
    async (request, reply) => {
      try {
        const { tenantId } = schoolTenantIdParamsSchema.parse(request.params);
        const query = smsFeatureMonthQuerySchema.parse(request.query ?? {});
        const month = query.month ?? new Date().toISOString().slice(0, 7);
        const result = await syncSchoolSmsCommission(ensurePublicDb(request), tenantId, month, {
          actorId: request.auth?.sub ?? null,
          actorRole: request.auth?.role ?? 'super_admin',
        });
        return reply.send(result);
      } catch (error) {
        return handleError(reply, error, request);
      }
    }
  );

  app.post(
    '/api/v1/admin/schools/:tenantId/sms-feature/record-commission-received',
    { preHandler: preHandlers },
    async (request, reply) => {
      try {
        const { tenantId } = schoolTenantIdParamsSchema.parse(request.params);
        const body = smsFeatureCommissionPaymentBodySchema.parse(request.body ?? {});
        const result = await recordSchoolCommissionReceived(ensurePublicDb(request), tenantId, body, {
          actorId: request.auth?.sub ?? null,
          actorRole: request.auth?.role ?? 'super_admin',
        });
        return reply.send(result);
      } catch (error) {
        return handleError(reply, error, request);
      }
    }
  );

  app.get(
    '/api/v1/admin/schools/:tenantId/sms-feature/stats',
    { preHandler: preHandlers },
    async (request, reply) => {
      try {
        const { tenantId } = schoolTenantIdParamsSchema.parse(request.params);
        const result = await getSchoolSmsFeatureStats(ensurePublicDb(request), tenantId);
        return reply.send(result);
      } catch (error) {
        return handleError(reply, error, request);
      }
    }
  );

  app.get(
    '/api/v1/admin/sms-feature/global-stats',
    { preHandler: preHandlers },
    async (request, reply) => {
      try {
        const query = smsFeatureMonthQuerySchema.parse(request.query ?? {});
        const result = await getSmsFeatureGlobalStats(ensurePublicDb(request), query.month);
        return reply.send({ items: result });
      } catch (error) {
        return handleError(reply, error, request);
      }
    }
  );

  app.get('/api/v1/admin/metrics', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const result = await getAdminMetrics(ensurePublicDb(request));
      return reply.send(result);
    } catch (error) {
      return handleError(reply, error, request);
    }
  });

  app.get('/api/v1/admin/metrics/revenue', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const result = await getRevenueMetrics(ensurePublicDb(request));
      return reply.send(result);
    } catch (error) {
      return handleError(reply, error, request);
    }
  });

  app.get('/api/v1/admin/plans', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const items = await listPlanCatalog(ensurePublicDb(request));
      return reply.send({ items });
    } catch (error) {
      return handleError(reply, error, request);
    }
  });

  app.patch('/api/v1/admin/plans/:plan', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const { plan } = planParamsSchema.parse(request.params);
      const payload = updatePlanCatalogBodySchema.parse(request.body);
      await updatePlanCatalog(ensurePublicDb(request), plan, payload);
      return reply.send({ success: true });
    } catch (error) {
      return handleError(reply, error, request);
    }
  });

  app.get('/api/v1/admin/sms/dashboard', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const result = await getSmsDashboard(ensurePublicDb(request));
      return reply.send(result);
    } catch (error) {
      return handleError(reply, error, request);
    }
  });

  app.get('/api/v1/admin/sms/platform-config', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const result = await getSmsPlatformConfig(ensurePublicDb(request));
      return reply.send(result);
    } catch (error) {
      return handleError(reply, error, request);
    }
  });

  app.patch('/api/v1/admin/sms/platform-config', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const payload = updateSmsPlatformConfigBodySchema.parse(request.body);
      await updateSmsPlatformConfig(ensurePublicDb(request), payload, request.auth?.sub);
      return reply.send({ success: true });
    } catch (error) {
      return handleError(reply, error, request);
    }
  });

  app.get('/api/v1/admin/sms/platform-audit', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const query = smsPlatformAuditQuerySchema.parse(request.query);
      const items = await listSmsPlatformAudit(ensurePublicDb(request), query.limit);
      return reply.send({ items });
    } catch (error) {
      return handleError(reply, error, request);
    }
  });

  app.get('/api/v1/admin/sms/templates', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const templates = await listSmsTemplates(ensurePublicDb(request));
      return reply.send({ items: templates });
    } catch (error) {
      return handleError(reply, error, request);
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
        return handleError(reply, error, request);
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
        return handleError(reply, error, request);
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
        return handleError(reply, error, request);
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
        return handleError(reply, error, request);
      }
    }
  );

  app.get('/api/v1/admin/maintenance', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const config = await getMaintenanceConfig(ensurePublicDb(request));
      return reply.send(config);
    } catch (error) {
      return handleError(reply, error, request);
    }
  });

  app.patch('/api/v1/admin/maintenance', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const payload = maintenanceConfigSchema.parse(request.body);
      await updateMaintenanceConfig(ensurePublicDb(request), payload);
      return reply.send({ success: true });
    } catch (error) {
      return handleError(reply, error, request);
    }
  });

  app.delete('/api/v1/admin/cache', { preHandler: preHandlers }, async (request, reply) => {
    try {
      await clearAdminCache();
      return reply.send({ success: true });
    } catch (error) {
      return handleError(reply, error, request);
    }
  });

  app.get('/api/v1/admin/revenue/summary', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const result = await getRevenueSummary(ensurePublicDb(request));
      return reply.send(result);
    } catch (error) {
      return handleError(reply, error, request);
    }
  });

  app.post('/api/v1/admin/tenants', { preHandler: preHandlers }, async (request, reply) => {
    try {
      const payload = createTenantBodySchema.parse(request.body);
      const result = await createTenant(ensurePublicDb(request), payload);
      return reply.code(201).send(result);
    } catch (error) {
      return handleError(reply, error, request);
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
        return handleError(reply, error, request);
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
        return handleError(reply, error, request);
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
        return handleError(reply, error, request);
      }
    }
  );
}
