import type { FastifyInstance, FastifyReply } from 'fastify';
import { ZodError } from 'zod';

import { withTenantSchema } from '../../shared/database/db.js';
import {
  requireDirectorOrSecretary,
  requireTeacherOrDirectorOrSecretary,
} from '../../shared/middleware/auth.middleware.js';

import { StudentsModuleError, buildStudentsService } from './students.service.js';
import {
  attendanceHistoryQuerySchema,
  bulkAttendanceBodySchema,
  createStudentBodySchema,
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

  return reply.code(500).send({
    error: 'Unexpected error',
    code: 'INTERNAL_SERVER_ERROR',
    statusCode: 500,
  });
};

export default async function studentsController(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/students', { preHandler: requireDirectorOrSecretary }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const query = studentsListQuerySchema.parse(request.query ?? {});

      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildStudentsService(tenantDb);
        return service.listStudents(query);
      });

      return reply.send(result);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post('/api/v1/students', { preHandler: requireDirectorOrSecretary }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const body = createStudentBodySchema.parse(request.body ?? {});

      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildStudentsService(tenantDb);
        return service.createStudent(body);
      });

      return reply.code(201).send({ data: result });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.put('/api/v1/students/:id', { preHandler: requireDirectorOrSecretary }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const params = updateStudentParamsSchema.parse(request.params ?? {});
      const body = updateStudentBodySchema.parse(request.body ?? {});

      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildStudentsService(tenantDb);
        return service.updateStudent(params.id, body);
      });

      return reply.send({ data: result });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.delete('/api/v1/students/:id', { preHandler: requireDirectorOrSecretary }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const params = updateStudentParamsSchema.parse(request.params ?? {});

      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildStudentsService(tenantDb);
        return service.softDeleteStudent(params.id);
      });

      return reply.send({ data: result });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post('/api/v1/attendance/students/bulk', { preHandler: requireTeacherOrDirectorOrSecretary }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const body = bulkAttendanceBodySchema.parse(request.body ?? {});

      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildStudentsService(tenantDb);
        return service.bulkMarkAbsences(body, {
          userId: claims.sub,
          schemaName: claims.schemaName,
        });
      });

      return reply.send({ data: result });
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get('/api/v1/attendance/students', { preHandler: requireDirectorOrSecretary }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const query = attendanceHistoryQuerySchema.parse(request.query ?? {});

      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildStudentsService(tenantDb);
        return service.listAttendanceHistory(query);
      });

      return reply.send(result);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get('/api/v1/attendance/students/today', { preHandler: requireDirectorOrSecretary }, async (request, reply) => {
    try {
      const claims = request.claims!;

      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildStudentsService(tenantDb);
        return service.listTodayAbsences();
      });

      return reply.send({ data: result });
    } catch (error) {
      return handleError(reply, error);
    }
  });
}
