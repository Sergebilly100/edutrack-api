import type { FastifyInstance, FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { sql } from 'drizzle-orm';

import { db, withTenantSchema } from '../../shared/database/db.js';
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
import { AUTH_BRUTEFORCE_RATE_LIMIT } from '../../shared/utils/rate-limit.js';
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

  // Erreur inconnue : ne JAMAIS exposer error.message côté parent (détail
  // interne / SQL). On logge le détail serveur, on renvoie un message générique.
  reply.request.log.error(
    { err: error instanceof Error ? error.message : 'unknown error' },
    '[parent-portal] unhandled error'
  );
  return reply.code(500).send({
    error: 'Internal server error',
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

  app.get('/api/v1/parent/students/:studentId/overview', { preHandler: requireParent }, async (request, reply) => {
    try {
      const { studentId } = parentStudentIdParamsSchema.parse(request.params ?? {});
      checkStudentAccess(request, studentId);

      const claims = request.claims!;
      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildParentPortalService(tenantDb);
        return service.getStudentOverview(
          { studentId },
          { parentId: request.parentId!, allowedStudentIds: request.allowedStudentIds ?? [] }
        );
      });
      return reply.send(result);
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

  app.get('/api/v1/parent/school-config', { preHandler: requireParent }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const result = await db.execute<{ active_school_year: string | null }>(sql`
        SELECT active_school_year
        FROM public.tenants
        WHERE schema_name = ${claims.schemaName}
        LIMIT 1
      `);
      const row = result.rows[0];
      return reply.send({ activeSchoolYear: row?.active_school_year ?? null });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post('/api/v1/parent/auth/change-password', {
    preHandler: requireParent,
    config: { rateLimit: AUTH_BRUTEFORCE_RATE_LIMIT },
  }, async (request, reply) => {
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
