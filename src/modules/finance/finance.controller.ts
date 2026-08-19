import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import { withTenantSchema } from '../../shared/database/db.js';
import {
  authenticateRequest,
  checkStudentAccess,
  ParentAccessError,
  requireParent,
  requirePermission,
} from '../../shared/middleware/auth.middleware.js';
import type { PermissionKey } from '../../shared/types/index.js';
import type { PdfExportQueueHandle } from '../billing/billing.queue.js';
import { buildFinanceService, FinanceModuleError } from './finance.service.js';
import { buildPaymentImportService, PaymentImportError } from './payment-import.service.js';
import {
  cancelPaymentBodySchema,
  createSubscriptionPlanBodySchema,
  grantTuitionOverrideBodySchema,
  parentReceiptParamsSchema,
  paymentIdParamsSchema,
  recordPaymentBodySchema,
  schoolYearQuerySchema,
  studentFinancialParamsSchema,
  subscriptionPlanParamsSchema,
  tuitionPlanLevelParamsSchema,
  tuitionPlansQuerySchema,
  updateSubscriptionPlanBodySchema,
  upsertProviderSettingBodySchema,
  upsertTuitionPlanBodySchema,
  cashJournalQuerySchema,
  cashJournalExportQuerySchema,
  paymentMappingProfileBodySchema,
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
  if (error instanceof PaymentImportError) {
    return reply.code(error.statusCode).send({
      error: error.message, code: error.code, statusCode: error.statusCode,
    });
  }
  if (error instanceof ParentAccessError) {
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
  paymentId: string,
  parentId?: string,
): Promise<string | number | undefined> => {
  const job = await queue.add('tuition-receipt', {
    type: 'tuition-receipt',
    schemaName,
    paymentId,
    ...(parentId ? { parentId } : {}),
  }, { removeOnComplete: 100, removeOnFail: 100 });
  return job.id;
};

const readExcelFile = async (request: FastifyRequest): Promise<Buffer> => {
  let fileBuffer: Buffer | null = null;
  const parts = request.parts();
  for await (const part of parts) {
    if (part.type === 'file' && part.file && fileBuffer === null) fileBuffer = await part.toBuffer();
  }
  if (!fileBuffer) throw new PaymentImportError('Fichier Excel manquant', 400, 'IMPORT_FILE_REQUIRED');
  return fileBuffer;
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

  app.get('/api/v1/students/:studentId/payments', { preHandler: requirePermission('payments.view') }, async (request, reply) => {
    try {
      const { studentId } = studentFinancialParamsSchema.parse(request.params);
      const { school_year_id: schoolYearId } = schoolYearQuerySchema.parse(request.query);
      return reply.send({ payments: await withService(request, (service) =>
        service.listPayments(studentId, schoolYearId)) });
    } catch (error) { return handleError(request, reply, error); }
  });

  app.get('/api/v1/students/:studentId/account-statement', { preHandler: requirePermission('payments.view') }, async (request, reply) => {
    try {
      const { studentId } = studentFinancialParamsSchema.parse(request.params);
      const { school_year_id: schoolYearId } = schoolYearQuerySchema.parse(request.query);
      return reply.send({ statement: await withService(request, (service) =>
        service.getStudentAccountStatement(studentId, schoolYearId)) });
    } catch (error) { return handleError(request, reply, error); }
  });

  app.get('/api/v1/payments/cash-journal', { preHandler: requirePermission('payments.view') }, async (request, reply) => {
    try {
      const query = cashJournalQuerySchema.parse(request.query ?? {});
      return reply.send({ journal: await withService(request, (service) => service.getCashJournal({
        schoolYearId: query.school_year_id, from: query.from, to: query.to,
        classId: query.class_id, method: query.method,
      })) });
    } catch (error) { return handleError(request, reply, error); }
  });

  app.get('/api/v1/payments/cash-journal/export', { preHandler: requirePermission('payments.view') }, async (request, reply) => {
    try {
      const query = cashJournalExportQuerySchema.parse(request.query ?? {});
      const filter = {
        schoolYearId: query.school_year_id, from: query.from, to: query.to,
        classId: query.class_id, method: query.method,
      };
      if (query.format === 'xlsx') {
        const bytes = await withService(request, (service) => service.exportCashJournalExcel(filter));
        reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        reply.header('Content-Disposition', 'attachment; filename="journal-caisse.xlsx"');
        return reply.send(bytes);
      }
      const job = await pdfQueue.add('cash-journal', {
        type: 'cash-journal', schemaName: request.claims!.schemaName,
        schoolYearId: query.school_year_id, from: query.from, to: query.to,
        classId: query.class_id, method: query.method,
      }, { removeOnComplete: 100, removeOnFail: 100 });
      return reply.code(202).send({ jobId: job.id });
    } catch (error) { return handleError(request, reply, error); }
  });

  app.get('/api/v1/payment-import/profile', { preHandler: requirePermission('payments.record') }, async (request, reply) => {
    try {
      return reply.send({ profile: await withTenantSchema(request.claims!.schemaName, (db) =>
        buildPaymentImportService(db).getProfile()) });
    } catch (error) { return handleError(request, reply, error); }
  });

  app.put('/api/v1/payment-import/profile', { preHandler: requirePermission('payments.record') }, async (request, reply) => {
    try {
      const body = paymentMappingProfileBodySchema.parse(request.body);
      const profile = await withTenantSchema(request.claims!.schemaName, (db) =>
        buildPaymentImportService(db).saveProfile({
          label: body.label,
          actorUserId: request.user!.userId,
          fields: body.fields.map((field) => ({ ...field, isRequired: true })),
        }));
      return reply.send({ profile });
    } catch (error) { return handleError(request, reply, error); }
  });

  app.post('/api/v1/payment-import/analyze', { preHandler: requirePermission('payments.record') }, async (request, reply) => {
    try {
      const file = await readExcelFile(request);
      return reply.send(await withTenantSchema(request.claims!.schemaName, (db) =>
        buildPaymentImportService(db).analyze(file)));
    } catch (error) { return handleError(request, reply, error); }
  });

  app.post('/api/v1/payment-import/preview', { preHandler: requirePermission('payments.record') }, async (request, reply) => {
    try {
      const file = await readExcelFile(request);
      return reply.send(await withTenantSchema(request.claims!.schemaName, (db) =>
        buildPaymentImportService(db).preview(file)));
    } catch (error) { return handleError(request, reply, error); }
  });

  app.post('/api/v1/payment-import/confirm', { preHandler: requirePermission('payments.record') }, async (request, reply) => {
    try {
      const file = await readExcelFile(request);
      const result = await withTenantSchema(request.claims!.schemaName, (db) =>
        buildPaymentImportService(db).confirm(file, request.user!.userId));
      return reply.code(201).send(result);
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
        service.listTuitionPlans(query.school_year_id, query.level_id)) });
    } catch (error) { return handleError(request, reply, error); }
  });

  app.put('/api/v1/tuition-plans/levels/:levelId', { preHandler: requirePermission('tuition.edit') }, async (request, reply) => {
    try {
      const { levelId } = tuitionPlanLevelParamsSchema.parse(request.params);
      const body = upsertTuitionPlanBodySchema.parse(request.body);
      return reply.send({ tuitionPlan: await withService(request, (service) =>
        service.upsertTuitionPlan(levelId, body)) });
    } catch (error) { return handleError(request, reply, error); }
  });

  app.get('/api/v1/payment-provider-settings/status', { preHandler: authenticateRequest }, async (request, reply) => {
    try {
      return reply.send(await withService(request, (service) => service.getProviderAvailability()));
    } catch (error) { return handleError(request, reply, error); }
  });

  app.get('/api/v1/parent/payment-options', { preHandler: requireParent }, async (request, reply) => {
    try {
      return reply.send(await withService(request, (service) => service.getParentPaymentOptions()));
    } catch (error) { return handleError(request, reply, error); }
  });

  app.get('/api/v1/parent/students/:studentId/financial-status', { preHandler: requireParent }, async (request, reply) => {
    try {
      const { studentId } = studentFinancialParamsSchema.parse(request.params);
      checkStudentAccess(request, studentId);
      const { school_year_id: schoolYearId } = schoolYearQuerySchema.parse(request.query);
      return reply.send({ financialStatus: await withService(request, (service) =>
        service.getFinancialStatus(studentId, schoolYearId)) });
    } catch (error) { return handleError(request, reply, error); }
  });

  app.get('/api/v1/parent/students/:studentId/payments', { preHandler: requireParent }, async (request, reply) => {
    try {
      const { studentId } = studentFinancialParamsSchema.parse(request.params);
      checkStudentAccess(request, studentId);
      const { school_year_id: schoolYearId } = schoolYearQuerySchema.parse(request.query);
      return reply.send({ payments: await withService(request, (service) =>
        service.listPayments(studentId, schoolYearId)) });
    } catch (error) { return handleError(request, reply, error); }
  });

  app.get('/api/v1/parent/students/:studentId/account-statement', { preHandler: requireParent }, async (request, reply) => {
    try {
      const { studentId } = studentFinancialParamsSchema.parse(request.params);
      checkStudentAccess(request, studentId);
      const { school_year_id: schoolYearId } = schoolYearQuerySchema.parse(request.query);
      return reply.send({ statement: await withService(request, (service) =>
        service.getStudentAccountStatement(studentId, schoolYearId)) });
    } catch (error) { return handleError(request, reply, error); }
  });

  app.post('/api/v1/parent/students/:studentId/payments/:id/receipt', { preHandler: requireParent }, async (request, reply) => {
    try {
      const { studentId, id } = parentReceiptParamsSchema.parse(request.params);
      checkStudentAccess(request, studentId);
      await withService(request, (service) => service.assertPaymentBelongsToStudent(id, studentId));
      const jobId = await enqueueReceipt(pdfQueue, request.claims!.schemaName, id, request.parentId!);
      return reply.code(202).send({ jobId });
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
