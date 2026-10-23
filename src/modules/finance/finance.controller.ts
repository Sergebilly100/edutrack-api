import { dateValidationProblem } from '../../shared/utils/date-validation.js';
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
import { RecoveryRepository } from './recovery.repository.js';
import { RecoveryService, RecoveryError } from './recovery.service.js';
import {
  cancelPaymentBodySchema,
  createSubscriptionPlanBodySchema,
  grantTuitionOverrideBodySchema,
  withdrawTuitionOverrideBodySchema,
  parentReceiptParamsSchema,
  paymentIdParamsSchema,
  recordPaymentBodySchema,
  schoolYearQuerySchema,
  financialSummaryQuerySchema,
  recoveryQuerySchema,
  recoveryStudentsQuerySchema,
  classFinancialStatusQuerySchema,
  upsertFinancialAlertRuleBodySchema,
  financialAlertRuleTypeParamsSchema,
  studentFinancialParamsSchema,
  subscriptionPlanParamsSchema,
  tuitionPlanLevelParamsSchema,
  tuitionPlansQuerySchema,
  updateSubscriptionPlanBodySchema,
  upsertProviderSettingBodySchema,
  upsertTuitionPlanBodySchema,
  upsertStudentTuitionScheduleBodySchema,
  resetStudentTuitionScheduleBodySchema,
  cashJournalQuerySchema,
  cashJournalExportQuerySchema,
  paymentHistoryQuerySchema,
  financialAlertLogsQuerySchema,
  paymentMappingProfileBodySchema,
} from './finance.types.js';

