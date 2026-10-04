import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { z } from 'zod';

import { withTenantSchema } from '../../shared/database/db.js';
import { authenticateRequest, requirePermission } from '../../shared/middleware/auth.middleware.js';
import { requireParent } from '../../shared/middleware/auth.middleware.js';
import {
  buildReportCardsService,
  ReportCardsModuleError,
} from './report-cards.service.js';
import {
  generateReportCardBodySchema,
  publishBulkBodySchema,
  readinessQuerySchema,
  reportCardClassesQuerySchema,
  reportCardIdParamsSchema,
  createReportCardClaimBodySchema,
  decideReportCardClaimBodySchema,
  reportCardClaimQuerySchema,
  claimIdParamsSchema,
} from './report-cards.types.js';

const handleError = (
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown
): FastifyReply => {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: 'Invalid request',
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      details: error.issues,
    });
  }
  if (error instanceof ReportCardsModuleError) {
    return reply.code(error.statusCode).send({
      error: error.message,
      code: error.code,
      statusCode: error.statusCode,
    });
  }
  const moduleLike = error as { statusCode?: number; code?: string };
  if (typeof moduleLike?.statusCode === 'number' && typeof moduleLike?.code === 'string') {
    return reply.code(moduleLike.statusCode).send({
      error: error instanceof Error ? error.message : 'Error',
      code: moduleLike.code,
      statusCode: moduleLike.statusCode,
    });
  }
  request.log.error({ err: error }, '[report-cards] Unexpected error');
  return reply.code(500).send({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
    statusCode: 500,
  });
};

type PdfQueueHandle = {
  add: (
    name: string,
    data: Record<string, unknown>,
    options?: { removeOnComplete?: number; removeOnFail?: number }
  ) => Promise<{ id?: string | number }>;
};

const studentCardParamsSchema = z.object({
  studentId: z.string().uuid(),
  cardId: z.string().uuid().optional(),
});

const requireStudentReportAccess = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  await authenticateRequest(request, reply);
  if (reply.sent) return;
  if (!request.permissions?.has('report_cards.view') && !request.permissions?.has('enrollments.view')) {
    reply.code(403).send({ error: 'Accès aux bulletins refusé', code: 'FORBIDDEN', statusCode: 403 });
  }
};

const requireReportClaimAccess = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  await authenticateRequest(request, reply);
  if (reply.sent) return;
  if (!request.permissions?.has('report_cards.view') && !request.permissions?.has('report_cards.publish')) {
    reply.code(403).send({ error: 'Accès aux réclamations refusé', code: 'FORBIDDEN', statusCode: 403 });
  }
};

export type ReportCardsControllerOptions = {
  pdfQueue?: PdfQueueHandle;
};

