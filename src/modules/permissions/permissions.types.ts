import { z } from 'zod';

import type { PermissionKey } from '../../shared/types/index.js';

export const PERMISSION_KEYS = [
  'teachers.view',
  'teachers.create',
  'teachers.edit',
  'teachers.block',
  'teachers.documents',
  'students.view',
  'students.create',
  'students.edit',
  'students.documents',
  'schedule.view',
  'schedule.edit',
  'attendance.view',
  'attendance.mark_students',
  'salary.view',
  'salary.compute',
  'salary.mark_paid',
  'salary.export',
  'settings.positions',
  'settings.school',
  'settings.sms_templates',
] as const satisfies readonly PermissionKey[];

const permissionKeySchema = z.enum(PERMISSION_KEYS);

export const createPositionBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  permissions: z.array(permissionKeySchema),
});

export const updatePositionBodySchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    permissions: z.array(permissionKeySchema).optional(),
  })
  .refine((value) => value.name !== undefined || value.permissions !== undefined, {
    message: 'At least one field must be provided',
  });

export const positionIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const assignPositionBodySchema = z.object({
  userId: z.string().uuid(),
});

export const createAdministrativeUserBodySchema = z
  .object({
    name: z.string().trim().min(2).max(255),
    email: z.string().trim().toLowerCase().email().optional(),
    phone: z.string().trim().min(6).max(20).optional(),
    password: z.string().min(8).max(128),
  })
  .refine((value) => value.email !== undefined || value.phone !== undefined, {
    message: 'Either email or phone is required',
  });

export const updateAdministrativeUserBodySchema = z
  .object({
    name: z.string().trim().min(2).max(255).optional(),
    email: z.string().trim().toLowerCase().email().nullable().optional(),
    phone: z.string().trim().min(6).max(20).nullable().optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined || value.email !== undefined || value.phone !== undefined,
    {
      message: 'At least one field must be provided',
    }
  )
  .refine(
    (value) => {
      const email = value.email ?? undefined;
      const phone = value.phone ?? undefined;
      if (email !== undefined && email !== null && email.length > 0) {
        return true;
      }
      if (phone !== undefined && phone !== null && phone.length > 0) {
        return true;
      }
      return value.email === undefined && value.phone === undefined;
    },
    {
      message: 'Either email or phone is required',
    }
  );

export const administrativeUserIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const resetAdministrativeUserPasswordBodySchema = z.object({
  newPassword: z.string().min(8).max(128),
});

export const assignPositionParamsSchema = z.object({
  id: z.string().uuid(),
});

export const removeAssignmentParamsSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
});

export const updateSchoolConfigBodySchema = z
  .object({
    name: z.string().trim().min(2).max(255).optional(),
    city: z.string().trim().min(2).max(255).optional(),
    teachingType: z
      .enum(['general', 'technical', 'mixed', 'primaire', 'secondaire', 'superieur', 'mixte'])
      .optional(),
    logoUrl: z.string().trim().max(2_000_000).nullable().optional(),
    activeSchoolYear: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{4}$/)
      .nullable()
      .optional(),
    allowTeacherQrSkip: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.city !== undefined ||
      value.teachingType !== undefined ||
      value.logoUrl !== undefined ||
      value.activeSchoolYear !== undefined ||
      value.allowTeacherQrSkip !== undefined,
    {
      message: 'At least one field must be provided',
    }
  );

export const updateLimitsBodySchema = z.object({
  max_admin_positions: z.number().int().min(1).max(50),
});

export const STAFF_BASE_PERMISSIONS: readonly PermissionKey[] = [
  'teachers.view',
  'students.view',
  'attendance.mark_students',
  'schedule.view',
];

// Backward-compatible alias during role transition.
export const SECRETARY_BASE_PERMISSIONS = STAFF_BASE_PERMISSIONS;
