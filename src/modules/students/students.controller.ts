import type { FastifyInstance, FastifyReply } from 'fastify';
import { ZodError } from 'zod';

import { z } from 'zod';

import { withTenantSchema } from '../../shared/database/db.js';
import {
  requireTeacherOrDirectorOrSecretary,
  requirePermission,
} from '../../shared/middleware/auth.middleware.js';
import type { PdfExportQueueHandle } from '../billing/billing.queue.js';

import { StudentsModuleError, buildStudentsService } from './students.service.js';
import {
  absenceStatsQuerySchema,
  attendanceHistoryQuerySchema,
  bulkAttendanceBodySchema,
  createStudentBodySchema,
  excuseAbsenceBodySchema,
  excuseAbsenceParamsSchema,
  studentAbsencesParamsSchema,
  studentAbsencesQuerySchema,
  studentsListQuerySchema,
  updateStudentBodySchema,
  updateStudentParamsSchema,
} from './students.types.js';

const handleError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: 'Validation error',
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
  }

  if (error instanceof StudentsModuleError) {
    return reply.code(error.statusCode).send({
      error: error.message,
      code: error.code,
      statusCode: error.statusCode,
    });
  }

  reply.log.error({ err: error }, '[students] unexpected error');
  return reply.code(500).send({
    error: 'Unexpected error',
    code: 'INTERNAL_SERVER_ERROR',
    statusCode: 500,
  });
};

const absenceExportQuerySchema = absenceStatsQuerySchema.extend({
  student_label: z.string().trim().min(1).max(40).default('Élève'),
});

