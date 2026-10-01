import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import { withTenantSchema } from '../../shared/database/db.js';
import { withReadyConductTenant } from '../../shared/database/conduct-ready.js';
import { isMissingConductMigration } from '../../shared/database/conduct-migration-contract.js';
import { authenticateRequest, requirePermission, requireTeacher } from '../../shared/middleware/auth.middleware.js';
import {
  buildConductService,
  ConductModuleError,
} from './conduct.service.js';
import {
  conductGradeBodySchema,
  conductInputBodySchema,
  conductInputScopeQuerySchema,
  bulkConductInputBodySchema,
  conductOverviewQuerySchema,
  conductStudentParamsSchema,
  educatorAssignmentBodySchema,
  educatorAssignmentParamsSchema,
  conductPolicyBodySchema,
  conductPolicyParamsSchema,
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
  if (isMissingConductMigration(error)) {
    return reply.code(503).send({
      error: 'Migration de conduite requise pour cette école',
      code: 'CONDUCT_MIGRATION_REQUIRED',
      statusCode: 503,
    });
  }
  return reply.code(500).send({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
    statusCode: 500,
  });
};

const requireConductPolicyView = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  await authenticateRequest(request, reply);
  if (reply.sent) return;
  const permissions = request.permissions;
  if (!permissions?.has('school_years.view') && !permissions?.has('school_years.edit') && !permissions?.has('settings.positions')) {
    reply.code(403).send({ error: 'Permission required', code: 'FORBIDDEN', statusCode: 403 });
  }
};

export default async function conductController(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/conduct/policy/:schoolYearId', { preHandler: requireConductPolicyView }, async (request, reply) => {
    try {
      const { schoolYearId } = conductPolicyParamsSchema.parse(request.params ?? {});
      const result = await withReadyConductTenant(request.claims!.schemaName, db => buildConductService(db).getPolicy(schoolYearId));
      return reply.send(result);
    } catch (error) { return handleError(request, reply, error); }
  });

  app.put('/api/v1/conduct/policy/:schoolYearId', { preHandler: requirePermission('school_years.edit') }, async (request, reply) => {
    try {
      const { schoolYearId } = conductPolicyParamsSchema.parse(request.params ?? {});
      const body = conductPolicyBodySchema.parse(request.body ?? {});
      const result = await withReadyConductTenant(request.claims!.schemaName, db =>
        buildConductService(db).updatePolicy(schoolYearId, body.mode, body.coefficient, request.user!.userId));
      return reply.send(result);
    } catch (error) { return handleError(request, reply, error); }
  });

  app.get('/api/v1/conduct/decision-classes', { preHandler: authenticateRequest }, async (request, reply) => {
    try {
      const result = await withReadyConductTenant(request.claims!.schemaName, db => buildConductService(db).listDecisionClasses({
        userId: request.user!.userId, canFinalize: request.permissions?.has('conduct.finalize') === true,
      }));
      return reply.send(result);
    } catch (error) { return handleError(request, reply, error); }
  });

  app.get('/api/v1/conduct/decision-students', { preHandler: authenticateRequest }, async (request, reply) => {
    try {
      const query = conductInputScopeQuerySchema.parse(request.query ?? {});
      const result = await withReadyConductTenant(request.claims!.schemaName, db => buildConductService(db).listDecisionStudents(
        query.class_id, query.grading_period_id,
        { userId: request.user!.userId, canFinalize: request.permissions?.has('conduct.finalize') === true },
      ));
      return reply.send(result);
    } catch (error) { return handleError(request, reply, error); }
  });

  app.get('/api/v1/conduct/eligible-educators', { preHandler: requirePermission('settings.positions') }, async (request, reply) => {
    try {
      const result = await withTenantSchema(request.claims!.schemaName, db => buildConductService(db).listEligibleEducators());
      return reply.send(result);
    } catch (error) { return handleError(request, reply, error); }
  });
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
  app.get(
    '/api/v1/conduct/inputs/scope',
    { preHandler: requireTeacher },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const query = conductInputScopeQuerySchema.parse(request.query ?? {});
        const result = await withTenantSchema(claims.schemaName, (tenantDb) =>
          buildConductService(tenantDb).getTeacherConductScope(
            query.class_id,
            query.grading_period_id,
            { userId: request.user!.userId }
          )
        );
        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

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

  app.post(
    '/api/v1/conduct/inputs/bulk',
    { preHandler: requireTeacher },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const body = bulkConductInputBodySchema.parse(request.body ?? {});
        const result = await withTenantSchema(claims.schemaName, (tenantDb) =>
          tenantDb.transaction((tx) =>
            buildConductService(tx).submitBulkTeacherConductInputs(body, {
              userId: request.user!.userId,
            })
          )
        );
        return reply.code(201).send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  // ── Consultation + décision finale par l'éducateur ───────────────────────
  app.get(
    '/api/v1/conduct/students/:studentId/overview',
    { preHandler: authenticateRequest },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const params = conductStudentParamsSchema.parse(request.params ?? {});
        const query = conductOverviewQuerySchema.parse(request.query ?? {});
        const result = await withReadyConductTenant(claims.schemaName, (tenantDb) =>
          buildConductService(tenantDb).getConductOverview(params.studentId, query.grading_period_id, {
            userId: request.user!.userId,
            canFinalize: request.permissions?.has('conduct.finalize') === true,
          })
        );
        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.put(
    '/api/v1/conduct/grades',
    { preHandler: authenticateRequest },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const body = conductGradeBodySchema.parse(request.body ?? {});
        await withReadyConductTenant(claims.schemaName, (tenantDb) =>
          buildConductService(tenantDb).decideConductGrade(body, {
            userId: request.user!.userId,
            canFinalize: request.permissions?.has('conduct.finalize') === true,
          })
        );
        return reply.send({ success: true });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );
}
