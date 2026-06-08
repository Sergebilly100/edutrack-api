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
  addScheduleException,
  closeScheduleAtDate,
  createSchedule,
  deleteScheduleById,
  ensureScheduleTemporalColumns,
  findScheduleConflicts,
  findSchedulePeriodById,
  hasAnyAttendanceForSchedule,
  hasScheduleOccurrenceBeforeDate,
  findTimeSlotById,
  findTeacherIdByUserId,
  listActiveSchedulePeriods,
  listSchedulePeriods,
  updateSchedule,
  updateSchedulePeriod,
} from './schedule.repository.js';
import {
  computeOneShotEndDate,
  createPeriodFromInput,
  duplicatePeriod,
  getActiveSchedulesForDate,
  getWeeklySchedulesForDate,
  hasFutureOccurrenceInPeriod,
  resolveTimeSlotId,
} from './schedule.service.js';
import {
  periodDuplicatePayloadSchema,
  periodPayloadSchema,
  periodUpdatePayloadSchema,
  schedulePayloadSchema,
} from './schedule.schemas.js';
import { canonicalizeSubject } from '../../shared/utils/subject-normalization.js';

// ─── Helpers ───────────────────────────────────────────────────────────────────

const paramsIdSchema = z.object({
  id: z.string().uuid(),
});

/**
 * BUG 1 - Schéma de validation du querystring `?date=YYYY-MM-DD`.
 * Sans ce schéma, `request.query` est typé `unknown` et la valeur ignorée.
 */
const dateQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
const effectiveFromQuerySchema = z.object({
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  delete_scope: z.enum(['this', 'this_and_following']).optional(),
});

