import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import { withTenantSchema } from '../../shared/database/db.js';
import { authenticateRequest, requirePermission } from '../../shared/middleware/auth.middleware.js';
import type { PermissionKey } from '../../shared/types/index.js';
import type { PdfExportQueueHandle } from '../billing/billing.queue.js';
import { buildFinanceService, FinanceModuleError } from './finance.service.js';
import {
  cancelPaymentBodySchema,
  createSubscriptionPlanBodySchema,
  grantTuitionOverrideBodySchema,
  paymentIdParamsSchema,
  recordPaymentBodySchema,
  schoolYearQuerySchema,
  studentFinancialParamsSchema,
  subscriptionPlanParamsSchema,
  tuitionPlanClassParamsSchema,
  tuitionPlansQuerySchema,
  updateSubscriptionPlanBodySchema,
  upsertProviderSettingBodySchema,
  upsertTuitionPlanBodySchema,
} from './finance.types.js';

const handleError = (request: FastifyRequest, reply: FastifyReply, error: unknown) => {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: 'Invalid request', code: 'VALIDATION_ERROR', statusCode: 400, details: error.issues,
    });
  }
  if (error instanceof FinanceModuleError) {
    return reply.code(error.statusCode).send({
      error: error.message, code: error.code, statusCode: error.statusCode,
    });
  }
  request.log.error({ err: error }, '[finance] Unexpected error');
  return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR', statusCode: 500 });
};

const requireAnyPermission = (permissions: readonly PermissionKey[]) =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await authenticateRequest(request, reply);
    if (reply.sent) return;
    if (!permissions.some((permission) => request.permissions?.has(permission))) {
      reply.code(403).send({
        error: `Permission ${permissions.join(' or ')} required`,
        code: 'FORBIDDEN',
        statusCode: 403,
      });
    }
  };

const createInMemoryPdfQueue = (): PdfExportQueueHandle => ({
  add: async () => ({ id: `memory-${Date.now()}` }),
});

const enqueueReceipt = async (
  queue: PdfExportQueueHandle,
  schemaName: string,
  paymentId: string
): Promise<string | number | undefined> => {
  const job = await queue.add('tuition-receipt', {
    type: 'tuition-receipt',
    schemaName,
    paymentId,
  }, { removeOnComplete: 100, removeOnFail: 100 });
  return job.id;
};

