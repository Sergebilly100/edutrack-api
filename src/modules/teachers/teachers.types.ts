import { z } from 'zod';

export const PHONE_CI_REGEX = /^225\d{10}$/;
export const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export const teachersListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(10),
  type: z.enum(['vacataire', 'permanent']).optional(),
  is_active: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => {
      if (value === undefined) return undefined;
      return value === 'true';
    }),
  subject: z.string().trim().min(1).max(100).optional(),
  search: z.string().trim().min(1).max(100).optional(),
});

const teacherTypeSchema = z.enum(['vacataire', 'permanent']);

const fullPayloadSchema = z
  .object({
    first_name: z.string().trim().min(1).max(100),
    last_name: z.string().trim().min(1).max(100),
    matricule: z.string().trim().min(1).max(50).nullable().optional().default(null),
    phone: z.string().regex(PHONE_CI_REGEX).nullable().optional().default(null),
    email: z.string().trim().email().max(255).nullable().optional().default(null),
    type: teacherTypeSchema,
    subjects: z.array(z.string().trim().min(1).max(100)).default([]),
    hourly_rate: z.number().int().min(0).nullable().optional().default(null),
    monthly_salary: z.number().int().min(0).nullable().optional().default(null),
  })
  .superRefine((payload, ctx) => {
    if (payload.type === 'vacataire' && payload.hourly_rate === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hourly_rate'],
        message: 'hourly_rate is required for vacataire',
      });
    }

    if (payload.type === 'permanent' && payload.monthly_salary === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['monthly_salary'],
        message: 'monthly_salary is required for permanent',
      });
    }
  });

const onboardingPayloadSchema = z.object({
  name: z.string().trim().min(1).max(200),
  type: teacherTypeSchema,
  subjects: z.array(z.string().trim().min(1).max(100)).default([]),
});

export const createTeacherBodySchema = z.union([fullPayloadSchema, onboardingPayloadSchema]);

export const updateTeacherBodySchema = z
  .object({
    first_name: z.string().trim().min(1).max(100).optional(),
    last_name: z.string().trim().min(1).max(100).optional(),
    matricule: z.string().trim().min(1).max(50).nullable().optional(),
    phone: z.string().regex(PHONE_CI_REGEX).nullable().optional(),
    email: z.string().trim().email().max(255).nullable().optional(),
    type: teacherTypeSchema.optional(),
    subjects: z.array(z.string().trim().min(1).max(100)).optional(),
    hourly_rate: z.number().int().min(0).nullable().optional(),
    monthly_salary: z.number().int().min(0).nullable().optional(),
    // Champ is_active : désactive l'accès au compte (users.is_active) - distinct du blocage
    is_active: z.boolean().optional(),
    // Champ de blocage métier - opère sur teachers.is_blocked + teachers.blocked_reason
    is_blocked: z.boolean().optional(),
    blocked_reason: z.string().trim().max(500).nullable().optional(),
  })
  .refine((payload) => Object.keys(payload).length > 0, {
    message: 'At least one field is required',
  });

export const teacherParamsSchema = z.object({
  id: z.uuid(),
});

export const teacherStatsQuerySchema = z.object({
  date_from: z.string().regex(ISO_DATE_REGEX),
  date_to: z.string().regex(ISO_DATE_REGEX),
});

export const teacherAttendanceStatsQuerySchema = z.object({
  from: z.string().regex(ISO_DATE_REGEX),
  to: z.string().regex(ISO_DATE_REGEX),
  subject: z.string().trim().min(1).max(100).optional(),
  class_id: z.uuid().optional(),
  teacher_id: z.uuid().optional(),
  status_filter: z.enum(['absent', 'room_mismatch', 'rollcall_missing', 'late']).optional(),
});

export type TeachersListQuery = z.infer<typeof teachersListQuerySchema>;
export type CreateTeacherInput = z.infer<typeof fullPayloadSchema> & {
  name: string;
};
export type UpdateTeacherInput = z.infer<typeof updateTeacherBodySchema>;
export type TeacherAttendanceStatsQuery = z.infer<typeof teacherAttendanceStatsQuerySchema>;
