import { z } from 'zod';

const TENANT_PLAN_VALUES = ['essential', 'pro', 'establishment'] as const;
const TENANT_STATUS_VALUES = ['trial', 'active', 'suspended', 'cancelled'] as const;

export type TenantPlan = (typeof TENANT_PLAN_VALUES)[number];
export type TenantStatus = (typeof TENANT_STATUS_VALUES)[number];

export const listTenantsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
});

export const createTenantBodySchema = z.object({
  name: z.string().min(2).max(255),
  subdomain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  plan: z.enum(TENANT_PLAN_VALUES).default('essential'),
  directorName: z.string().min(2).max(255),
  directorPhone: z.string().min(8).max(20),
  directorEmail: z.string().email().max(255).optional(),
});

export const updateTenantParamsSchema = z.object({
  id: z.string().uuid(),
});

export const updateTenantBodySchema = z
  .object({
    plan: z.enum(TENANT_PLAN_VALUES).optional(),
    status: z.enum(TENANT_STATUS_VALUES).optional(),
  })
  .refine((value) => value.plan || value.status, {
    message: 'At least one field must be provided',
  });

export const tenantParamsSchema = z.object({
  id: z.string().uuid(),
});

export type ListTenantsQuery = z.infer<typeof listTenantsQuerySchema>;
export type CreateTenantBody = z.infer<typeof createTenantBodySchema>;
export type UpdateTenantBody = z.infer<typeof updateTenantBodySchema>;

export type TenantListItem = {
  id: string;
  name: string;
  subdomain: string;
  schemaName: string;
  plan: TenantPlan;
  status: TenantStatus;
  activeUsers48h: number;
  activeTeachers: number;
  attendanceRate7d: number;
  lastAttendanceAt: string | null;
  estimatedMrrFcfa: number;
  churnRisk: boolean;
};

export type TenantListResult = {
  tenants: TenantListItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
};

export type TenantStatsResult = {
  tenantId: string;
  dau: number;
  wau: number;
  mau: number;
  smsSent30d: number;
  attendanceRateByDay: Array<{
    date: string;
    attendanceRate: number;
    total: number;
  }>;
  topTeachersByAbsence: Array<{
    teacherId: string;
    teacherName: string;
    absenceCount: number;
  }>;
};
