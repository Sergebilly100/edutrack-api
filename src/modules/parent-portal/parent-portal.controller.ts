import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import { withTenantSchema } from '../../shared/database/db.js';
import {
  checkStudentAccess,
  ParentAccessError,
  requireParent,
} from '../../shared/middleware/auth.middleware.js';

import {
  parentAbsencesQuerySchema,
  parentChangePasswordSchema,
  parentScheduleQuerySchema,
  parentStudentIdParamsSchema,
} from './parent-portal.types.js';
import { ParentPortalError, buildParentPortalService } from './parent-portal.service.js';

const handleError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: 'Validation error',
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
  }

  if (error instanceof ParentPortalError) {
    return reply.code(error.statusCode).send({
      error: error.message,
      code: error.code,
      statusCode: error.statusCode,
    });
  }

  if (error instanceof ParentAccessError) {
    return reply.code(error.statusCode).send({
      error: error.message,
      code: error.code,
      statusCode: error.statusCode,
    });
  }

  return reply.code(500).send({
    error: error instanceof Error ? error.message : 'Internal server error',
    code: 'INTERNAL_ERROR',
    statusCode: 500,
  });
};

export default async function parentPortalController(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/parent/students', { preHandler: requireParent }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildParentPortalService(tenantDb);
        return service.listStudents({
          parentId: request.parentId!,
          allowedStudentIds: request.allowedStudentIds ?? [],
        });
      });

      return reply.send({ data: result });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get('/api/v1/parent/students/:studentId/schedule', { preHandler: requireParent }, async (request, reply) => {
    try {
      const { studentId } = parentStudentIdParamsSchema.parse(request.params ?? {});
      checkStudentAccess(request, studentId);
      const query = parentScheduleQuerySchema.parse(request.query ?? {});

      const claims = request.claims!;
      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildParentPortalService(tenantDb);
        return service.getStudentSchedule(
          { studentId, week: query.week },
          { parentId: request.parentId!, allowedStudentIds: request.allowedStudentIds ?? [] }
        );
      });

      return reply.send(result);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get('/api/v1/parent/students/:studentId/absences', { preHandler: requireParent }, async (request, reply) => {
    try {
      const { studentId } = parentStudentIdParamsSchema.parse(request.params ?? {});
      checkStudentAccess(request, studentId);
      const query = parentAbsencesQuerySchema.parse(request.query ?? {});

      const claims = request.claims!;
      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildParentPortalService(tenantDb);
        return service.listStudentAbsences(
          { studentId, month: query.month },
          { parentId: request.parentId!, allowedStudentIds: request.allowedStudentIds ?? [] }
        );
      });

      return reply.send({ data: result });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get('/api/v1/parent/students/:studentId/stats', { preHandler: requireParent }, async (request, reply) => {
    try {
      const { studentId } = parentStudentIdParamsSchema.parse(request.params ?? {});
      checkStudentAccess(request, studentId);

      const claims = request.claims!;
      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildParentPortalService(tenantDb);
        return service.getStudentStats(
          { studentId },
          { parentId: request.parentId!, allowedStudentIds: request.allowedStudentIds ?? [] }
        );
      });

      return reply.send(result);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get('/api/v1/parent/subscription/status', { preHandler: requireParent }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildParentPortalService(tenantDb);
        return service.getSubscriptionStatus({
          parentId: request.parentId!,
          allowedStudentIds: request.allowedStudentIds ?? [],
        });
      });

      return reply.send(result);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post('/api/v1/parent/auth/change-password', { preHandler: requireParent }, async (request, reply) => {
    try {
      const body = parentChangePasswordSchema.parse(request.body ?? {});
      const claims = request.claims!;
      await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildParentPortalService(tenantDb);
        await service.changePassword(
          {
            currentPassword: body.current_password,
            newPassword: body.new_password,
          },
          {
            parentId: request.parentId!,
            allowedStudentIds: request.allowedStudentIds ?? [],
          }
        );
      });

      return reply.send({ message: 'Mot de passe mis à jour' });
    } catch (error) {
      return handleError(reply, error);
    }
  });
}