export default async function reportCardsController(
  app: FastifyInstance,
  options: ReportCardsControllerOptions = {}
): Promise<void> {
  app.get('/api/v1/report-cards/classes', { preHandler: requirePermission('report_cards.view') }, async (request, reply) => {
    try {
      const { schoolYearId } = reportCardClassesQuerySchema.parse(request.query ?? {});
      const classes = await withTenantSchema(request.claims!.schemaName, (tenantDb) =>
        buildReportCardsService(tenantDb).listReportCardClasses(schoolYearId)
      );
      return reply.send({ classes });
    } catch (error) {
      return handleError(request, reply, error);
    }
  });
  app.get('/api/v1/report-cards/claims/students', { preHandler: requireReportClaimAccess }, async (request, reply) => {
    try {
      const { classId } = z.object({ classId: z.string().uuid() }).parse(request.query ?? {});
      const students = await withTenantSchema(request.claims!.schemaName, db => buildReportCardsService(db).listClaimStudents(classId));
      return reply.send({ students });
    } catch (error) { return handleError(request, reply, error); }
  });

  app.get('/api/v1/report-cards/claims', { preHandler: requireReportClaimAccess }, async (request, reply) => {
    try {
      const filters = reportCardClaimQuerySchema.parse(request.query ?? {});
      const claims = await withTenantSchema(request.claims!.schemaName, db => buildReportCardsService(db).listClaims(filters));
      return reply.send({ claims });
    } catch (error) { return handleError(request, reply, error); }
  });

  app.post('/api/v1/report-cards/claims', { preHandler: requireReportClaimAccess }, async (request, reply) => {
    try {
      const body = createReportCardClaimBodySchema.parse(request.body ?? {});
      const claim = await withTenantSchema(request.claims!.schemaName, db => buildReportCardsService(db).createClaim({ ...body, userId: request.user!.userId }));
      return reply.code(201).send({ claim });
    } catch (error) { return handleError(request, reply, error); }
  });

  app.post('/api/v1/report-cards/claims/:id/decision', { preHandler: requirePermission('report_cards.publish') }, async (request, reply) => {
    try {
      const { id } = claimIdParamsSchema.parse(request.params ?? {});
      const body = decideReportCardClaimBodySchema.parse(request.body ?? {});
      const claim = await withTenantSchema(request.claims!.schemaName, db => buildReportCardsService(db).decideClaim({
        claimId: id, ...body, userId: request.user!.userId, role: request.claims!.role,
        canPublish: request.permissions?.has('report_cards.publish') ?? false,
        canCorrectPublished: request.permissions?.has('report_cards.published_correction') ?? false,
      }));
      return reply.send({ claim });
    } catch (error) { return handleError(request, reply, error); }
  });

  app.get('/api/v1/report-cards/versions', { preHandler: requirePermission('report_cards.published_correction') }, async (request, reply) => {
    try {
      if (!['director', 'super_admin'].includes(request.claims!.role)) {
        return reply.code(403).send({ error: 'Accès à l’audit refusé', code: 'FORBIDDEN', statusCode: 403 });
      }
      const query = z.object({ classId: z.string().uuid(), gradingPeriodId: z.string().uuid() }).parse(request.query ?? {});
      const versions = await withTenantSchema(request.claims!.schemaName, db => buildReportCardsService(db).listVersions(query.classId, query.gradingPeriodId));
      return reply.send({ versions });
    } catch (error) { return handleError(request, reply, error); }
  });
  app.get('/api/v1/report-cards/audit', { preHandler: requirePermission('report_cards.published_correction') }, async (request, reply) => {
    try {
      if (!['director', 'super_admin'].includes(request.claims!.role)) {
        return reply.code(403).send({ error: 'Accès à l’audit refusé', code: 'FORBIDDEN', statusCode: 403 });
      }
      const query = z.object({ classId: z.string().uuid(), gradingPeriodId: z.string().uuid() }).parse(request.query ?? {});
      const entries = await withTenantSchema(request.claims!.schemaName, db => buildReportCardsService(db).listAcademicAudit(query.classId, query.gradingPeriodId));
      return reply.send({ entries });
    } catch (error) { return handleError(request, reply, error); }
  });
  app.get('/api/v1/report-cards/conduct-audit', { preHandler: requirePermission('report_cards.view') }, async (request, reply) => {
    try {
      const result = await withTenantSchema(request.claims!.schemaName, db => buildReportCardsService(db).listConductAmbiguities());
      return reply.send(result);
    } catch (error) { return handleError(request, reply, error); }
  });
  app.get(
    '/api/v1/students/:studentId/report-cards',
    { preHandler: requireStudentReportAccess },
    async (request, reply) => {
      try {
        const { studentId } = studentCardParamsSchema.parse(request.params ?? {});
        const cards = await withTenantSchema(request.claims!.schemaName, (tenantDb) =>
          buildReportCardsService(tenantDb).listPublishedForStudent(studentId)
        );
        return reply.send({ reportCards: cards });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.get(
    '/api/v1/students/:studentId/report-cards/:cardId',
    { preHandler: requireStudentReportAccess },
    async (request, reply) => {
      try {
        const { studentId, cardId } = studentCardParamsSchema.parse(request.params ?? {});
        const detail = await withTenantSchema(request.claims!.schemaName, (tenantDb) =>
          buildReportCardsService(tenantDb).getPublishedDetail(studentId, cardId!)
        );
        return reply.send({ reportCard: detail });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.post(
    '/api/v1/students/:studentId/report-cards/:cardId/pdf',
    { preHandler: requireStudentReportAccess },
    async (request, reply) => {
      try {
        if (!options.pdfQueue) {
          return reply.code(503).send({ error: 'File d’export PDF indisponible', code: 'PDF_QUEUE_UNAVAILABLE', statusCode: 503 });
        }
        const { studentId, cardId } = studentCardParamsSchema.parse(request.params ?? {});
        await withTenantSchema(request.claims!.schemaName, (tenantDb) =>
          buildReportCardsService(tenantDb).getPublishedDetail(studentId, cardId!)
        );
        const job = await options.pdfQueue.add(
          'report-card',
          { type: 'report-card', schemaName: request.claims!.schemaName, reportCardId: cardId },
          { removeOnComplete: 20, removeOnFail: 50 }
        );
        return reply.code(202).send({ jobId: job.id });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  // ── Génération / publication (direction) ─────────────────────────────────
  app.post(
    '/api/v1/report-cards/generate',
    { preHandler: requirePermission('report_cards.publish') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const body = generateReportCardBodySchema.parse(request.body ?? {});
        const result = await withTenantSchema(claims.schemaName, (tenantDb) =>
          tenantDb.transaction(tx => buildReportCardsService(tx).generateForClass(body.class_id, body.grading_period_id, request.user!.userId))
        );
        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.post(
    '/api/v1/report-cards/:id/publish',
    { preHandler: requirePermission('report_cards.publish') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const params = reportCardIdParamsSchema.parse(request.params ?? {});
        await withTenantSchema(claims.schemaName, (tenantDb) =>
          tenantDb.transaction(tx => buildReportCardsService(tx).publish(params.id, request.user!.userId))
        );
        return reply.send({ success: true });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.post(
    '/api/v1/report-cards/publish-bulk',
    { preHandler: requirePermission('report_cards.publish') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const body = publishBulkBodySchema.parse(request.body ?? {});
        if (!body.class_id) {
          return reply.code(400).send({
            error: 'class_id requis : la publication en masse se fait classe par classe ou via plusieurs appels',
            code: 'CLASS_ID_REQUIRED',
            statusCode: 400,
          });
        }
        const result = await withTenantSchema(claims.schemaName, (tenantDb) =>
          tenantDb.transaction(tx => buildReportCardsService(tx).publishBulk(body.class_id!, body.grading_period_id, request.user!.userId))
        );
        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.get(
    '/api/v1/report-cards/readiness',
    { preHandler: requirePermission('report_cards.view') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const query = readinessQuerySchema.parse(request.query ?? {});
        const result = await withTenantSchema(claims.schemaName, (tenantDb) =>
          buildReportCardsService(tenantDb).getReadinessForPeriod(query.grading_period_id)
        );
        return reply.send({ classes: result });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.get(
    '/api/v1/report-cards/class/:classId',
    { preHandler: requirePermission('report_cards.view') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const classId = (request.params as { classId?: string }).classId ?? '';
        const query = readinessQuerySchema.parse({ grading_period_id: (request.query as { grading_period_id?: string }).grading_period_id });
        const cards = await withTenantSchema(claims.schemaName, (tenantDb) =>
          buildReportCardsService(tenantDb).listClassCards(classId, query.grading_period_id)
        );
        return reply.send({ reportCards: cards });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.get(
    '/api/v1/report-cards/:id',
    { preHandler: requirePermission('report_cards.view') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const params = reportCardIdParamsSchema.parse(request.params ?? {});
        const result = await withTenantSchema(claims.schemaName, (tenantDb) =>
          buildReportCardsService(tenantDb).getDetail(params.id)
        );
        return reply.send({ reportCard: result });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.post(
    '/api/v1/report-cards/:id/pdf',
    { preHandler: requirePermission('report_cards.view') },
    async (request, reply) => {
      try {
        if (!options.pdfQueue) {
          return reply.code(503).send({
            error: 'File d\u2019export PDF indisponible',
            code: 'PDF_QUEUE_UNAVAILABLE',
            statusCode: 503,
          });
        }
        const claims = request.claims!;
        const params = reportCardIdParamsSchema.parse(request.params ?? {});
        const job = await options.pdfQueue.add(
          'report-card',
          { type: 'report-card', schemaName: claims.schemaName, reportCardId: params.id },
          { removeOnComplete: 20, removeOnFail: 50 }
        );
        return reply.code(202).send({ jobId: job.id });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.post(
    '/api/v1/parent/students/:studentId/report-cards/:cardId/pdf',
    { preHandler: requireParent },
    async (request, reply) => {
      try {
        if (!options.pdfQueue) {
          return reply.code(503).send({
            error: 'File d\u2019export PDF indisponible',
            code: 'PDF_QUEUE_UNAVAILABLE',
            statusCode: 503,
          });
        }
        const allowedStudentIds = request.allowedStudentIds ?? [];
        const studentId = (request.params as { studentId?: string }).studentId ?? '';
        const cardId = (request.params as { cardId?: string }).cardId ?? '';
        if (!allowedStudentIds.includes(studentId)) {
          return reply.code(403).send({
            error: 'Cet élève n\u2019est pas rattaché à votre compte',
            code: 'STUDENT_NOT_ALLOWED',
            statusCode: 403,
          });
        }
        // Seuls les bulletins publiés sont téléchargeables par un parent.
        const detail = await withTenantSchema(request.claims!.schemaName, (tenantDb) =>
          buildReportCardsService(tenantDb).getPublishedDetail(studentId, cardId)
        );
        void detail;
        const job = await options.pdfQueue.add(
          'report-card',
          { type: 'report-card', schemaName: request.claims!.schemaName, reportCardId: cardId, parentId: request.claims!.sub },
          { removeOnComplete: 20, removeOnFail: 50 }
        );
        return reply.code(202).send({ jobId: job.id });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  // ── Portail parent (bulletins publiés uniquement) ─────────────────────────
  app.get(
    '/api/v1/parent/students/:studentId/report-cards',
    { preHandler: requireParent },
    async (request, reply) => {
      try {
        const allowedStudentIds = request.allowedStudentIds ?? [];
        const studentId = (request.params as { studentId?: string }).studentId ?? '';
        if (!allowedStudentIds.includes(studentId)) {
          return reply.code(403).send({
            error: 'Cet élève n\u2019est pas rattaché à votre compte',
            code: 'STUDENT_NOT_ALLOWED',
            statusCode: 403,
          });
        }

        const result = await withTenantSchema(request.claims!.schemaName, async (tenantDb) => {
          const service = buildReportCardsService(tenantDb);
          const [reportCards, inRevision] = await Promise.all([
            service.listPublishedForStudent(studentId), service.isStudentReportInRevision(studentId),
          ]);
          return { reportCards, inRevision };
        });
        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.get(
    '/api/v1/parent/students/:studentId/report-cards/:cardId',
    { preHandler: requireParent },
    async (request, reply) => {
      try {
        const allowedStudentIds = request.allowedStudentIds ?? [];
        const studentId = (request.params as { studentId?: string }).studentId ?? '';
        const cardId = (request.params as { cardId?: string }).cardId ?? '';
        if (!allowedStudentIds.includes(studentId)) {
          return reply.code(403).send({
            error: 'Cet élève n\u2019est pas rattaché à votre compte',
            code: 'STUDENT_NOT_ALLOWED',
            statusCode: 403,
          });
        }

        const detail = await withTenantSchema(request.claims!.schemaName, (tenantDb) =>
          buildReportCardsService(tenantDb).getPublishedDetail(studentId, cardId)
        );
        return reply.send({ reportCard: detail });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );
}