const handleError = (request: FastifyRequest, reply: FastifyReply, error: unknown) => {
  if (error instanceof ZodError) {
    const dateProblem = dateValidationProblem(error);
    if (dateProblem) return reply.code(400).send(dateProblem);
    return reply.code(400).send({
      error: 'Invalid request', code: 'VALIDATION_ERROR', statusCode: 400, details: error.issues,
    });
  }
  if (error instanceof FinanceModuleError) {
    return reply.code(error.statusCode).send({
      error: error.message, code: error.code, statusCode: error.statusCode,
      ...(error.context ? { context: error.context } : {}),
    });
  }
  if (error instanceof PaymentImportError) {
    return reply.code(error.statusCode).send({
      error: error.message, code: error.code, statusCode: error.statusCode,
    });
  }
  if (error instanceof RecoveryError) {
    return reply.code(error.statusCode).send({ error: error.message, code: error.code, statusCode: error.statusCode });
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

const financialAggregateProperties = {
  total_expected_to_date: { type: 'string' },
  total_paid: { type: 'string' },
  remaining_to_collect: { type: 'string' },
  annual_total_due: {
    type: 'string',
    description: 'Somme des total_due_year du snapshot des élèves confirmés, après remises; abonnements obligatoires exclus.',
  },
  annual_remaining: {
    type: 'string',
    description: 'annual_total_due moins les paiements confirmés, sans plancher à zéro.',
  },
  upcoming_due: {
    type: 'string',
    description: 'annual_remaining moins remaining_to_collect (le reste à recouvrer à date existant), sans plancher à zéro.',
  },
  students_up_to_date_count: { type: 'integer' },
  students_late_count: { type: 'integer' },
  last_computed_at: { type: 'string' },
} as const;

const financialSummaryResponseSchema = {
  type: 'object',
  properties: {
    school: {
      anyOf: [
        {
          type: 'object',
          properties: {
            ...financialAggregateProperties,
            recovery_rate: { type: 'string' },
            previous_period_total_paid: { type: 'string' },
          },
          additionalProperties: true,
        },
        { type: 'null' },
      ],
    },
    classes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          class_id: { type: 'string' },
          class_name: { type: 'string' },
          level_id: { type: 'string' },
          level_name: { type: 'string' },
          ...financialAggregateProperties,
        },
        additionalProperties: true,
      },
    },
    levels: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          level_id: { type: 'string' },
          level_name: { type: 'string' },
          ...financialAggregateProperties,
        },
        additionalProperties: true,
      },
    },
    collections: { type: 'array', items: { type: 'object', additionalProperties: true } },
    paymentMethods: { type: 'array', items: { type: 'object', additionalProperties: true } },
    upcomingInstallments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          due_date: { type: 'string' },
          expected_amount: { type: 'string', description: 'Montant restant dû à cette échéance après affectation FIFO des paiements confirmés.' },
          student_count: { type: 'integer' },
        },
        required: ['due_date', 'expected_amount', 'student_count'],
        additionalProperties: false,
      },
    },
    installmentScheduleComplete: { type: 'boolean' },
    aging: {
      anyOf: [
        {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              bucket: { type: 'string', enum: ['0-30', '31-60', '>60'] },
              total_amount: { type: 'string' },
              student_count: { type: 'integer' },
            },
            required: ['bucket', 'total_amount', 'student_count'],
            additionalProperties: false,
          },
        },
        { type: 'null' },
      ],
      description: 'Soldes échus restant dus par ancienneté, après affectation FIFO des paiements confirmés.',
    },
    recentPayments: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
  additionalProperties: true,
} as const;

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
      return reply.send({ journal: await withService(request, (service) => service.getPaginatedCashJournal({
        schoolYearId: query.school_year_id, from: query.from, to: query.to,
        classId: query.class_id, method: query.method, page: query.page, limit: query.limit,
      })) });
    } catch (error) { return handleError(request, reply, error); }
  });

  app.get('/api/v1/finance/payment-history', { preHandler: requirePermission('payments.view') }, async (request, reply) => {
    try {
      const query = paymentHistoryQuerySchema.parse(request.query ?? {});
      return reply.send({ history: await withService(request, (service) => service.getPaginatedPaymentHistory({
        schoolYearId: query.school_year_id,
        from: query.from,
        to: query.to,
        levelId: query.level_id,
        classId: query.class_id,
        status: query.status,
        page: query.page,
        limit: query.limit,
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

  // ── Relances de paiement (Tâche 6b) ────────────────────────────────────────
  app.get(
    '/api/v1/financial-alert-rules',
    { preHandler: requirePermission('payments.view') },
    async (request, reply) => {
      try {
        const rules = await withService(request, (service) =>
          service.listFinancialAlertRules()
        );
        return reply.send({ rules });
      } catch (error) { return handleError(request, reply, error); }
    }
  );

  app.put(
    '/api/v1/financial-alert-rules/:type',
    { preHandler: requirePermission('financial_alerts.edit') },
    async (request, reply) => {
      try {
        const params = financialAlertRuleTypeParamsSchema.parse(request.params);
        const body = upsertFinancialAlertRuleBodySchema.parse(request.body);
        await withService(request, (service) =>
          service.upsertFinancialAlertRule(params.type, body, request.user!.userId)
        );
        return reply.send({ success: true });
      } catch (error) { return handleError(request, reply, error); }
    }
  );

  app.delete(
    '/api/v1/financial-alert-rules/:id',
    { preHandler: requirePermission('financial_alerts.edit') },
    async (request, reply) => {
      try {
        const { id } = paymentIdParamsSchema.parse(request.params);
        const deleted = await withService(request, (service) => service.deleteFinancialAlertRule(id));
        return reply.send({ deleted });
      } catch (error) { return handleError(request, reply, error); }
    }
  );

  app.get(
    '/api/v1/financial-alert-logs',
    { preHandler: requirePermission('payments.view') },
    async (request, reply) => {
      try {
        const query = financialAlertLogsQuerySchema.parse(request.query ?? {});
        const result = await withService(request, (service) => service.listFinancialAlertLogs(query));
        return reply.send(result);
      } catch (error) { return handleError(request, reply, error); }
    }
  );

  // ── Cache financier (Tâche 6a) ─────────────────────────────────────────────
  app.get('/api/v1/finance/recovery/years', { preHandler: requirePermission('payments.view') }, async (request, reply) => {
    try {
      const result = await withTenantSchema(request.claims!.schemaName, (db) =>
        new RecoveryService(new RecoveryRepository(db)).getYears());
      return reply.send(result);
    } catch (error) { return handleError(request, reply, error); }
  });

  app.get('/api/v1/finance/recovery', { preHandler: requirePermission('payments.view') }, async (request, reply) => {
    try {
      const query = recoveryQuerySchema.parse(request.query ?? {});
      const result = await withTenantSchema(request.claims!.schemaName, (db) =>
        new RecoveryService(new RecoveryRepository(db)).getSummary(query.school_year_id, query.level_id, query.class_id));
      return reply.send(result);
    } catch (error) { return handleError(request, reply, error); }
  });

  app.get('/api/v1/finance/recovery/class-students', { preHandler: requirePermission('payments.view') }, async (request, reply) => {
    try {
      const query = recoveryStudentsQuerySchema.parse(request.query ?? {});
      const result = await withTenantSchema(request.claims!.schemaName, (db) =>
        new RecoveryService(new RecoveryRepository(db)).getClassStudents(
          query.school_year_id, query.class_id, query.level_id, query.page, query.limit));
      return reply.send(result);
    } catch (error) { return handleError(request, reply, error); }
  });

  app.get(
    '/api/v1/finance/financial-summary',
    {
      preHandler: requirePermission('payments.view'),
      schema: {
        tags: ['finance'],
        summary: 'Read school, level, and class financial aggregates',
        querystring: {
          type: 'object',
          properties: { school_year_id: { type: 'string', format: 'uuid' } },
          additionalProperties: true,
        },
        response: { 200: financialSummaryResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        const query = financialSummaryQuerySchema.parse(request.query ?? {});
        const result = await withService(request, (service) =>
          Promise.all([
            service.getSchoolFinancialSummary(query.school_year_id),
            service.listClassFinancialSummaries(query.school_year_id),
            service.listLevelFinancialSummaries(query.school_year_id),
            service.listFinancialCollectionTrend(query.school_year_id),
            service.listFinancialPaymentMethods(query.school_year_id),
            service.getFinancialInstallmentSummary(query.school_year_id),
            service.listFinancialRecentPayments(query.school_year_id),
          ]).then(([school, classes, levels, collections, paymentMethods, installmentSummary, recentPayments]) => ({
            school,
            classes,
            levels,
            collections,
            paymentMethods,
            upcomingInstallments: installmentSummary.upcomingInstallments,
            installmentScheduleComplete: installmentSummary.scheduleComplete,
            aging: installmentSummary.aging,
            recentPayments,
          }))
        );
        return reply.send(result);
      } catch (error) { return handleError(request, reply, error); }
    }
  );

  app.post(
    '/api/v1/finance/recalculate',
    { preHandler: requirePermission('payments.view') },
    async (request, reply) => {
      try {
        const query = financialSummaryQuerySchema.parse(request.query ?? {});
        const result = await withService(request, (service) =>
          service.recalculateFinancialCache(query.school_year_id)
        );
        return reply.send({ result });
      } catch (error) { return handleError(request, reply, error); }
    }
  );

  app.get(
    '/api/v1/finance/class-students-status',
    { preHandler: requirePermission('payments.view') },
    async (request, reply) => {
      try {
        const query = classFinancialStatusQuerySchema.parse(request.query ?? {});
        const students = await withService(request, (service) =>
          service.listClassStudentStatuses(query.class_id, query.school_year_id)
        );
        return reply.send({ students });
      } catch (error) { return handleError(request, reply, error); }
    }
  );

  app.get(
    '/api/v1/students/:studentId/financial-cache',    { preHandler: requirePermission('payments.view') },
    async (request, reply) => {
      try {
        const { studentId } = studentFinancialParamsSchema.parse(request.params);
        const query = financialSummaryQuerySchema.parse(request.query ?? {});
        const cached = await withService(request, (service) =>
          service.getStudentFinancialCache(studentId, query.school_year_id)
        );
        return reply.send({ cached });
      } catch (error) { return handleError(request, reply, error); }
    }
  );

  app.post(
    '/api/v1/payments/:id/receipt',
    { preHandler: requirePermission('payments.view') },
    async (request, reply) => {
      const { id } = paymentIdParamsSchema.parse(request.params);
      await withService(request, (service) => service.getReceiptPayload(id));
      const jobId = await enqueueReceipt(pdfQueue, request.claims!.schemaName, id);
      return reply.code(202).send({ jobId });
    }
  );

  app.get('/api/v1/students/:studentId/financial-status', {
    preHandler: requireAnyPermission(['tuition.view', 'payments.view', 'payments.record']),
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
        actorRole: request.claims!.role,
      }));
      return reply.code(201).send(result);
    } catch (error) { return handleError(request, reply, error); }
  });

  app.get('/api/v1/tuition/overrides/:studentId/withdrawal-preview', { preHandler: requirePermission('tuition.grant_discount') }, async (request, reply) => {
    try { const { studentId } = studentFinancialParamsSchema.parse(request.params); const { school_year_id: schoolYearId } = schoolYearQuerySchema.parse(request.query); return reply.send(await withService(request, (service) => service.previewTuitionOverrideWithdrawal(studentId, schoolYearId))); } catch (error) { return handleError(request, reply, error); }
  });
  app.post('/api/v1/tuition/overrides/:studentId/withdraw', { preHandler: requirePermission('tuition.grant_discount') }, async (request, reply) => {
    try { const { studentId } = studentFinancialParamsSchema.parse(request.params); const body = withdrawTuitionOverrideBodySchema.parse(request.body); return reply.send(await withService(request, (service) => service.withdrawTuitionOverride({ studentId, ...body, actorUserId: request.user!.userId, actorRole: request.claims!.role }))); } catch (error) { return handleError(request, reply, error); }
  });

  app.get('/api/v1/tuition/student-schedules/:studentId', { preHandler: requireAnyPermission(['tuition.view', 'tuition.manage_student_schedule']) }, async (request, reply) => {
    try {
      const { studentId } = studentFinancialParamsSchema.parse(request.params);
      const { school_year_id: schoolYearId } = schoolYearQuerySchema.parse(request.query);
      return reply.send(await withService(request, (service) => service.getStudentTuitionSchedule(
        studentId,
        schoolYearId,
        request.permissions?.has('tuition.manage_student_schedule') === true,
      )));
    } catch (error) { return handleError(request, reply, error); }
  });

  app.put('/api/v1/tuition/student-schedules/:studentId', { preHandler: requirePermission('tuition.manage_student_schedule') }, async (request, reply) => {
    try {
      const { studentId } = studentFinancialParamsSchema.parse(request.params);
      const body = upsertStudentTuitionScheduleBodySchema.parse(request.body);
      return reply.send(await withService(request, (service) => service.replaceStudentTuitionSchedule({
        studentId,
        schoolYearId: body.schoolYearId,
        reason: body.reason,
        installments: body.installments,
        actorUserId: request.user!.userId,
        actorRole: request.claims!.role,
      })));
    } catch (error) { return handleError(request, reply, error); }
  });

  app.delete('/api/v1/tuition/student-schedules/:studentId', { preHandler: requirePermission('tuition.manage_student_schedule') }, async (request, reply) => {
    try {
      const { studentId } = studentFinancialParamsSchema.parse(request.params);
      const { school_year_id: schoolYearId } = schoolYearQuerySchema.parse(request.query);
      const body = resetStudentTuitionScheduleBodySchema.parse(request.body);
      return reply.send(await withService(request, (service) =>
        service.deleteStudentTuitionSchedule({
          studentId, schoolYearId, reason: body.reason,
          actorUserId: request.user!.userId, actorRole: request.claims!.role,
        })));
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