const periodsListQuerySchema = z.object({
  active: z.enum(['true', 'false']).optional(),
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
  if (message === 'Schedule period not found' || message === 'Time slot not found') {
    return reply.code(404).send({ error: message, code: 'NOT_FOUND', statusCode: 404 });
  }
  if (message === 'Schedule must target a future date/time') {
    return reply.code(400).send({ error: message, code: 'BAD_REQUEST', statusCode: 400 });
  }
  if (message === 'Schedule date is outside the selected period') {
    return reply.code(400).send({
      error: message,
      code: 'SCHEDULE_DATE_OUTSIDE_PERIOD',
      statusCode: 400,
    });
  }
  if (message === 'Cannot apply schedule changes to a past date') {
    return reply.code(409).send({
      error: message,
      code: 'SCHEDULE_PAST_LOCKED',
      statusCode: 409,
    });
  }
  if (message === 'Schedule has past occurrences and cannot be edited or deleted') {
    return reply.code(409).send({
      error: message,
      code: 'SCHEDULE_PAST_LOCKED',
      statusCode: 409,
    });
  }
  if (message === 'Teacher already has a course at the same time') {
    return reply.code(409).send({
      error: message,
      code: 'TEACHER_SCHEDULE_CONFLICT',
      statusCode: 409,
    });
  }
  if (message === 'Room already has a course at the same time') {
    return reply.code(409).send({
      error: message,
      code: 'ROOM_SCHEDULE_CONFLICT',
      statusCode: 409,
    });
  }
  if (message === 'Class already has a course at the same time') {
    return reply.code(409).send({
      error: message,
      code: 'CLASS_SCHEDULE_CONFLICT',
      statusCode: 409,
    });
  }

  request.log.error({ error }, '[schedule] unhandled error');
  return reply.code(500).send({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
    statusCode: 500,
  });
};

/**
 * BUG 1 - Résout la date à utiliser pour les requêtes de planning.
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

const getTodayIso = (): string => new Date().toISOString().slice(0, 10);

const isIsoDateBefore = (leftIsoDate: string, rightIsoDate: string): boolean =>
  leftIsoDate < rightIsoDate;

// Defense-in-depth : un créneau doit tomber dans la plage de validité de sa
// période. Sans cette garde, un cours créé hors période n'apparaît jamais dans
// la grille (qui ne lit que la période couvrant la semaine) → cours "fantôme".
// La validation existe côté UI mais ne doit pas être la seule (appels API directs).
const assertEffectiveDateWithinPeriod = async (
  db: NonNullable<FastifyRequest['db']>,
  params: { schedulePeriodId: string; effectiveFrom: string }
): Promise<void> => {
  const period = await findSchedulePeriodById(db, params.schedulePeriodId);
  if (!period) {
    throw new Error('Schedule period not found');
  }
  if (
    isIsoDateBefore(params.effectiveFrom, period.valid_from) ||
    isIsoDateBefore(period.valid_to, params.effectiveFrom)
  ) {
    throw new Error('Schedule date is outside the selected period');
  }
};

const assertScheduleTargetsFutureDateTime = async (
  db: NonNullable<FastifyRequest['db']>,
  input: {
    schedulePeriodId: string;
    dayOfWeek: number;
    startTime: string;
  }
): Promise<void> => {
  const period = await findSchedulePeriodById(db, input.schedulePeriodId);
  if (!period) {
    throw new Error('Schedule period not found');
  }

  const hasFuture = hasFutureOccurrenceInPeriod({
    validFrom: period.valid_from,
    validTo: period.valid_to,
    dayOfWeek: input.dayOfWeek,
    startTime: input.startTime,
  });

  if (!hasFuture) {
    throw new Error('Schedule must target a future date/time');
  }
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
        const db = ensureTenantDb(request);
        await ensureScheduleTemporalColumns(db);
        const query = periodsListQuerySchema.parse(request.query ?? {});
        const periods = query.active === 'true'
          ? await listActiveSchedulePeriods(db, getTodayIso())
          : await listSchedulePeriods(db);
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
        await ensureScheduleTemporalColumns(ensureTenantDb(request));
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
        await ensureScheduleTemporalColumns(ensureTenantDb(request));
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
        await ensureScheduleTemporalColumns(ensureTenantDb(request));
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
        await ensureScheduleTemporalColumns(ensureTenantDb(request));
        // BUG 1 - Utiliser la date du querystring si fournie
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
        await ensureScheduleTemporalColumns(ensureTenantDb(request));
        // BUG 1 - La clé du bug : `new Date()` ignorait le `?date=` du frontend.
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
        await ensureScheduleTemporalColumns(tenantDb);
        const teacherId = await findTeacherIdByUserId(tenantDb, userId);
        if (!teacherId) {
          throw new Error('Teacher profile not found');
        }
        // /teacher/me retourne toujours les cours du jour - pas de ?date= ici
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
        await ensureScheduleTemporalColumns(db);
        const canonicalSubject = canonicalizeSubject(body.subject);
        const today = getTodayIso();
        const effectiveFrom = body.effective_from ?? today;

        if (isIsoDateBefore(effectiveFrom, today)) {
          throw new Error('Cannot apply schedule changes to a past date');
        }

        // On ne valide la couverture que si l'utilisateur a fourni une date
        // explicite (cas one_shot / date précise). Sans date fournie,
        // effective_from défaute à aujourd'hui avec la sémantique « à partir de
        // maintenant » et l'effet réel est déjà borné à la période côté repo -
        // bloquer ici casserait la modification d'un créneau d'une période future.
        if (body.effective_from) {
          await assertEffectiveDateWithinPeriod(db, {
            schedulePeriodId: body.schedule_period_id,
            effectiveFrom: body.effective_from,
          });
        }

        const timeSlotId = await resolveTimeSlotId(db, {
          timeSlotId: body.time_slot_id,
          startTime: body.start_time,
          endTime: body.end_time,
        });
        const resolvedStartTime = body.start_time ?? (await findTimeSlotById(db, timeSlotId))?.startTime;
        if (!resolvedStartTime) {
          throw new Error('Time slot not found');
        }

        await assertScheduleTargetsFutureDateTime(db, {
          schedulePeriodId: body.schedule_period_id,
          dayOfWeek: body.day_of_week,
          startTime: resolvedStartTime,
        });

        const conflicts = await findScheduleConflicts(db, {
          schedulePeriodId: body.schedule_period_id,
          teacherId: body.teacher_id,
          classId: body.class_id,
          roomId: body.room_id,
          timeSlotId,
          dayOfWeek: body.day_of_week,
          subject: canonicalSubject,
          startDate: effectiveFrom,
          isActive: body.is_active,
          referenceDate: effectiveFrom,
        });
        if (conflicts.teacherConflict) {
          throw new Error('Teacher already has a course at the same time');
        }
        if (conflicts.roomConflict) {
          throw new Error('Room already has a course at the same time');
        }
        if (conflicts.classConflict) {
          throw new Error('Class already has a course at the same time');
        }

        const endDate = body.recurrence === 'one_shot'
          ? computeOneShotEndDate(effectiveFrom)
          : null;

        const created = await createSchedule(db, {
          schedulePeriodId: body.schedule_period_id,
          teacherId: body.teacher_id,
          classId: body.class_id,
          roomId: body.room_id,
          timeSlotId,
          dayOfWeek: body.day_of_week,
          subject: canonicalSubject,
          startDate: effectiveFrom,
          endDate,
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
        await ensureScheduleTemporalColumns(db);
        const canonicalSubject = canonicalizeSubject(body.subject);
        const today = getTodayIso();
        const effectiveFrom = body.effective_from ?? today;

        if (isIsoDateBefore(effectiveFrom, today)) {
          throw new Error('Cannot apply schedule changes to a past date');
        }

        // On ne valide la couverture que si l'utilisateur a fourni une date
        // explicite (cas one_shot / date précise). Sans date fournie,
        // effective_from défaute à aujourd'hui avec la sémantique « à partir de
        // maintenant » et l'effet réel est déjà borné à la période côté repo -
        // bloquer ici casserait la modification d'un créneau d'une période future.
        if (body.effective_from) {
          await assertEffectiveDateWithinPeriod(db, {
            schedulePeriodId: body.schedule_period_id,
            effectiveFrom: body.effective_from,
          });
        }

        const timeSlotId = await resolveTimeSlotId(db, {
          timeSlotId: body.time_slot_id,
          startTime: body.start_time,
          endTime: body.end_time,
        });
        const resolvedStartTime = body.start_time ?? (await findTimeSlotById(db, timeSlotId))?.startTime;
        if (!resolvedStartTime) {
          throw new Error('Time slot not found');
        }

        await assertScheduleTargetsFutureDateTime(db, {
          schedulePeriodId: body.schedule_period_id,
          dayOfWeek: body.day_of_week,
          startTime: resolvedStartTime,
        });

        const conflicts = await findScheduleConflicts(db, {
          schedulePeriodId: body.schedule_period_id,
          teacherId: body.teacher_id,
          classId: body.class_id,
          roomId: body.room_id,
          timeSlotId,
          dayOfWeek: body.day_of_week,
          subject: canonicalSubject,
          startDate: effectiveFrom,
          isActive: body.is_active,
          excludeScheduleId: id,
          referenceDate: effectiveFrom,
        });
        if (conflicts.teacherConflict) {
          throw new Error('Teacher already has a course at the same time');
        }
        if (conflicts.roomConflict) {
          throw new Error('Room already has a course at the same time');
        }
        if (conflicts.classConflict) {
          throw new Error('Class already has a course at the same time');
        }

        const updateScope = body.update_scope ?? 'this_and_following';

        if (updateScope === 'this') {
          // Modifier uniquement cette occurrence : créer un schedule one-shot
          // sur la date concernée + masquer le récurrent original ce jour-là.
          const oneShotEndDate = computeOneShotEndDate(effectiveFrom);

          const result = await db.transaction(async (tx) => {
            await addScheduleException(tx, id, effectiveFrom);
            const created = await createSchedule(tx, {
              schedulePeriodId: body.schedule_period_id,
              teacherId: body.teacher_id,
              classId: body.class_id,
              roomId: body.room_id,
              timeSlotId,
              dayOfWeek: body.day_of_week,
              subject: canonicalSubject,
              startDate: effectiveFrom,
              endDate: oneShotEndDate,
              isActive: body.is_active,
            });
            return { created };
          });

          return reply.send({
            schedule: result.created,
            original_schedule_id: id,
            occurrence_date: effectiveFrom,
          });
        }

        if (updateScope === 'all') {
          // Modifier toutes les occurrences (passé + futur) : UPDATE direct.
          // Verrouillage : interdire si des présences ont été enregistrées
          // (préserver l'intégrité de l'historique d'attendance).
          const hasAttendance = await hasAnyAttendanceForSchedule(db, id);
          if (hasAttendance) {
            throw new Error('Schedule has past occurrences and cannot be edited or deleted');
          }

          const updated = await updateSchedule(db, id, {
            schedulePeriodId: body.schedule_period_id,
            teacherId: body.teacher_id,
            classId: body.class_id,
            roomId: body.room_id,
            timeSlotId,
            dayOfWeek: body.day_of_week,
            subject: canonicalSubject,
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
        }

        // Défaut : 'this_and_following' - comportement historique.
        const hasPastOccurrences = await hasScheduleOccurrenceBeforeDate(db, id, effectiveFrom);

        if (hasPastOccurrences) {
          const versionedUpdate = await db.transaction(async (tx) => {
            const closed = await closeScheduleAtDate(tx, id, effectiveFrom);
            if (!closed) {
              return null;
            }

            const created = await createSchedule(tx, {
              schedulePeriodId: body.schedule_period_id,
              teacherId: body.teacher_id,
              classId: body.class_id,
              roomId: body.room_id,
              timeSlotId,
              dayOfWeek: body.day_of_week,
              subject: canonicalSubject,
              startDate: effectiveFrom,
              isActive: body.is_active,
            });

            return { created };
          });

          if (!versionedUpdate) {
            return reply.code(404).send({
              error: 'Schedule not found',
              code: 'NOT_FOUND',
              statusCode: 404,
            });
          }

          return reply.send({
            schedule: versionedUpdate.created,
            replaced_schedule_id: id,
            change_effective_from: effectiveFrom,
          });
        }

        const updated = await updateSchedule(db, id, {
          schedulePeriodId: body.schedule_period_id,
          teacherId: body.teacher_id,
          classId: body.class_id,
          roomId: body.room_id,
          timeSlotId,
          dayOfWeek: body.day_of_week,
          subject: canonicalSubject,
          startDate: effectiveFrom,
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
        const db = ensureTenantDb(request);
        await ensureScheduleTemporalColumns(db);
        const today = getTodayIso();
        const query = effectiveFromQuerySchema.parse(request.query ?? {});
        const effectiveFrom = query.effective_from ?? today;
        const deleteScope = query.delete_scope ?? 'this_and_following';

        if (isIsoDateBefore(effectiveFrom, today)) {
          throw new Error('Cannot apply schedule changes to a past date');
        }

        if (deleteScope === 'this') {
          // Supprimer uniquement cette occurrence : créer une exception.
          // L'historique d'attendance reste intact, le récurrent continue ensuite.
          await addScheduleException(db, id, effectiveFrom);
          return reply.code(204).send();
        }

        const hasPastOccurrences = await hasScheduleOccurrenceBeforeDate(db, id, effectiveFrom);

        if (hasPastOccurrences) {
          const closed = await closeScheduleAtDate(db, id, effectiveFrom);
          if (!closed) {
            return reply.code(404).send({
              error: 'Schedule not found',
              code: 'NOT_FOUND',
              statusCode: 404,
            });
          }

          return reply.code(204).send();
        }

        const deleted = await deleteScheduleById(db, id);
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
