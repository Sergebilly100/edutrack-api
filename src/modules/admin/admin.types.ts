import { z } from 'zod';

const TENANT_PLAN_VALUES = ['essential', 'pro', 'establishment'] as const;
const TENANT_STATUS_VALUES = ['trial', 'active', 'suspended', 'cancelled'] as const;
const TEACHING_TYPE_VALUES = ['primaire', 'secondaire', 'superieur', 'mixte'] as const;

export type TenantPlan = (typeof TENANT_PLAN_VALUES)[number];
export type TenantStatus = (typeof TENANT_STATUS_VALUES)[number];
export type TeachingType = (typeof TEACHING_TYPE_VALUES)[number];

export const listTenantsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  plan: z.enum(TENANT_PLAN_VALUES).optional(),
  status: z.enum(TENANT_STATUS_VALUES).optional(),
  churnRisk: z
    .union([z.boolean(), z.coerce.number().int().min(0).max(1), z.enum(['true', 'false'])])
    .transform((value) => (value === 'true' ? true : value === 'false' ? false : Boolean(value)))
    .optional(),
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

export const createSchoolBodySchema = z.object({
  name: z.string().trim().min(2).max(255),
  subdomain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  city: z.string().trim().min(1).max(120),
  teaching_type: z.enum(TEACHING_TYPE_VALUES),
  director_name: z.string().trim().min(2).max(255),
  director_phone: z.string().regex(/^225\d{10}$/),
  director_email: z.string().email().max(255).optional(),
  max_admin_positions: z.coerce.number().int().min(1).max(50).default(5),
  active_school_year: z.string().trim().regex(/^\d{4}-\d{4}$/),
  plan: z.enum(TENANT_PLAN_VALUES).default('essential'),
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

export const schoolTenantIdParamsSchema = z.object({
  tenantId: z.string().uuid(),
});

export const listSchoolsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
});

export const updateSchoolConfigBodySchema = z
  .object({
    max_admin_positions: z.coerce.number().int().min(1).max(50).optional(),
    max_users: z.coerce.number().int().min(1).max(500).optional(),
    max_sms_per_month: z.coerce.number().int().min(0).max(200000).optional(),
    city: z.string().trim().min(1).max(120).optional(),
    teaching_type: z.enum(TEACHING_TYPE_VALUES).optional(),
    student_label: z.string().trim().min(1).max(120).optional(),
    director_title: z.string().trim().min(1).max(120).optional(),
    can_edit_sms_template: z.boolean().optional(),
    can_export_data: z.boolean().optional(),
    active_school_year: z.string().trim().regex(/^\d{4}-\d{4}$/).optional(),
    logo_url: z.string().trim().max(2_000_000).nullable().optional(),
    plan: z.enum(TENANT_PLAN_VALUES).optional(),
    status: z.enum(TENANT_STATUS_VALUES).optional(),
  })
  .refine(
    (value) =>
      value.max_admin_positions !== undefined ||
      value.max_users !== undefined ||
      value.max_sms_per_month !== undefined ||
      value.city !== undefined ||
      value.teaching_type !== undefined ||
      value.student_label !== undefined ||
      value.director_title !== undefined ||
      value.can_edit_sms_template !== undefined ||
      value.can_export_data !== undefined ||
      value.active_school_year !== undefined ||
      value.logo_url !== undefined ||
      value.plan !== undefined ||
      value.status !== undefined,
    {
      message: 'At least one field must be provided',
    }
  );

export type ListTenantsQuery = z.infer<typeof listTenantsQuerySchema>;
export type CreateTenantBody = z.infer<typeof createTenantBodySchema>;
export type UpdateTenantBody = z.infer<typeof updateTenantBodySchema>;
export type CreateSchoolBody = z.infer<typeof createSchoolBodySchema>;
export type ListSchoolsQuery = z.infer<typeof listSchoolsQuerySchema>;
export type UpdateSchoolConfigBody = z.infer<typeof updateSchoolConfigBodySchema>;

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
  summary: {
    activeTenants: number;
    trialTenants: number;
    totalMrrFcfa: number;
    churnRiskTenants: number;
  };
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

