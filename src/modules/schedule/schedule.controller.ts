import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';

import {
  authenticateRequest,
  requireDirectorOrSecretary,
  requireTeacherOrDirectorOrSecretary,
} from '../../shared/middleware/auth.middleware.js';
import {
  attachTenantDb,
  releaseTenantDb,
} from '../../shared/middleware/tenant.middleware.js';
import {
  createSchedule,
  deleteScheduleById,
  findTeacherIdByUserId,
  listSchedulePeriods,
  updateSchedule,
  updateSchedulePeriod,
} from './schedule.repository.js';
import {
  createPeriodFromInput,
  duplicatePeriod,
  getActiveSchedulesForDate,
  getWeeklySchedulesForDate,
  resolveTimeSlotId,
} from './schedule.service.js';
import {
  periodDuplicatePayloadSchema,
  periodPayloadSchema,
  periodUpdatePayloadSchema,
  schedulePayloadSchema,
} from './schedule.schemas.js';

// ─── Helpers ───────────────────────────────────────────────────────────────────

const paramsIdSchema = z.object({
  id: z.string().uuid(),
});

/**
 * BUG 1 — Schéma de validation du querystring `?date=YYYY-MM-DD`.
 * Sans ce schéma, `request.query` est typé `unknown` et la valeur ignorée.
 */
const dateQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const pgErrorCodeSchema = z.object({
  code: z.string(),
});

const ensureTenantDb = (request: FastifyRequest) => {
  if (!request.db) {
    throw new Error('Tenant database not initialized');
  }
  return request.db;
};

const unauthorizedMessages = new Set([
  'Missing Authorization header',
  'Invalid Authorization header',
  'Invalid access token',
]);

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

  const parsedPgError = pgErrorCodeSchema.safeParse(error);
  if (parsedPgError.success) {
    const code = parsedPgError.data.code;
    if (code === '23505') {
      return reply.code(409).send({
        error: 'Conflict with existing data',
        code: 'CONFLICT',
        statusCode: 409,
      });
    }
    if (code === '23503') {
      return reply.code(400).send({
        error: 'Referenced resource does not exist',
        code: 'BAD_REQUEST',
        statusCode: 400,
      });
    }
  }

  const message = error instanceof Error ? error.message : 'Unexpected error';

  if (unauthorizedMessages.has(message)) {
    return reply.code(401).send({ error: message, code: 'UNAUTHORIZED', statusCode: 401 });
  }
  if (message === 'Source schedule period not found') {
    return reply.code(404).send({ error: message, code: 'NOT_FOUND', statusCode: 404 });
  }
  if (message === 'Teacher profile not found') {
    return reply.code(404).send({ error: message, code: 'NOT_FOUND', statusCode: 404 });
  }
  if (
    message === 'Either timeSlotId or both startTime and endTime must be provided' ||
    message === 'startTime must be before endTime'
  ) {
    return reply.code(400).send({ error: message, code: 'BAD_REQUEST', statusCode: 400 });
  }
  if (message === 'Invalid or missing x-tenant-schema header') {
    return reply.code(400).send({ error: message, code: 'BAD_REQUEST', statusCode: 400 });
  }

  request.log.error({ error }, '[schedule] unhandled error');
  return reply.code(500).send({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
    statusCode: 500,
  });
};

/**
 * BUG 1 — Résout la date à utiliser pour les requêtes de planning.
 *
 * Priorité : querystring `?date=YYYY-MM-DD` > date du jour.
 * Le frontend envoie toujours le lundi de la semaine sélectionnée,
 * ce qui permet au service de résoudre la période active correcte.
 */
