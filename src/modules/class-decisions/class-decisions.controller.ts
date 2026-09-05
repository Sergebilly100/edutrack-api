import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import { withTenantSchema } from '../../shared/database/db.js';
import { requirePermission } from '../../shared/middleware/auth.middleware.js';
import {
  buildClassDecisionsService,
  ClassDecisionsModuleError,
} from './class-decisions.service.js';
import {
  classDecisionStudentParamsSchema,
  listClassDecisionsQuerySchema,
  validateClassDecisionBodySchema,
} from './class-decisions.types.js';

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
  if (error instanceof ClassDecisionsModuleError) {
    return reply.code(error.statusCode).send({
      error: error.message,
      code: error.code,
      statusCode: error.statusCode,
    });
  }
  request.log.error({ err: error }, '[class-decisions] Unexpected error');
  return reply.code(500).send({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
    statusCode: 500,
  });
};

export default async function classDecisionsController(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/class-decisions/review-status',
    { preHandler: requirePermission('class_decisions.view') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const result = await withTenantSchema(claims.schemaName, (tenantDb) =>
          buildClassDecisionsService(tenantDb).getReviewStatus()
        );
        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.get(
    '/api/v1/class-decisions',
    { preHandler: requirePermission('class_decisions.view') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const query = listClassDecisionsQuerySchema.parse(request.query ?? {});
        const result = await withTenantSchema(claims.schemaName, (tenantDb) =>
          buildClassDecisionsService(tenantDb).listDecisions({
            levelId: query.level_id,
            classId: query.class_id,
          })
        );
        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.patch(
    '/api/v1/class-decisions/:studentId',
    { preHandler: requirePermission('class_decisions.validate') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const params = classDecisionStudentParamsSchema.parse(request.params ?? {});
        const body = validateClassDecisionBodySchema.parse(request.body ?? {});
        const decision = await withTenantSchema(claims.schemaName, (tenantDb) =>
          buildClassDecisionsService(tenantDb).validateDecision(
            params.studentId,
            body,
            request.user!.userId
          )
        );
        return reply.send({ decision });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );
}
