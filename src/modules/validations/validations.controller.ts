import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import { ZodError } from 'zod';

import { db as publicDb, withTenantSchema } from '../../shared/database/db.js';
import {
  requireDirector,
  requirePermission,
  requireTeacher,
} from '../../shared/middleware/auth.middleware.js';
import { ValidationModuleError, buildValidationsService } from './validations.service.js';
import {
  approveValidationBodySchema,
  attendanceIdParamsSchema,
  bulkWarnEndScansBodySchema,
  cancelEndScanSanctionBodySchema,
  endScanActionBodySchema,
  invalidateSessionBodySchema,
  missingEndScansQuerySchema,
  notificationIdParamsSchema,
  realHoursConfigBodySchema,
  rejectValidationBodySchema,
  validationHistoryQuerySchema,
} from './validations.types.js';

const handleError = (
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown
): FastifyReply => {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: 'Validation error',
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
  }

  if (error instanceof ValidationModuleError) {
    return reply.code(error.statusCode).send({
      error: error.message,
      code: error.code,
      statusCode: error.statusCode,
    });
  }

  request.log.error(
    { err: error instanceof Error ? error.message : 'unknown error' },
    '[validations] unhandled error'
  );

  return reply.code(500).send({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
    statusCode: 500,
  });
};

export default async function validationsController(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/validations/pending', { preHandler: requirePermission('validations.view') }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildValidationsService(tenantDb);
        return service.listPending();
      });
      return reply.send(result);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.get('/api/v1/validations/pending/count', { preHandler: requirePermission('validations.view') }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildValidationsService(tenantDb);
        return service.countPending();
      });
      return reply.send(result);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.patch('/api/v1/validations/:attendanceId/approve', { preHandler: requirePermission('validations.approve') }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const params = attendanceIdParamsSchema.parse(request.params ?? {});
      const body = approveValidationBodySchema.parse(request.body ?? {});
      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildValidationsService(tenantDb);
        return service.approve(
          {
            attendanceId: params.attendanceId,
            validatedHours: body.validated_hours,
          },
          {
            schemaName: claims.schemaName,
            tenantId: claims.tenantId,
            userId: claims.sub,
            role: claims.role,
          }
        );
      });
      return reply.send(result);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.patch('/api/v1/validations/:attendanceId/reject', { preHandler: requirePermission('validations.reject') }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const params = attendanceIdParamsSchema.parse(request.params ?? {});
      const body = rejectValidationBodySchema.parse(request.body ?? {});
      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildValidationsService(tenantDb);
        return service.reject(
          {
            attendanceId: params.attendanceId,
            reason: body.reason,
          },
          {
            schemaName: claims.schemaName,
            tenantId: claims.tenantId,
            userId: claims.sub,
            role: claims.role,
          }
        );
      });
      return reply.send(result);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  // ── Validation history ───────────────────────────────────────────────────

  app.get('/api/v1/validations/history', { preHandler: requirePermission('validations.view') }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const query = validationHistoryQuerySchema.parse(request.query ?? {});
      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildValidationsService(tenantDb);
        return service.listValidationHistory({
          kind: query.kind,
          month: query.month,
          status: query.status,
          approvalType: query.approvalType,
          search: query.search,
          page: query.page,
          limit: query.limit,
        });
      });
      return reply.send(result);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  // ── Missing end-scan routes ──────────────────────────────────────────────

  app.get('/api/v1/validations/missing-end-scans', { preHandler: requirePermission('validations.view') }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const query = missingEndScansQuerySchema.parse(request.query ?? {});
      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildValidationsService(tenantDb);
        return service.listMissingEndScans(query.month);
      });
      return reply.send(result);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.post('/api/v1/validations/bulk-warn-end-scans', { preHandler: requirePermission('validations.approve') }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const body = bulkWarnEndScansBodySchema.parse(request.body ?? {});
      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildValidationsService(tenantDb);
        return service.bulkWarnMissingEndScans(body.teacher_ids, body.month, {
          schemaName: claims.schemaName,
          tenantId: claims.tenantId,
          userId: claims.sub,
          role: claims.role,
        });
      });
      return reply.send(result);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.patch('/api/v1/validations/invalidate-session', { preHandler: requirePermission('validations.reject') }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const body = invalidateSessionBodySchema.parse(request.body ?? {});
      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildValidationsService(tenantDb);
        return service.invalidateSession(
          { attendanceId: body.attendance_id, reason: body.reason },
          {
            schemaName: claims.schemaName,
            tenantId: claims.tenantId,
            userId: claims.sub,
            role: claims.role,
          }
        );
      });
      return reply.send(result);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  // ── End-scan actions (warn / sanction / cancel) ──────────────────────────────

  app.post('/api/v1/validations/end-scan-action', { preHandler: requirePermission('validations.approve') }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const body = endScanActionBodySchema.parse(request.body ?? {});
      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildValidationsService(tenantDb);
        return service.applyEndScanAction(
          { attendanceId: body.attendance_id, action: body.action, reason: body.reason },
          { schemaName: claims.schemaName, tenantId: claims.tenantId, userId: claims.sub, role: claims.role }
        );
      });
      return reply.send(result);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.post('/api/v1/validations/cancel-end-scan-sanction', { preHandler: requirePermission('validations.reject') }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const body = cancelEndScanSanctionBodySchema.parse(request.body ?? {});
      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildValidationsService(tenantDb);
        return service.cancelEndScanSanction(
          { attendanceId: body.attendance_id, reason: body.reason },
          { schemaName: claims.schemaName, tenantId: claims.tenantId, userId: claims.sub, role: claims.role }
        );
      });
      return reply.send(result);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  // ── Teacher in-app notifications ────────────────────────────────────────────

  app.get('/api/v1/teacher/notifications', { preHandler: requireTeacher }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildValidationsService(tenantDb);
        return service.listTeacherNotifications(claims.sub);
      });
      return reply.send(result);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.patch('/api/v1/teacher/notifications/:notificationId/read', { preHandler: requireTeacher }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const params = notificationIdParamsSchema.parse(request.params ?? {});
      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildValidationsService(tenantDb);
        return service.markTeacherNotificationRead(params.notificationId, claims.sub);
      });
      return reply.send(result);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.patch('/api/v1/teacher/notifications/read-all', { preHandler: requireTeacher }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildValidationsService(tenantDb);
        return service.markAllTeacherNotificationsRead(claims.sub);
      });
      return reply.send(result);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.patch('/api/v1/school/settings/real-hours-config', { preHandler: requireDirector }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const body = realHoursConfigBodySchema.parse(request.body ?? {});
      const result = await publicDb.execute<{ use_real_hours: boolean }>(sql`
        SELECT COALESCE(f.use_real_hours, false) AS use_real_hours
        FROM public.tenants t
        LEFT JOIN public.school_sms_features f ON f.tenant_id = t.id
        WHERE t.schema_name = ${claims.schemaName}
        LIMIT 1
      `);
      const useRealHours = result.rows[0]?.use_real_hours ?? false;
      if (!useRealHours) {
        return reply.code(400).send({
          error: 'Real hours are disabled for this school',
          code: 'REAL_HOURS_DISABLED',
          statusCode: 400,
        });
      }

      await publicDb.execute(sql`
        UPDATE public.school_sms_features f
        SET checkout_tolerance_minutes = ${body.checkoutToleranceMinutes}, updated_at = NOW()
        FROM public.tenants t
        WHERE f.tenant_id = t.id
          AND t.schema_name = ${claims.schemaName}
      `);

      return reply.send({ success: true, checkoutToleranceMinutes: body.checkoutToleranceMinutes });
    } catch (error) {
      return handleError(request, reply, error);
    }
  });
}
