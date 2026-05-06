import { z } from 'zod';

const TENANT_PLAN_VALUES = ['essential', 'pro', 'establishment'] as const;
const TENANT_STATUS_VALUES = ['trial', 'active', 'suspended', 'cancelled'] as const;
const TEACHING_TYPE_VALUES = ['primaire', 'secondaire', 'superieur', 'mixte'] as const;
const SMS_PROVIDER_VALUES = ['mock', 'infobip', 'africas_talking', 'twilio', 'orange_api', 'custom'] as const;

export type TenantPlan = (typeof TENANT_PLAN_VALUES)[number];
export type TenantStatus = (typeof TENANT_STATUS_VALUES)[number];
export type TeachingType = (typeof TEACHING_TYPE_VALUES)[number];
export type SmsProvider = (typeof SMS_PROVIDER_VALUES)[number];

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
  trial_days: z.coerce.number().int().min(0).max(365).default(0),
  active_school_year: z
    .string()
    .trim()
    .regex(/^\d{2}\/\d{4} - \d{2}\/\d{4}$/, {
      message: 'Format attendu : MM/YYYY - MM/YYYY (ex: 09/2025 - 06/2026)',
    }),
  plan: z.enum(TENANT_PLAN_VALUES).default('essential'),
  monetizeParentAlerts: z.boolean().default(false),
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

export const smsFeatureActivateBodySchema = z.object({
  commission_pct: z.coerce.number().min(0).max(100),
});

export const smsFeatureConfigBodySchema = z
  .object({
    commission_pct: z.coerce.number().min(0).max(100).optional(),
    sms_cap_per_student: z.coerce.number().int().min(0).max(10000).optional(),
    monetizeParentAlerts: z.boolean().optional(),
    useRealHours: z.boolean().optional(),
    geoCheckEnabled: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.commission_pct !== undefined ||
      value.sms_cap_per_student !== undefined ||
      value.monetizeParentAlerts !== undefined ||
      value.useRealHours !== undefined ||
      value.geoCheckEnabled !== undefined,
    {
      message: 'At least one field must be provided',
    }
  );

export const smsFeatureMonthQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});

export const smsFeatureCommissionPaymentBodySchema = z.object({
  period_month: z.string().regex(/^\d{4}-\d{2}$/),
  amount_fcfa: z.coerce.number().int().min(1),
  payment_method: z.enum(['cash', 'momo_mtn', 'momo_orange', 'bank_transfer']).optional(),
  notes: z.string().trim().max(1000).optional(),
  idempotency_key: z.string().uuid(),
});

export const listSchoolsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  plan: z.enum(TENANT_PLAN_VALUES).optional(),
  status: z.enum(TENANT_STATUS_VALUES).optional(),
  search: z.string().trim().max(255).optional(),
});

export const updateSchoolConfigBodySchema = z
  .object({
    name: z.string().trim().min(2).max(255).optional(),
    max_admin_positions: z.coerce.number().int().min(1).max(50).optional(),
    max_users: z.coerce.number().int().min(1).max(500).optional(),
    max_sms_per_month: z.coerce.number().int().min(0).max(200000).optional(),
    city: z.string().trim().min(1).max(120).optional(),
    teaching_type: z.enum(TEACHING_TYPE_VALUES).optional(),
    student_label: z.string().trim().min(1).max(120).optional(),
    director_title: z.string().trim().min(1).max(120).optional(),
    can_edit_sms_template: z.boolean().optional(),
    can_export_data: z.boolean().optional(),
    active_school_year: z
      .string()
      .trim()
      .regex(/^\d{2}\/\d{4} - \d{2}\/\d{4}$/, {
        message: 'Format attendu : MM/YYYY - MM/YYYY (ex: 09/2025 - 06/2026)',
      })
      .optional(),
    logo_url: z.string().trim().max(2_000_000).nullable().optional(),
    plan: z.enum(TENANT_PLAN_VALUES).optional(),
    status: z.enum(TENANT_STATUS_VALUES).optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
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
  city: string | null;
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
    subscriptionStartedAt: string | null;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    billingCycle: 'monthly' | 'annual' | null;
    paidCurrentPeriodFcfa: number;
    remainingCurrentPeriodFcfa: number;
    nextDueDate: string | null;
    lastPaymentReminderAt: string | null;
    lastConnection: string | null;
  };
  connectionHistory30d: Array<{
    date: string;
    uniqueUsers: number;
  }>;
};

