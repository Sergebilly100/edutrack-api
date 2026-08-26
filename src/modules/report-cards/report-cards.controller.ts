import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import { withTenantSchema } from '../../shared/database/db.js';
import { requirePermission } from '../../shared/middleware/auth.middleware.js';
import { requireParent } from '../../shared/middleware/auth.middleware.js';
import {
  buildReportCardsService,
  ReportCardsModuleError,
} from './report-cards.service.js';
import {
  generateReportCardBodySchema,
  publishBulkBodySchema,
  readinessQuerySchema,
  reportCardIdParamsSchema,
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

export type ReportCardsControllerOptions = {
  pdfQueue?: PdfQueueHandle;
};

export default async function reportCardsController(
  app: FastifyInstance,
  options: ReportCardsControllerOptions = {}
): Promise<void> {
  // ── Génération / publication (direction) ─────────────────────────────────
  app.post(
    '/api/v1/report-cards/generate',
    { preHandler: requirePermission('report_cards.publish') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const body = generateReportCardBodySchema.parse(request.body ?? {});
        const result = await withTenantSchema(claims.schemaName, (tenantDb) =>
          buildReportCardsService(tenantDb).generateForClass(body.class_id, body.grading_period_id)
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
          buildReportCardsService(tenantDb).publish(params.id, request.user!.userId)
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
          buildReportCardsService(tenantDb).publishBulk(body.class_id!, body.grading_period_id, request.user!.userId)
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
