import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import { withTenantSchema } from '../../shared/database/db.js';
import { requirePermission, requireTeacher } from '../../shared/middleware/auth.middleware.js';
import {
  buildConductService,
  ConductModuleError,
} from './conduct.service.js';
import {
  conductGradeBodySchema,
  conductInputBodySchema,
  conductOverviewQuerySchema,
  conductStudentParamsSchema,
  educatorAssignmentBodySchema,
  educatorAssignmentParamsSchema,
} from './conduct.types.js';

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
  if (error instanceof ConductModuleError) {
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
  request.log.error({ err: error }, '[conduct] Unexpected error');
  return reply.code(500).send({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
    statusCode: 500,
  });
};

export default async function conductController(app: FastifyInstance): Promise<void> {
  // ── Assignations éducateur (gestion des rôles) ────────────────────────────
  app.get(
    '/api/v1/conduct/educator-assignments',
    { preHandler: requirePermission('settings.positions') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const result = await withTenantSchema(claims.schemaName, (tenantDb) =>
          buildConductService(tenantDb).listEducatorAssignments()
        );
        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.post(
    '/api/v1/conduct/educator-assignments',
    { preHandler: requirePermission('settings.positions') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const body = educatorAssignmentBodySchema.parse(request.body ?? {});
        const result = await withTenantSchema(claims.schemaName, (tenantDb) =>
          buildConductService(tenantDb).createEducatorAssignment(body, {
            assignedBy: request.user!.userId,
          })
        );
        return reply.code(201).send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.delete(
    '/api/v1/conduct/educator-assignments/:id',
    { preHandler: requirePermission('settings.positions') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const params = educatorAssignmentParamsSchema.parse(request.params ?? {});
        const result = await withTenantSchema(claims.schemaName, (tenantDb) =>
          buildConductService(tenantDb).deleteEducatorAssignment(params.id)
        );
        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  // ── Saisie conduite par le prof ───────────────────────────────────────────
  app.post(
    '/api/v1/conduct/inputs',
    { preHandler: requireTeacher },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const body = conductInputBodySchema.parse(request.body ?? {});
        await withTenantSchema(claims.schemaName, (tenantDb) =>
          buildConductService(tenantDb).submitTeacherConductInput(body, {
            userId: request.user!.userId,
          })
        );
        return reply.code(201).send({ success: true });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  // ── Consultation + décision finale par l'éducateur ───────────────────────
  app.get(
    '/api/v1/conduct/students/:studentId/overview',
    { preHandler: requirePermission('conduct.finalize') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const params = conductStudentParamsSchema.parse(request.params ?? {});
        const query = conductOverviewQuerySchema.parse(request.query ?? {});
        const result = await withTenantSchema(claims.schemaName, (tenantDb) =>
          buildConductService(tenantDb).getConductOverview(params.studentId, query.grading_period_id)
        );
        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.put(
    '/api/v1/conduct/grades',
    { preHandler: requirePermission('conduct.finalize') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const body = conductGradeBodySchema.parse(request.body ?? {});
        await withTenantSchema(claims.schemaName, (tenantDb) =>
          buildConductService(tenantDb).decideConductGrade(body, {
            userId: request.user!.userId,
          })
        );
        return reply.send({ success: true });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );
}
