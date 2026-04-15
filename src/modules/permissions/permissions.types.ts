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

export const assignPositionParamsSchema = z.object({
  id: z.string().uuid(),
});

export const removeAssignmentParamsSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
});

export const SECRETARY_BASE_PERMISSIONS: readonly PermissionKey[] = [
  'teachers.view',
  'students.view',
  'attendance.mark_students',
  'schedule.view',
];