export default async function financeController(
  app: FastifyInstance,
  options: { pdfQueue?: PdfExportQueueHandle } = {}
): Promise<void> {
  const pdfQueue = options.pdfQueue ?? createInMemoryPdfQueue();
  const withService = <T>(request: FastifyRequest, run: (service: ReturnType<typeof buildFinanceService>) => Promise<T>) =>
    withTenantSchema(request.claims!.schemaName, (db) => run(buildFinanceService(db)));

  app.post('/api/v1/payments', { preHandler: requirePermission('payments.record') }, async (request, reply) => {
    try {
      const body = recordPaymentBodySchema.parse(request.body);
      const result = await withService(request, (service) => service.recordManualPayment({
        ...body,
        actorUserId: request.user!.userId,
      }));
      const receiptJobId = await enqueueReceipt(pdfQueue, request.claims!.schemaName, result.payment.id);
      return reply.code(201).send({ ...result, receiptJobId });
    } catch (error) { return handleError(request, reply, error); }
  });

  app.post('/api/v1/payments/:id/cancel', { preHandler: requirePermission('payments.cancel') }, async (request, reply) => {
    try {
      const { id } = paymentIdParamsSchema.parse(request.params);
      const { reason } = cancelPaymentBodySchema.parse(request.body);
      return reply.send(await withService(request, (service) =>
        service.cancelPayment(id, request.user!.userId, reason)));
    } catch (error) { return handleError(request, reply, error); }
  });

  app.post('/api/v1/payments/:id/receipt', { preHandler: requirePermission('payments.view') }, async (request, reply) => {
    try {
      const { id } = paymentIdParamsSchema.parse(request.params);
      await withService(request, (service) => service.getReceiptPayload(id));
      const jobId = await enqueueReceipt(pdfQueue, request.claims!.schemaName, id);
      return reply.code(202).send({ jobId });
    } catch (error) { return handleError(request, reply, error); }
  });

  app.get('/api/v1/students/:studentId/financial-status', {
    preHandler: requireAnyPermission(['tuition.view', 'payments.view']),
  }, async (request, reply) => {
    try {
      const { studentId } = studentFinancialParamsSchema.parse(request.params);
      const { school_year_id: schoolYearId } = schoolYearQuerySchema.parse(request.query);
      return reply.send({ financialStatus: await withService(request, (service) =>
        service.getFinancialStatus(studentId, schoolYearId)) });
    } catch (error) { return handleError(request, reply, error); }
  });

  app.post('/api/v1/tuition/overrides', { preHandler: requirePermission('tuition.grant_discount') }, async (request, reply) => {
    try {
      const body = grantTuitionOverrideBodySchema.parse(request.body);
      const result = await withService(request, (service) => service.grantTuitionOverride({
        ...body,
        grantedByUserId: request.user!.userId,
      }));
      return reply.code(201).send(result);
    } catch (error) { return handleError(request, reply, error); }
  });

  app.get('/api/v1/tuition-plans', { preHandler: requirePermission('tuition.view') }, async (request, reply) => {
    try {
      const query = tuitionPlansQuerySchema.parse(request.query ?? {});
      return reply.send({ tuitionPlans: await withService(request, (service) =>
        service.listTuitionPlans(query.class_id)) });
    } catch (error) { return handleError(request, reply, error); }
  });

  app.put('/api/v1/tuition-plans/classes/:classId', { preHandler: requirePermission('tuition.edit') }, async (request, reply) => {
    try {
      const { classId } = tuitionPlanClassParamsSchema.parse(request.params);
      const body = upsertTuitionPlanBodySchema.parse(request.body);
      return reply.send({ tuitionPlan: await withService(request, (service) =>
        service.upsertTuitionPlan(classId, body)) });
    } catch (error) { return handleError(request, reply, error); }
  });

  app.get('/api/v1/payment-provider-settings/status', { preHandler: authenticateRequest }, async (request, reply) => {
    try {
      return reply.send(await withService(request, (service) => service.getProviderAvailability()));
    } catch (error) { return handleError(request, reply, error); }
  });

  app.get('/api/v1/payment-provider-settings', { preHandler: requirePermission('settings.school') }, async (request, reply) => {
    try {
      return reply.send({ settings: await withService(request, (service) => service.listProviderSettings()) });
    } catch (error) { return handleError(request, reply, error); }
  });

  app.put('/api/v1/payment-provider-settings', { preHandler: requirePermission('settings.school') }, async (request, reply) => {
    try {
      const body = upsertProviderSettingBodySchema.parse(request.body);
      return reply.send({ setting: await withService(request, (service) => service.upsertProviderSetting(body)) });
    } catch (error) { return handleError(request, reply, error); }
  });

  app.get('/api/v1/subscription-plans', { preHandler: requirePermission('subscription_plans.view') }, async (request, reply) => {
    try {
      return reply.send({ subscriptionPlans: await withService(request, (service) => service.listSubscriptionPlans()) });
    } catch (error) { return handleError(request, reply, error); }
  });

  app.post('/api/v1/subscription-plans', { preHandler: requirePermission('subscription_plans.edit') }, async (request, reply) => {
    try {
      const body = createSubscriptionPlanBodySchema.parse(request.body);
      return reply.code(201).send({ subscriptionPlan: await withService(request, (service) =>
        service.createSubscriptionPlan(body)) });
    } catch (error) { return handleError(request, reply, error); }
  });

  app.put('/api/v1/subscription-plans/:id', { preHandler: requirePermission('subscription_plans.edit') }, async (request, reply) => {
    try {
      const { id } = subscriptionPlanParamsSchema.parse(request.params);
      const body = updateSubscriptionPlanBodySchema.parse(request.body);
      return reply.send({ subscriptionPlan: await withService(request, (service) =>
        service.updateSubscriptionPlan(id, body)) });
    } catch (error) { return handleError(request, reply, error); }
  });
}

