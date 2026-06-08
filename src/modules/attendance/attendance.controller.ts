import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';
import type { Queue } from 'bullmq';

import { withTenantSchema } from '../../shared/database/db.js';
import {
  authenticateRequest,
  requireDirector,
  requireTeacher,
} from '../../shared/middleware/auth.middleware.js';
import type { PdfExportQueueHandle } from '../billing/billing.queue.js';
import { buildBillingService, BillingModuleError } from '../billing/billing.service.js';
import { SENSITIVE_ACTION_RATE_LIMIT } from '../../shared/utils/rate-limit.js';
import type { NotificationJobData } from '../notifications/notifications.queue.js';

import { AttendanceModuleError, buildAttendanceService } from './attendance.service.js';
import {
  bulkStudentsBodySchema,
  checkInBodySchema,
  checkOutBodySchema,
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

  if (error instanceof BillingModuleError) {
    return reply.code(error.statusCode).send({
      error: error.message,
      code: error.code,
      statusCode: error.statusCode,
    });
  }

  // On log le détail PG (code, detail, hint, position, query) pour diagnostiquer
  // les 500 sans devoir attacher un debugger - utile sur le 500 récurrent du
  // pointage élève (cast enum / search_path / FK manquante / search_path KO).
  const pgError = error as {
    code?: string;
    detail?: string;
    hint?: string;
    position?: string;
    table?: string;
    column?: string;
    constraint?: string;
    routine?: string;
    where?: string;
  };
  request.log.error(
    {
      err: error instanceof Error ? error.message : 'unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      pgCode: pgError?.code,
      pgDetail: pgError?.detail,
      pgHint: pgError?.hint,
      pgTable: pgError?.table,
      pgColumn: pgError?.column,
      pgConstraint: pgError?.constraint,
      pgRoutine: pgError?.routine,
      pgWhere: pgError?.where,
      url: request.url,
      method: request.method,
    },
    '[attendance] unhandled error'
  );

  return reply.code(500).send({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
    statusCode: 500,
  });
};

const requireTeacherOrAttendanceView = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> => {
  await authenticateRequest(request, reply);
  if (reply.sent) {
    return;
  }

  if (
    request.claims?.role === 'teacher' ||
    request.permissions?.has('teachers.ranking.view') ||
    request.permissions?.has('attendance.view')
  ) {
    return;
  }

  reply.code(403).send({
    error: 'Permission attendance.view required',
    code: 'FORBIDDEN',
    statusCode: 403,
  });
};

const requireTeacherAttendanceAnalysisView = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> => {
  await authenticateRequest(request, reply);
  if (reply.sent) {
    return;
  }

  if (
    request.permissions?.has('teachers.attendance.view') ||
    request.permissions?.has('attendance.view')
  ) {
    return;
  }

  reply.code(403).send({
    error: 'Permission teachers.attendance.view required',
    code: 'FORBIDDEN',
    statusCode: 403,
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

const historyExportQuerySchema = z.object({
  teacherId: z.string().uuid(),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  format: z.enum(['xlsx', 'csv']).default('xlsx').optional(),
}).refine((value) => value.date_to >= value.date_from, {
  message: 'date_to must be >= date_from',
  path: ['date_to'],
});

const weekScheduleQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must use YYYY-MM-DD format')
    .default(() => new Date().toISOString().slice(0, 10)),
})

const monthQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .default(() => new Date().toISOString().slice(0, 7)),
});

const rollCallQuerySchema = z.object({
  schedule_id: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must use YYYY-MM-DD format'),
});

const teacherMonthlyParamsSchema = z.object({
  teacherId: z.string().uuid(),
});

const geoReviewParamsSchema = z.object({
  attendanceId: z.string().uuid(),
});

const geoReviewBodySchema = z.object({
  decision: z.enum(['validated', 'rejected']),
});


