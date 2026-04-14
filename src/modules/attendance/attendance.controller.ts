import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import { withTenantSchema } from '../../shared/database/db.js';
import { requireTeacher } from '../../shared/middleware/auth.middleware.js';

import { AttendanceModuleError, buildAttendanceService } from './attendance.service.js';
import { checkInBodySchema, qrScanBodySchema } from './attendance.types.js';

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

  if (error instanceof AttendanceModuleError) {
    return reply.code(error.statusCode).send({
      error: error.message,
      code: error.code,
      statusCode: error.statusCode,
    });
  }

  request.log.error(
    { err: error instanceof Error ? error.message : 'unknown error' },
    '[attendance] unhandled error'
  );

  return reply.code(500).send({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
    statusCode: 500,
  });
};

export default async function attendanceController(app: FastifyInstance): Promise<void> {
  app.post('/api/v1/attendance/check-in', { preHandler: requireTeacher }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const body = checkInBodySchema.parse(request.body ?? {});

      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildAttendanceService(tenantDb);
        return service.checkIn(
          {
            scheduleId: body.schedule_id,
            date: body.date,
          },
          {
            schemaName: claims.schemaName,
            userId: claims.sub,
          }
        );
      });

      return reply.send({ data: result });
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.post('/api/v1/attendance/qr-scan', { preHandler: requireTeacher }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const body = qrScanBodySchema.parse(request.body ?? {});

      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildAttendanceService(tenantDb);
        return service.qrScan(
          {
            qrToken: body.qr_token,
            scanType: body.scan_type,
            scheduleId: body.schedule_id,
            date: body.date,
          },
          {
            schemaName: claims.schemaName,
            userId: claims.sub,
          }
        );
      });

      return reply.send({ data: result });
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.get('/api/v1/attendance/active', { preHandler: requireTeacher }, async (request, reply) => {
    try {
      const claims = request.claims!;

      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildAttendanceService(tenantDb);
        return service.getActive({
          schemaName: claims.schemaName,
          userId: claims.sub,
        });
      });

      return reply.send(result);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });
}
