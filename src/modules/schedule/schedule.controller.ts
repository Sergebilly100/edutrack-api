import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';

import { authenticateRequest } from '../../shared/middleware/auth.middleware.js';
import {
  attachTenantDb,
  releaseTenantDb,
} from '../../shared/middleware/tenant.middleware.js';
import {
  createSchedule,
  deleteScheduleById,
  findTeacherIdByUserId,
  listSchedulePeriods,
  type ScheduleMutationInput,
  updateSchedule,
  updateSchedulePeriod,
} from './schedule.repository.js';
import {
  createPeriodFromInput,
  duplicatePeriod,
  getActiveSchedulesForDate,
} from './schedule.service.js';
import {
  periodDuplicatePayloadSchema,
  periodPayloadSchema,
  periodUpdatePayloadSchema,
  schedulePayloadSchema,
} from './schedule.schemas.js';

const paramsIdSchema = z.object({
  id: z.string().uuid(),
});

const pgErrorCodeSchema = z.object({
  code: z.string(),
});

const mapSchedulePayload = (
  payload: z.infer<typeof schedulePayloadSchema>
): ScheduleMutationInput => ({
  schedulePeriodId: payload.schedule_period_id,
  teacherId: payload.teacher_id,
  classId: payload.class_id,
  roomId: payload.room_id,
  timeSlotId: payload.time_slot_id,
  dayOfWeek: payload.day_of_week,
  subject: payload.subject,
  isActive: payload.is_active,
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
    return reply.code(401).send({
      error: message,
      code: 'UNAUTHORIZED',
      statusCode: 401,
    });
  }

  if (message === 'Source schedule period not found') {
    return reply.code(404).send({
      error: message,
      code: 'NOT_FOUND',
      statusCode: 404,
    });
  }

  if (message === 'Teacher profile not found') {
    return reply.code(404).send({
      error: message,
      code: 'NOT_FOUND',
      statusCode: 404,
    });
  }

  if (message === 'Invalid or missing x-tenant-schema header') {
    return reply.code(400).send({
      error: message,
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
  }

  request.log.error({ error }, '[schedule] unhandled error');
  return reply.code(500).send({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
    statusCode: 500,
  });
};

export default async function scheduleController(app: FastifyInstance): Promise<void> {
  app.addHook('onResponse', async (request) => {
    await releaseTenantDb(request);
  });

  app.get(
    '/api/v1/schedule/periods',
    { preHandler: [attachTenantDb] },
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
    { preHandler: [authenticateRequest, attachTenantDb] },
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
    { preHandler: [attachTenantDb] },
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
    { preHandler: [authenticateRequest, attachTenantDb] },
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

  app.get('/api/v1/schedule/active', { preHandler: [attachTenantDb] }, async (request, reply) => {
    try {
      const active = await getActiveSchedulesForDate(ensureTenantDb(request), new Date());
      return reply.send(active);
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

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

        const payload = await getActiveSchedulesForDate(tenantDb, new Date(), teacherId);
        return reply.send(payload);
      } catch (error) {
        return handleError(request, reply, error);
      }
    }
  );

  app.post('/api/v1/schedule', { preHandler: [attachTenantDb] }, async (request, reply) => {
    try {
      const body = schedulePayloadSchema.parse(request.body);
      const created = await createSchedule(ensureTenantDb(request), mapSchedulePayload(body));

      return reply.code(201).send({ schedule: created });
    } catch (error) {
      return handleError(request, reply, error);
    }
  });

  app.put('/api/v1/schedule/:id', { preHandler: [attachTenantDb] }, async (request, reply) => {
    try {
      const { id } = paramsIdSchema.parse(request.params);
      const body = schedulePayloadSchema.parse(request.body);
      const updated = await updateSchedule(ensureTenantDb(request), id, mapSchedulePayload(body));

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
  });

  app.delete('/api/v1/schedule/:id', { preHandler: [attachTenantDb] }, async (request, reply) => {
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
  });

}
