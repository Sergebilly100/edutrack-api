import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';

import { withTenantSchema } from '../../shared/database/db.js';
import { requireDirector, requireTeacher } from '../../shared/middleware/auth.middleware.js';

import { AttendanceModuleError, buildAttendanceService } from './attendance.service.js';
import {
  bulkStudentsBodySchema,
  checkInBodySchema,
  qrSkipBodySchema,
  qrScanBodySchema,
  teacherAttendanceDateQuerySchema,
} from './attendance.types.js';

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

const attendanceHistoryQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(30).default(7),
});

const historyDetailQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).refine((value) => value.to >= value.from, {
  message: 'to must be >= from',
  path: ['to'],
});

const weekScheduleQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must use YYYY-MM-DD format')
    .default(() => new Date().toISOString().slice(0, 10)),
})

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

  app.post('/api/v1/attendance/qr-skip', { preHandler: requireTeacher }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const body = qrSkipBodySchema.parse(request.body ?? {});

      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildAttendanceService(tenantDb);
        return service.skipQrStep(
          {
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

  // ── NOUVEAU — statuts de pointage du prof pour une date ───────────────────
  // Utilisé par TeacherSchedulePage pour afficher les badges de présence
  // GET /api/v1/attendance/teacher/me?date=YYYY-MM-DD
  app.get('/api/v1/attendance/teacher/me', { preHandler: requireTeacher }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const query = teacherAttendanceDateQuerySchema.parse(request.query ?? {});

      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildAttendanceService(tenantDb);
        return service.getTeacherAttendanceByDate(
          { date: query.date },
          { schemaName: claims.schemaName, userId: claims.sub }
        );
      });

      return reply.send(result);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  // ── NOUVEAU — appel élèves par le prof ────────────────────────────────────
  // POST /api/v1/attendance/students/bulk
  // body: { schedule_id, date, absent_student_ids[] }
  app.post('/api/v1/attendance/students/bulk', { preHandler: requireTeacher }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const body = bulkStudentsBodySchema.parse(request.body ?? {});

      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildAttendanceService(tenantDb);
        return service.submitStudentAttendance(
          {
            scheduleId: body.schedule_id,
            date: body.date,
            absentStudentIds: body.absent_student_ids,
          },
          { schemaName: claims.schemaName, userId: claims.sub }
        );
      });

      return reply.send({ data: result });
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.get('/api/v1/attendance/today', { preHandler: requireDirector }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildAttendanceService(tenantDb);
        return service.getTodayForDirector();
      });
      return reply.send(result);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.get('/api/v1/attendance/history', { preHandler: requireDirector }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const query = attendanceHistoryQuerySchema.parse(request.query ?? {});
      const rows = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildAttendanceService(tenantDb);
        return service.getHistoryForDirector(query.days);
      });
      return reply.send(rows);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.get('/api/v1/attendance/history/detail', { preHandler: requireDirector }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const query = historyDetailQuerySchema.parse(request.query ?? {});
      const rows = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildAttendanceService(tenantDb);
        return service.getHistoryDetailForDirector({
          from: query.from,
          to: query.to,
        });
      });
      return reply.send(rows);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.get(
    '/api/v1/schedule/teacher/me/week',
    { preHandler: requireTeacher },
    async (request, reply) => {
      try {
          const claims = request.claims!
          const userId = claims.sub; 

          // date = n'importe quel jour de la semaine affichée côté frontend
          // (on utilise typiquement le lundi de la semaine, mais n'importe quel
          //  jour de cette semaine convient — le backend retourne tous les day_of_week)
          const query = weekScheduleQuerySchema.parse(request.query ?? {})

          const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
            // Réutilise la même logique que /me mais sans filtre day_of_week
            // La query ci-dessous retourne tous les créneaux de la période active
          const service = buildAttendanceService(tenantDb);
          // pour ce prof (tous les jours lundi→samedi)
          const rows = await service.getWeekScheduleForTeacher(userId, query.date);
          return rows;
        })

        return reply.send(result)
      } catch (error) {
        return handleError(request, reply, error)
      }
    }
  )
}
