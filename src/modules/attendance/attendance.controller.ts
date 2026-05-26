import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';
import ExcelJS from 'exceljs';

import { withTenantSchema } from '../../shared/database/db.js';
import { requireDirector, requireTeacher, requireTeacherOrDirector } from '../../shared/middleware/auth.middleware.js';

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

  // On log le détail PG (code, detail, hint, position, query) pour diagnostiquer
  // les 500 sans devoir attacher un debugger — utile sur le 500 récurrent du
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

const geoReviewParamsSchema = z.object({
  attendanceId: z.string().uuid(),
});

const geoReviewBodySchema = z.object({
  decision: z.enum(['validated', 'rejected']),
});


export default async function attendanceController(app: FastifyInstance): Promise<void> {
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
        const service = buildAttendanceService(tenantDb);
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

  // conformité des profs pour un mois donné, avec filtres de rôle et ID, utilisé par le classement de TeacherCompliancePage (taux de conformité prof)
  app.get('/api/v1/attendance/teacher-compliance', { preHandler: requireTeacherOrDirector }, async (request, reply) => {
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

  app.get('/api/v1/attendance/history/export', { preHandler: requireDirector }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const query = historyExportQuerySchema.parse(request.query ?? {});
      const rows = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildAttendanceService(tenantDb);
        return service.exportTeacherHistory({
          teacherId: query.teacherId,
          from: query.date_from,
          to: query.date_to,
        });
      });

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Heures enseignant');
      sheet.columns = [
        { header: 'Date', key: 'date', width: 12 },
        { header: 'Enseignant', key: 'teacher', width: 24 },
        { header: 'Matière', key: 'subject', width: 18 },
        { header: 'Classe', key: 'class_name', width: 14 },
        { header: 'Salle', key: 'room_name', width: 14 },
        { header: 'Début', key: 'start_time', width: 10 },
        { header: 'Fin', key: 'end_time', width: 10 },
        { header: 'Statut', key: 'status', width: 12 },
        { header: 'Retard (min)', key: 'late_minutes', width: 12 },
        { header: 'Check-in', key: 'checked_in_at', width: 22 },
        { header: 'Appel fait', key: 'rollcall', width: 12 },
        { header: 'Présents', key: 'student_present', width: 10 },
        { header: 'Absents', key: 'student_absent', width: 10 },
        { header: 'Total élèves', key: 'student_total', width: 12 },
      ];
      sheet.getRow(1).font = { bold: true };

      for (const row of rows) {
        sheet.addRow({
          date: row.date,
          teacher: row.teacher_name,
          subject: row.subject,
          class_name: row.class_name,
          room_name: row.room_name,
          start_time: row.start_time,
          end_time: row.end_time,
          status: row.attendance_status ?? '-',
          late_minutes: row.late_minutes ?? 0,
          checked_in_at: row.checked_in_at ?? '',
          rollcall: row.student_rollcall_done ? 'Oui' : 'Non',
          student_present: row.student_present_count,
          student_absent: row.student_absent_count,
          student_total: row.student_total_count,
        });
      }

      const buffer = await workbook.xlsx.writeBuffer();
      const fileName = `edutrack-heures-${query.teacherId}-${query.date_from}_${query.date_to}.xlsx`;
      return reply
        .header(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        )
        .header('Content-Disposition', `attachment; filename="${fileName}"`)
        .send(Buffer.from(buffer));
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