export type SchoolListItem = {
  tenantId: string;
  name: string;
  plan: TenantPlan;
  status: TenantStatus;
  nbUsers: number;
  lastConnection: string | null;
  mrrFcfa: number;
};

export type SchoolListResult = {
  schools: SchoolListItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
};

export type SchoolDetailsResult = {
  tenantId: string;
  metadata: {
    name: string;
    subdomain: string;
    schemaName: string;
    plan: TenantPlan;
    status: TenantStatus;
    city: string | null;
    teachingType: TeachingType | null;
    maxAdminPositions: number;
    maxUsers: number;
    maxSmsPerMonth: number;
    studentLabel: string | null;
    directorTitle: string | null;
    canEditSmsTemplate: boolean;
    canExportData: boolean;
    activeSchoolYear: string | null;
    logoUrl: string | null;
    createdAt: string;
    updatedAt: string;
  };
  usageStats: {
    nbUsers: number;
    activeUsers7d: number;
    teachersCount: number;
    studentsCount: number;
    attendanceRecords30d: number;
    mrrFcfa: number;
    nextDueDate: string | null;
    lastConnection: string | null;
  };
  connectionHistory30d: Array<{
    date: string;
    uniqueUsers: number;
  }>;
};

export type AdminMetricsResult = {
  totalSchools: number;
  activeSchools: number;
  mrrTotalFcfa: number;
  dauLast7d: Array<{
    date: string;
    uniqueUsers: number;
  }>;
  schoolsByPlan: Array<{
    plan: TenantPlan;
    count: number;
  }>;
};

export type RevenueMetricsResult = Array<{
  month: string;
  mrr_fcfa: number;
  payments_count: number;
}>;

export type RevenueSummaryResult = {
  cards: {
    mrrTotalFcfa: number;
    arrFcfa: number;
    newSubscriptionsThisMonth: number;
    churnThisMonth: number;
  };
  monthly: Array<{
    month: string;
    mrr_fcfa: number;
    new_fcfa: number;
    churn_fcfa: number;
  }>;
  schools: Array<{
    tenantId: string;
    school: string;
    plan: TenantPlan;
    status: TenantStatus;
    amountPerMonth: number;
    lastDueDate: string | null;
    paymentMode: string | null;
  }>;
};

export type SmsTemplateType =
  | 'teacher_absent_director'
  | 'student_absent_parent'
  | 'payment_reminder'
  | 'teacher_late_director'
  | 'custom';

export type SmsTemplateItem = {
  id: string;
  tenantId: string | null;
  type: SmsTemplateType;
  messageTemplate: string;
  variables: string[];
  updatedAt: string;
};

export type SmsDashboardResult = {
  sentThisMonth: number;
  deliveryRate: number;
  activeSchools: number;
  estimatedCostFcfa: number;
  bySchool: Array<{
    tenantId: string;
    school: string;
    sent: number;
    quota: number;
    usedPct: number;
  }>;
  history: Array<{
    id: string;
    date: string;
    school: string;
    type: string;
    recipientMasked: string;
    status: string;
    message: string;
  }>;
};

export const smsTemplateTypeSchema = z.enum([
  'teacher_absent_director',
  'student_absent_parent',
  'payment_reminder',
  'teacher_late_director',
  'custom',
]);

export const updateSmsTemplateBodySchema = z.object({
  message_template: z.string().trim().min(5).max(500),
  variables: z.array(z.string().trim().min(1).max(60)).default([]),
});

export const maintenanceConfigSchema = z.object({
  maintenance_mode: z.boolean(),
  maintenance_message: z.string().trim().min(3).max(500),
});

export type UpdateSmsTemplateBody = z.infer<typeof updateSmsTemplateBodySchema>;
export type MaintenanceConfigBody = z.infer<typeof maintenanceConfigSchema>;
