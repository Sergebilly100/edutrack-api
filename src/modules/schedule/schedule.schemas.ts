import { z } from 'zod';

const dateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format');

// FIX BUG 3 - Format "HH:MM" strict
const timeStringSchema = z
  .string()
  .regex(/^\d{2}:\d{2}$/, 'Invalid time format - expected HH:MM');

export const periodPayloadSchema = z
  .object({
    name: z.string().trim().min(1).max(150),
    valid_from: dateStringSchema,
    valid_to: dateStringSchema,
  })
  .refine((value) => value.valid_from <= value.valid_to, {
    message: 'valid_from must be before or equal to valid_to',
    path: ['valid_to'],
  });

export const periodUpdatePayloadSchema = z
  .object({
    name: z.string().trim().min(1).max(150).optional(),
    valid_from: dateStringSchema.optional(),
    valid_to: dateStringSchema.optional(),
    is_active: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: 'At least one field must be provided',
  })
  .refine(
    (value) => {
      if (!value.valid_from || !value.valid_to) {
        return true;
      }
      return value.valid_from <= value.valid_to;
    },
    {
      message: 'valid_from must be before or equal to valid_to',
      path: ['valid_to'],
    }
  );

export const periodDuplicatePayloadSchema = z
  .object({
    new_name: z.string().trim().min(1).max(150),
    new_valid_from: dateStringSchema,
    new_valid_to: dateStringSchema,
  })
  .refine((value) => value.new_valid_from <= value.new_valid_to, {
    message: 'new_valid_from must be before or equal to new_valid_to',
    path: ['new_valid_to'],
  });

/**
 * FIX BUG 3 - schedulePayloadSchema accepte désormais deux formes :
 *
 * Forme A (backward compat) : time_slot_id fourni → on l'utilise directement.
 * Forme B (nouveau)          : start_time + end_time fournis → résolution côté service.
 *
 * La validation Zod discrimine via `.refine` pour s'assurer qu'on a l'un ou l'autre.
 */
export const schedulePayloadSchema = z
  .object({
    schedule_period_id: z.string().uuid(),
    teacher_id: z.string().uuid(),
    class_id: z.string().uuid(),
    room_id: z.string().uuid(),
    // Optionnel - si absent, start_time + end_time sont requis
    time_slot_id: z.string().uuid().optional(),
    // FIX BUG 3 - Horaires libres
    start_time: timeStringSchema.optional(),
    end_time: timeStringSchema.optional(),
    day_of_week: z.number().int().min(1).max(6),
    subject: z.string().trim().min(1).max(100),
    effective_from: dateStringSchema.optional(),
    // Type de récurrence : 'recurring' (toutes les semaines de la période)
    // ou 'one_shot' (uniquement la date effective_from, ex: rattrapage)
    recurrence: z.enum(['recurring', 'one_shot']).optional(),
    // Portée de la modification (PUT uniquement) :
    // - 'this' : uniquement cette occurrence (exception + one-shot)
    // - 'this_and_following' : à partir de cette date (clôture + nouvelle version)
    // - 'all' : toutes les occurrences (UPDATE direct)
    update_scope: z.enum(['this', 'this_and_following', 'all']).optional(),
    is_active: z.boolean().optional(),
  })
  .refine(
    (value) => {
      // Exactement l'un des deux modes doit être fourni
      const hasSlotId = !!value.time_slot_id;
      const hasTimes = !!value.start_time && !!value.end_time;
      return hasSlotId || hasTimes;
    },
    {
      message: 'Provide either time_slot_id or both start_time and end_time',
      path: ['time_slot_id'],
    }
  )
  .refine(
    (value) => {
      // Si les deux heures sont fournies, vérifier start < end
      if (!value.start_time || !value.end_time) return true;
      return value.start_time < value.end_time;
    },
    {
      message: 'start_time must be before end_time',
      path: ['end_time'],
    }
  )
  .refine(
    (value) => {
      // Un créneau one-shot doit avoir une date d'occurrence
      if (value.recurrence !== 'one_shot') return true;
      return !!value.effective_from;
    },
    {
      message: 'effective_from is required for one_shot recurrence',
      path: ['effective_from'],
    }
  );

export const roomCreatePayloadSchema = z.object({
  name: z.string().trim().min(1).max(100),
  building: z.string().trim().max(100).optional().nullable(),
  capacity: z.number().int().positive().optional().nullable(),
  is_active: z.boolean().optional(),
});

export const roomUpdatePayloadSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    building: z.string().trim().max(100).optional().nullable(),
    capacity: z.number().int().positive().optional().nullable(),
    is_active: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: 'At least one field must be provided',
  });