export type SchoolPaymentReminderResult = {
  sentAt: string;
  recipientPhone: string;
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
    tenantId: string;
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
  message_template: z.string().trim().min(5).max(2000),
  variables: z
    .array(z.string().trim().max(60))
    .default([])
    .transform((items) => Array.from(new Set(items.filter((item) => item.length > 0)))),
});

export const maintenanceConfigSchema = z.object({
  maintenance_mode: z.boolean(),
  maintenance_message: z.string().trim().min(3).max(500),
});

export const updateSmsPlatformConfigBodySchema = z
  .object({
    provider: z.enum(SMS_PROVIDER_VALUES).optional(),
    api_base_url: z.string().trim().url().max(255).optional(),
    api_key: z.string().trim().min(8).max(1000).optional(),
    sender_id: z.string().trim().min(3).max(20).optional(),
    fallback_sender_id: z.string().trim().max(20).nullable().optional(),
    default_country_code: z.string().trim().regex(/^\+\d{1,4}$/).optional(),
    alert_quota_threshold_pct: z.coerce.number().int().min(1).max(100).optional(),
    alert_failure_threshold_count: z.coerce.number().int().min(1).max(5000).optional(),
    alert_email: z.string().trim().email().max(255).nullable().optional(),
    sms_maintenance_mode: z.boolean().optional(),
    sms_maintenance_message: z.string().trim().min(3).max(500).optional(),
  })
  .refine(
    (value) =>
      value.provider !== undefined ||
      value.api_base_url !== undefined ||
      value.api_key !== undefined ||
      value.sender_id !== undefined ||
      value.fallback_sender_id !== undefined ||
      value.default_country_code !== undefined ||
      value.alert_quota_threshold_pct !== undefined ||
      value.alert_failure_threshold_count !== undefined ||
      value.alert_email !== undefined ||
      value.sms_maintenance_mode !== undefined ||
      value.sms_maintenance_message !== undefined,
    {
      message: 'At least one field must be provided',
    }
  );

export const smsPlatformAuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const planParamsSchema = z.object({
  plan: z.enum(TENANT_PLAN_VALUES),
});

export const updatePlanCatalogBodySchema = z
  .object({
    monthly_price_fcfa: z.coerce.number().int().min(0).max(100_000_000).optional(),
    max_users: z.coerce.number().int().min(1).max(5000).optional(),
    max_admin_positions: z.coerce.number().int().min(1).max(500).optional(),
  })
  .refine(
    (value) =>
      value.monthly_price_fcfa !== undefined ||
      value.max_users !== undefined ||
      value.max_admin_positions !== undefined,
    {
      message: 'At least one field must be provided',
    }
  );

export type UpdateSmsTemplateBody = z.infer<typeof updateSmsTemplateBodySchema>;
export type MaintenanceConfigBody = z.infer<typeof maintenanceConfigSchema>;
export type UpdateSmsPlatformConfigBody = z.infer<typeof updateSmsPlatformConfigBodySchema>;
export type SmsPlatformAuditQuery = z.infer<typeof smsPlatformAuditQuerySchema>;
export type UpdatePlanCatalogBody = z.infer<typeof updatePlanCatalogBodySchema>;

export type SchoolUserItem = {
  id: string;
  role: 'director' | 'staff' | 'teacher';
  name: string;
  phone: string | null;
  email: string | null;
  username: string | null;
  positions: string[];
  lastLoginAt: string | null;
  isActive: boolean;
};

export type SchoolUsersResult = {
  director: SchoolUserItem | null;
  staff: SchoolUserItem[];
  teachers: SchoolUserItem[];
};

export type PlanCatalogItem = {
  plan: TenantPlan;
  monthlyPriceFcfa: number;
  maxUsers: number;
  maxAdminPositions: number;
  updatedAt: string;
};

export type SmsPlatformConfigResult = {
  provider: SmsProvider;
  hasApiKey: boolean;
  apiBaseUrl: string | null;
  apiKeyLast4: string | null;
  apiKeyUpdatedAt: string | null;
  senderId: string;
  fallbackSenderId: string | null;
  defaultCountryCode: string;
  alertQuotaThresholdPct: number;
  alertFailureThresholdCount: number;
  alertEmail: string | null;
  smsMaintenanceMode: boolean;
  smsMaintenanceMessage: string;
  updatedAt: string;
};

export type SmsPlatformAuditItem = {
  id: string;
  action: string;
  adminId: string | null;
  createdAt: string;
  details: Record<string, unknown>;
};