export default async function attendanceController(
  app: FastifyInstance,
  options: { pdfQueue?: PdfExportQueueHandle; notifQueue?: Queue<NotificationJobData> } = {}
): Promise<void> {
  app.post('/api/v1/attendance/check-in', {
    preHandler: requireTeacher,
    schema: {
      tags: ['attendance'],
      summary: 'Teacher check-in for a scheduled course',
      description: 'Records the teacher arrival time for the given schedule_id. Returns the computed status (present / late / absent) and the late minutes.',
    },
  }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const body = checkInBodySchema.parse(request.body ?? {});

      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildAttendanceService(tenantDb);
        return service.checkIn(
          {
            scheduleId: body.schedule_id,
            date: body.date,
            latitude: body.latitude,
            longitude: body.longitude,
            accuracy: body.accuracy,
            clientTimestamp: body.client_timestamp,
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

  app.post('/api/v1/attendance/check-out', {
    preHandler: requireTeacher,
    schema: {
      tags: ['attendance'],
      summary: 'Teacher check-out (end of course)',
    },
  }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const body = checkOutBodySchema.parse(request.body ?? {});

      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildAttendanceService(tenantDb);
        return service.checkOut(
          {
            scheduleId: body.schedule_id,
            date: body.date,
            latitude: body.latitude,
            longitude: body.longitude,
            accuracy: body.accuracy,
            clientTimestamp: body.client_timestamp,
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

  app.post('/api/v1/attendance/qr-scan', {
    preHandler: requireTeacher,
    schema: {
      tags: ['attendance'],
      summary: 'Validate a room QR scan (start or end)',
    },
  }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const body = qrScanBodySchema.parse(request.body ?? {});

      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildAttendanceService(tenantDb, options.notifQueue);
        return service.qrScan(
          {
            qrToken: body.qr_token,
            scanType: body.scan_type,
            scheduleId: body.schedule_id,
            date: body.date,
            clientTimestamp: body.client_timestamp,
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

  app.post('/api/v1/attendance/qr-skip', {
    preHandler: requireTeacher,
    schema: {
      tags: ['attendance'],
      summary: 'Skip the QR step (camera unavailable)',
    },
  }, async (request, reply) => {
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
            clientTimestamp: body.client_timestamp,
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

  app.get('/api/v1/attendance/active', {
    preHandler: requireTeacher,
    schema: {
      tags: ['attendance'],
      summary: 'List the currently active courses for the teacher',
    },
  }, async (request, reply) => {
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

  // ── NOUVEAU - statuts de pointage du prof pour une date ───────────────────
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

  // ── NOUVEAU - appel élèves par le prof ────────────────────────────────────
  // POST /api/v1/attendance/students/bulk
  // body: { schedule_id, date, absent_student_ids[] }
  app.post('/api/v1/attendance/students/bulk', {
    // Déclenche des SMS parents en masse (coût réel) → rate-limit dédié.
    config: { rateLimit: SENSITIVE_ACTION_RATE_LIMIT },
    preHandler: requireTeacher,
  }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const body = bulkStudentsBodySchema.parse(request.body ?? {});

      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildAttendanceService(tenantDb, options.notifQueue);
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

  // ── Statuts de présence des élèves d'un cours (pré-remplir l'appel rouvert) ──
  // GET /api/v1/attendance/students/roll-call?schedule_id=…&date=YYYY-MM-DD
  app.get('/api/v1/attendance/students/roll-call', { preHandler: requireTeacher }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const query = rollCallQuerySchema.parse(request.query ?? {});

      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildAttendanceService(tenantDb);
        return service.getStudentRollCall(
          { scheduleId: query.schedule_id, date: query.date },
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

  // conformité des profs pour un mois donné, avec filtres de rôle et ID, utilisé par le classement de TeacherCompliancePage (taux de conformité prof)
  app.get('/api/v1/attendance/teacher-compliance', { preHandler: requireTeacherOrAttendanceView }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const query = monthQuerySchema.parse(request.query ?? {});
      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildAttendanceService(tenantDb); // on réutilise la même logique que pour le classement global de TeacherCompliancePage, mais avec des filtres appliqués côté service pour retourner uniquement les données pertinentes pour le rôle et l'ID du user connecté (ex: un prof ne voit que sa propre conformité, un directeur voit tous les profs)
        return service.getTeacherCompliance({
          month: query.month,
          role: claims.role,
          userId: claims.sub,
        });
      });
      return reply.send(result);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.get('/api/v1/attendance/teachers/:teacherId/monthly', { preHandler: requireTeacherAttendanceAnalysisView }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const params = teacherMonthlyParamsSchema.parse(request.params ?? {});
      const query = monthQuerySchema.parse(request.query ?? {});

      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        return buildBillingService(tenantDb).getTeacherMonthlyAttendance(params.teacherId, query.month);
      });

      return reply.send(result);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.get('/api/v1/attendance/suspicious', { preHandler: requireDirector }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const query = monthQuerySchema.parse(request.query ?? {});
      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildAttendanceService(tenantDb);
        return service.getSuspiciousAttendances({ month: query.month });
      });
      return reply.send(result);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.patch('/api/v1/attendance/:attendanceId/geo-review', { preHandler: requireDirector }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const params = geoReviewParamsSchema.parse(request.params ?? {});
      const body = geoReviewBodySchema.parse(request.body ?? {});
      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildAttendanceService(tenantDb);
        return service.reviewGeoAttendance({
          attendanceId: params.attendanceId,
          decision: body.decision,
        });
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

  // Bilan des heures d'un professeur (PDF asynchrone via la queue d'export).
  // Remplace l'ancien export Excel synchrone : on enfile un job et le frontend
  // récupère le PDF brandé via /api/v1/jobs/:jobId. Le nom du prof est résolu
  // côté worker à partir des lignes (placeholder ici).
  app.get('/api/v1/attendance/history/export', { preHandler: requireDirector }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const query = historyExportQuerySchema.parse(request.query ?? {});

      if (!options.pdfQueue) {
        return reply.code(503).send({
          error: 'Export queue unavailable',
          code: 'EXPORT_QUEUE_UNAVAILABLE',
          statusCode: 503,
        });
      }

      const job = await options.pdfQueue.add(
        'attendance-hours-export',
        {
          type: 'attendance-hours-export',
          schemaName: claims.schemaName,
          teacherId: query.teacherId,
          teacherName: 'professeur',
          from: query.date_from,
          to: query.date_to,
        },
        { removeOnComplete: 100, removeOnFail: 100 }
      );

      return reply.send({ jobId: job.id });
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
          //  jour de cette semaine convient - le backend retourne tous les day_of_week)
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
