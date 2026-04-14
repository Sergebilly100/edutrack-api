import { z } from 'zod';

const dateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format');

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

export const schedulePayloadSchema = z.object({
  schedule_period_id: z.string().uuid(),
  teacher_id: z.string().uuid(),
  class_id: z.string().uuid(),
  room_id: z.string().uuid(),
  time_slot_id: z.string().uuid(),
  day_of_week: z.number().int().min(1).max(6),
  subject: z.string().trim().min(1).max(100),
  is_active: z.boolean().optional(),
});

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