const resolveDateParam = (query: unknown): Date => {
  const parsed = dateQuerySchema.safeParse(query);
  if (parsed.success && parsed.data.date) {
    // Forcer UTC pour éviter les décalages de fuseau horaire
    const d = new Date(`${parsed.data.date}T00:00:00.000Z`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
};

// ─── Controller ────────────────────────────────────────────────────────────────

export default async function scheduleController(app: FastifyInstance): Promise<void> {
  app.addHook('onResponse', async (request) => {
    await releaseTenantDb(request);
  });

  app.get(
    '/api/v1/schedule/periods',
    { preHandler: [requireDirectorOrSecretary, attachTenantDb] },
    async (request, reply) => {
      try {
        const periods = await listSchedulePeriods(ensureTenantDb(request));
        return reply.send({ periods });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.post(
    '/api/v1/schedule/periods',
    { preHandler: [requireDirectorOrSecretary, attachTenantDb] },
    async (request, reply) => {
      try {
        const body = periodPayloadSchema.parse(request.body);
        const period = await createPeriodFromInput(ensureTenantDb(request), {
          name: body.name,
          validFrom: body.valid_from,
          validTo: body.valid_to,
          createdBy: request.user?.userId ?? null,
        });
        return reply.code(201).send({ period });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.put(
    '/api/v1/schedule/periods/:id',
    { preHandler: [requireDirectorOrSecretary, attachTenantDb] },
    async (request, reply) => {
      try {
        const { id } = paramsIdSchema.parse(request.params);
        const body = periodUpdatePayloadSchema.parse(request.body);
        const period = await updateSchedulePeriod(ensureTenantDb(request), id, {
          name: body.name,
          validFrom: body.valid_from,
          validTo: body.valid_to,
          isActive: body.is_active,
        });
        if (!period) {
          return reply.code(404).send({
            error: 'Schedule period not found',
            code: 'NOT_FOUND',
            statusCode: 404,
          });
        }
        return reply.send({ period });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.post(
    '/api/v1/schedule/periods/:id/duplicate',
    { preHandler: [requireDirectorOrSecretary, attachTenantDb] },
    async (request, reply) => {
      try {
        const { id } = paramsIdSchema.parse(request.params);
        const body = periodDuplicatePayloadSchema.parse(request.body);
        const duplicated = await duplicatePeriod(ensureTenantDb(request), id, {
          newName: body.new_name,
          newValidFrom: body.new_valid_from,
          newValidTo: body.new_valid_to,
          createdBy: request.user?.userId ?? null,
        });
        return reply.code(201).send({
          period: duplicated.period,
          copied_schedules_count: duplicated.copiedCount,
        });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.get(
    '/api/v1/schedule/active',
    { preHandler: [requireTeacherOrDirectorOrSecretary, attachTenantDb] },
    async (request, reply) => {
      try {
        // BUG 1 — Utiliser la date du querystring si fournie
        const date = resolveDateParam(request.query);
        const active = await getActiveSchedulesForDate(ensureTenantDb(request), date);
        return reply.send(active);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.get(
    '/api/v1/schedule/weekly',
    { preHandler: [requireTeacherOrDirectorOrSecretary, attachTenantDb] },
    async (request, reply) => {
      try {
        // BUG 1 — La clé du bug : `new Date()` ignorait le `?date=` du frontend.
        // Le frontend envoie le lundi de la semaine sélectionnée.
        // Le service résout ensuite la période active pour CETTE date,
        // pas pour aujourd'hui. Sans ça, naviguer sur n'importe quelle semaine
        // retournait toujours les créneaux de la période active aujourd'hui.
        const date = resolveDateParam(request.query);
        const weekly = await getWeeklySchedulesForDate(ensureTenantDb(request), date);
        return reply.send({
          date: weekly.date,
          period: weekly.period,
          schedules: weekly.schedules,
          teachers: weekly.teachers,
          classes: weekly.classes,
          rooms: weekly.rooms,
          time_slots: weekly.timeSlots,
        });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.get(
    '/api/v1/schedule/teacher/me',
    { preHandler: [authenticateRequest, attachTenantDb] },
    async (request, reply) => {
      try {
        const userId = request.user?.userId;
        if (!userId) {
          return reply.code(401).send({
            error: 'Unauthorized',
            code: 'UNAUTHORIZED',
            statusCode: 401,
          });
        }
        const tenantDb = ensureTenantDb(request);
        const teacherId = await findTeacherIdByUserId(tenantDb, userId);
        if (!teacherId) {
          throw new Error('Teacher profile not found');
        }
        // /teacher/me retourne toujours les cours du jour — pas de ?date= ici
        const payload = await getActiveSchedulesForDate(tenantDb, new Date(), teacherId);
        return reply.send(payload);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.post(
    '/api/v1/schedule',
    { preHandler: [requireDirectorOrSecretary, attachTenantDb] },
    async (request, reply) => {
      try {
        const body = schedulePayloadSchema.parse(request.body);
        const db = ensureTenantDb(request);

        const timeSlotId = await resolveTimeSlotId(db, {
          timeSlotId: body.time_slot_id,
          startTime: body.start_time,
          endTime: body.end_time,
        });

        const created = await createSchedule(db, {
          schedulePeriodId: body.schedule_period_id,
          teacherId: body.teacher_id,
          classId: body.class_id,
          roomId: body.room_id,
          timeSlotId,
          dayOfWeek: body.day_of_week,
          subject: body.subject,
          isActive: body.is_active,
        });

        return reply.code(201).send({ schedule: created });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.put(
    '/api/v1/schedule/:id',
    { preHandler: [requireDirectorOrSecretary, attachTenantDb] },
    async (request, reply) => {
      try {
        const { id } = paramsIdSchema.parse(request.params);
        const body = schedulePayloadSchema.parse(request.body);
        const db = ensureTenantDb(request);

        const timeSlotId = await resolveTimeSlotId(db, {
          timeSlotId: body.time_slot_id,
          startTime: body.start_time,
          endTime: body.end_time,
        });

        const updated = await updateSchedule(db, id, {
          schedulePeriodId: body.schedule_period_id,
          teacherId: body.teacher_id,
          classId: body.class_id,
          roomId: body.room_id,
          timeSlotId,
          dayOfWeek: body.day_of_week,
          subject: body.subject,
          isActive: body.is_active,
        });

        if (!updated) {
          return reply.code(404).send({
            error: 'Schedule not found',
            code: 'NOT_FOUND',
            statusCode: 404,
          });
        }

        return reply.send({ schedule: updated });
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.delete(
    '/api/v1/schedule/:id',
    { preHandler: [requireDirectorOrSecretary, attachTenantDb] },
    async (request, reply) => {
      try {
        const { id } = paramsIdSchema.parse(request.params);
        const deleted = await deleteScheduleById(ensureTenantDb(request), id);
        if (!deleted) {
          return reply.code(404).send({
            error: 'Schedule not found',
            code: 'NOT_FOUND',
            statusCode: 404,
          });
        }
        return reply.code(204).send();
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );
}