export default async function studentsController(
  app: FastifyInstance,
  options: { pdfQueue?: PdfExportQueueHandle } = {}
): Promise<void> {
  // ─── Students CRUD ──────────────────────────────────────────────────────────

  app.get(
    '/api/v1/students',
    { preHandler: requireTeacherOrDirectorOrSecretary },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const query = studentsListQuerySchema.parse(request.query ?? {});

        // FIX AXE2: permission check extracted from controller logic — teachers
        // always need a class_id to scope their access; others need students.view
        if (claims.role !== 'teacher' && !request.permissions?.has('students.view')) {
          return reply.code(403).send({
            error: 'Permission students.view required',
            code: 'FORBIDDEN',
            statusCode: 403,
          });
        }

        if (claims.role === 'teacher' && !query.class_id) {
          return reply.code(403).send({
            error: 'Teacher must provide class_id',
            code: 'FORBIDDEN',
            statusCode: 403,
          });
        }

        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          const service = buildStudentsService(tenantDb);

          if (claims.role === 'teacher') {
            const date = new Date().toISOString().slice(0, 10);
            const canAccess = await service.teacherCanAccessClass({
              teacherUserId: claims.sub,
              classId: query.class_id as string,
              date,
            });
            if (!canAccess) throw new StudentsModuleError('Forbidden', 403, 'FORBIDDEN');
          }

          return service.listStudents(query);
        });

        return reply.send(result);
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.post(
    '/api/v1/students',
    { preHandler: requirePermission('students.create') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const body = createStudentBodySchema.parse(request.body ?? {});

        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          return buildStudentsService(tenantDb).createStudent(body);
        });

        return reply.code(201).send({ data: result });
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  // Static route must be registered before /:id
  app.get(
    '/api/v1/students/absence-stats',
    { preHandler: requirePermission('attendance.view') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const query = absenceStatsQuerySchema.parse(request.query ?? {});

        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          return buildStudentsService(tenantDb).getAbsenceStats(query);
        });

        return reply.send(result);
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  // Bilan des absences élèves (PDF asynchrone via la queue d'export).
  // Remplace l'ancien export CSV navigateur.
  app.get(
    '/api/v1/students/absence-stats/export',
    { preHandler: requirePermission('attendance.view') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const query = absenceExportQuerySchema.parse(request.query ?? {});

        if (!options.pdfQueue) {
          return reply.code(503).send({
            error: 'Export queue unavailable',
            code: 'EXPORT_QUEUE_UNAVAILABLE',
            statusCode: 503,
          });
        }

        const job = await options.pdfQueue.add(
          'student-absences-export',
          {
            type: 'student-absences-export',
            schemaName: claims.schemaName,
            studentLabel: query.student_label,
            classId: query.class_id,
            subject: query.subject,
            from: query.from,
            to: query.to,
            minAbsences: query.min_absences,
            smsStatus: query.sms_status,
          },
          { removeOnComplete: 100, removeOnFail: 100 }
        );

        return reply.send({ jobId: job.id });
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.get(
    '/api/v1/students/:studentId/absences',
    { preHandler: requirePermission('attendance.view') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const params = studentAbsencesParamsSchema.parse(request.params ?? {});
        const query = studentAbsencesQuerySchema.parse(request.query ?? {});

        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          return buildStudentsService(tenantDb).getStudentAbsences(params.studentId, query);
        });

        return reply.send(result);
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.get(
    '/api/v1/students/:id',
    { preHandler: requirePermission('students.view') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const params = updateStudentParamsSchema.parse(request.params ?? {});

        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          return buildStudentsService(tenantDb).getStudentDetail(params.id);
        });

        return reply.send({ data: result });
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.put(
    '/api/v1/students/:id',
    { preHandler: requirePermission('students.edit') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const params = updateStudentParamsSchema.parse(request.params ?? {});
        const body = updateStudentBodySchema.parse(request.body ?? {});

        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          return buildStudentsService(tenantDb).updateStudent(params.id, body);
        });

        return reply.send({ data: result });
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  app.delete(
    '/api/v1/students/:id',
    { preHandler: requirePermission('students.edit') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const params = updateStudentParamsSchema.parse(request.params ?? {});

        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          return buildStudentsService(tenantDb).softDeleteStudent(params.id);
        });

        return reply.send({ data: result });
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  // ─── Absence excuse ─────────────────────────────────────────────────────────

  app.patch(
    '/api/v1/students/absences/:attendanceId/excuse',
    { preHandler: requirePermission('students.excuse') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const params = excuseAbsenceParamsSchema.parse(request.params ?? {});
        const body = excuseAbsenceBodySchema.parse(request.body ?? {});

        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          return buildStudentsService(tenantDb).excuseAbsence(
            params.attendanceId,
            body,
            claims.sub
          );
        });

        return reply.send({ data: result });
      } catch (error) {
        return handleError(reply, error);
      }
    }
  );

  // ─── Attendance routes (guard against duplicate registration) ───────────────

  if (!app.hasRoute({ method: 'POST', url: '/api/v1/attendance/students/bulk' })) {
    app.post(
      '/api/v1/attendance/students/bulk',
      { preHandler: requirePermission('attendance.mark_students') },
      async (request, reply) => {
        try {
          const claims = request.claims!;
          const body = bulkAttendanceBodySchema.parse(request.body ?? {});

          const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
            return buildStudentsService(tenantDb).bulkMarkAbsences(body, {
              userId: claims.sub,
              schemaName: claims.schemaName,
            });
          });

          return reply.send({ data: result });
        } catch (error) {
          return handleError(reply, error);
        }
      }
    );
  }

  if (!app.hasRoute({ method: 'GET', url: '/api/v1/attendance/students' })) {
    app.get(
      '/api/v1/attendance/students',
      { preHandler: requirePermission('attendance.view') },
      async (request, reply) => {
        try {
          const claims = request.claims!;
          const query = attendanceHistoryQuerySchema.parse(request.query ?? {});

          const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
            return buildStudentsService(tenantDb).listAttendanceHistory(query);
          });

          return reply.send(result);
        } catch (error) {
          return handleError(reply, error);
        }
      }
    );
  }

  // FIX B6: guard this route exactly like the two above
  if (!app.hasRoute({ method: 'GET', url: '/api/v1/attendance/students/today' })) {
    app.get(
      '/api/v1/attendance/students/today',
      { preHandler: requirePermission('attendance.view') },
      async (request, reply) => {
        try {
          const claims = request.claims!;

          const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
            return buildStudentsService(tenantDb).listTodayAbsences();
          });

          return reply.send({ data: result });
        } catch (error) {
          return handleError(reply, error);
        }
      }
    );
  }
}
