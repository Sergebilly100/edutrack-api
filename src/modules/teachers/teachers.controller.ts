import type { FastifyInstance, FastifyReply } from 'fastify';
import { ZodError } from 'zod';

import { withTenantSchema } from '../../shared/database/db.js';
import { requirePermission } from '../../shared/middleware/auth.middleware.js';

import { buildTeachersService, TeachersModuleError } from './teachers.service.js';
import {
  createTeacherBodySchema,
  teacherAttendanceStatsQuerySchema,
  teacherParamsSchema,
  teacherStatsQuerySchema,
  teachersListQuerySchema,
  updateTeacherBodySchema,
  type CreateTeacherInput,
} from './teachers.types.js';

const handleError = (request: { log: { error: (obj: Record<string, unknown>, msg?: string) => void } }, reply: FastifyReply, error: unknown): FastifyReply => {
  if (error instanceof ZodError) {
    return reply.code(400).send({
      error: 'Validation error',
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
  }

  if (error instanceof TeachersModuleError) {
    if (error.statusCode >= 500) {
      request.log.error({ err: error, code: error.code }, error.message);
    }
    return reply.code(error.statusCode).send({
      error: error.message,
      code: error.code,
      statusCode: error.statusCode,
    });
  }

  request.log.error({ err: error }, 'Unexpected error in teachers module');
  return reply.code(500).send({
    error: 'Unexpected error',
    code: 'INTERNAL_SERVER_ERROR',
    statusCode: 500,
  });
};

const toCreateInput = (payload: unknown): CreateTeacherInput => {
  const parsed = createTeacherBodySchema.parse(payload);

  if ('name' in parsed) {
    const chunks = parsed.name.trim().split(/\s+/);
    const firstName = chunks[0] ?? 'Prof';
    const lastName = chunks.slice(1).join(' ') || 'Sans nom';

    return {
      name: parsed.name.trim(),
      first_name: firstName,
      last_name: lastName,
      matricule: null,
      phone: null,
      email: null,
      type: parsed.type,
      subjects: parsed.subjects,
      hourly_rate: null,
      monthly_salary: null,
    };
  }

  return {
    ...parsed,
    name: `${parsed.first_name} ${parsed.last_name}`.trim(),
  };
};

export default async function teachersController(app: FastifyInstance): Promise<void> {
  // ─── GET /api/v1/teachers ─────────────────────────────────────────────────
  app.get('/api/v1/teachers', { preHandler: requirePermission('teachers.view') }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const query = teachersListQuerySchema.parse(request.query ?? {});
      const rawQuery = (request.query ?? {}) as Record<string, unknown>;
      const returnArrayOnly = rawQuery.page === undefined && rawQuery.limit === undefined;

      const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildTeachersService(tenantDb);
        return service.listTeachers(query);
      });

      if (returnArrayOnly && !Array.isArray(result)) {
        return reply.send(result.data);
      }

      return reply.send(result);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  // ─── GET /api/v1/teachers/attendance-stats ───────────────────────────────
  app.get('/api/v1/teachers/attendance-stats', { preHandler: requirePermission('teachers.view') }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const query = teacherAttendanceStatsQuerySchema.parse(request.query ?? {});

      const stats = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildTeachersService(tenantDb);
        return service.getAttendanceStats(query);
      });

      return reply.send(stats);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  // ─── GET /api/v1/teachers/:id ─────────────────────────────────────────────
  // Route dédiée — retourne le prof même s'il est bloqué ou inactif.
  // Évite le pagination-scan côté frontend et le TEACHER_NOT_FOUND spurieux
  // qui déclenchait le toast d'erreur après un blocage réussi.
  app.get('/api/v1/teachers/:id', { preHandler: requirePermission('teachers.view') }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const params = teacherParamsSchema.parse(request.params ?? {});

      const teacher = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildTeachersService(tenantDb);
        return service.getTeacherById(params.id);
      });

      return reply.send(teacher);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  // ─── POST /api/v1/teachers ────────────────────────────────────────────────
  app.post('/api/v1/teachers', { preHandler: requirePermission('teachers.create') }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const input = toCreateInput(request.body ?? {});

      const created = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildTeachersService(tenantDb);
        return service.createTeacher(input, { schemaName: claims.schemaName });
      });

      return reply.code(201).send(created);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  // ─── PUT /api/v1/teachers/:id ─────────────────────────────────────────────
  app.put('/api/v1/teachers/:id', { preHandler: requirePermission('teachers.edit') }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const params = teacherParamsSchema.parse(request.params ?? {});
      const payload = updateTeacherBodySchema.parse(request.body ?? {});
   
      const updated = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildTeachersService(tenantDb);
        return service.updateTeacher(params.id, payload, claims.sub);
      });

      return reply.send(updated);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  // ─── DELETE /api/v1/teachers/:id ──────────────────────────────────────────
  app.delete('/api/v1/teachers/:id', { preHandler: requirePermission('teachers.edit') }, async (request, reply) => {
    try {
      const claims = request.claims!;
      const params = teacherParamsSchema.parse(request.params ?? {});

      const deleted = await withTenantSchema(claims.schemaName, async (tenantDb) => {
        const service = buildTeachersService(tenantDb);
        return service.softDeleteTeacher(params.id);
      });

      return reply.send(deleted);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  // ─── GET /api/v1/teachers/:id/stats ──────────────────────────────────────
  app.get(
    '/api/v1/teachers/:id/stats',
    { preHandler: requirePermission('teachers.view') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const params = teacherParamsSchema.parse(request.params ?? {});
        const query = teacherStatsQuerySchema.parse(request.query ?? {});

        const stats = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          const service = buildTeachersService(tenantDb);
          return service.getTeacherStats(params.id, query.date_from, query.date_to);
        });

        return reply.send(stats);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  // ─── POST /api/v1/teachers/:id/reset-password ─────────────────────────────
  // Réinitialise le mot de passe du prof et envoie les credentials par email si possible.
  app.post(
    '/api/v1/teachers/:id/reset-password',
    { preHandler: requirePermission('teachers.edit') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const params = teacherParamsSchema.parse(request.params ?? {});

        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          const service = buildTeachersService(tenantDb);
          return service.resetTeacherPassword(params.id);
        });

        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  // ─── POST /api/v1/teachers/send-credentials ───────────────────────────────
  // Envoie les credentials aux profs sans credentials_sent_at.
  // Body optionnel : { teacher_ids?: string[] } pour restreindre à un sous-ensemble.
  app.post(
    '/api/v1/teachers/send-credentials',
    { preHandler: requirePermission('teachers.edit') },
    async (request, reply) => {
      try {
        const claims = request.claims!;
        const body = (request.body ?? {}) as { teacher_ids?: unknown };
        const teacherIds = Array.isArray(body.teacher_ids)
          ? body.teacher_ids.filter((v): v is string => typeof v === 'string')
          : undefined;

        const result = await withTenantSchema(claims.schemaName, async (tenantDb) => {
          const service = buildTeachersService(tenantDb);
          return service.sendCredentialsToTeachers(teacherIds);
        });

        return reply.send(result);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );
}
