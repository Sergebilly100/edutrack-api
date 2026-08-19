import { sql } from 'drizzle-orm';
import {
  check,
  boolean,
  date,
  inet,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  unique,
  timestamp,
  uuid,
  varchar,
  serial,
  bigint,
} from 'drizzle-orm/pg-core';

export const tenantPlanEnum = pgEnum('tenant_plan', [
  'essential',
  'pro',
  'establishment',
]);

export const tenantStatusEnum = pgEnum('tenant_status', [
  'trial',
  'active',
  'suspended',
  'cancelled',
]);

export const teachingTypeEnum = pgEnum('teaching_type', [
  'primaire',
  'secondaire',
  'superieur',
  'mixte',
]);

export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'active',
  'past_due',
  'cancelled',
]);

export const billingCycleEnum = pgEnum('billing_cycle', ['monthly', 'annual']);

export const paymentProviderEnum = pgEnum('payment_provider', [
  'mtn_momo',
  'orange_money',
  'manual',
]);

export const paymentStatusEnum = pgEnum('payment_status', [
  'pending',
  'success',
  'failed',
]);

export const tenants = pgTable('tenants', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  subdomain: varchar('subdomain', { length: 100 }).notNull().unique(),
  schemaName: varchar('schema_name', { length: 100 }).notNull().unique(),
  plan: tenantPlanEnum('plan').notNull().default('essential'),
  status: tenantStatusEnum('status').notNull().default('trial'),
  city: varchar('city', { length: 120 }),
  teachingType: teachingTypeEnum('teaching_type'),
  maxAdminPositions: integer('max_admin_positions').notNull().default(5),
  maxUsers: integer('max_users').notNull().default(10),
  onboardingCompleted: boolean('onboarding_completed').notNull().default(false),
  trialEndsAt: timestamp('trial_ends_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  studentLabel: varchar('student_label', { length: 120 }).default('Élève'),
  directorTitle: varchar('director_title', { length: 120 }).default('Directeur'),
  maxSmsPerMonth: integer('max_sms_per_month').default(2000),
  canEditSmsTemplate: boolean('can_edit_sms_template').default(false),
  canExportData: boolean('can_export_data').default(true),
  allowTeacherQrSkip: boolean('allow_teacher_qr_skip').notNull().default(false),
  logoUrl: text('logo_url'),
  activeSchoolYear: varchar('active_school_year', { length: 20 }),
});

export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  status: subscriptionStatusEnum('status').notNull(),
  mrrFcfa: integer('mrr_fcfa').notNull().default(0),
  billingCycle: billingCycleEnum('billing_cycle').notNull().default('monthly'),
  currentPeriodStart: timestamp('current_period_start', {
    withTimezone: true,
    mode: 'date',
  }).notNull(),
  currentPeriodEnd: timestamp('current_period_end', {
    withTimezone: true,
    mode: 'date',
  }).notNull(),
  momoPhone: varchar('momo_phone', { length: 20 }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

export const paymentEvents = pgTable('payment_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  subscriptionId: uuid('subscription_id')
    .notNull()
    .references(() => subscriptions.id),
  amountFcfa: integer('amount_fcfa').notNull(),
  provider: paymentProviderEnum('provider').notNull(),
  providerRef: varchar('provider_ref', { length: 255 }),
  status: paymentStatusEnum('status').notNull(),
  periodFrom: date('period_from'),
  periodTo: date('period_to'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

export const adminAccessLog = pgTable('admin_access_log', {
  id: uuid('id').defaultRandom().primaryKey(),
  adminId: uuid('admin_id').notNull(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  action: varchar('action', { length: 100 }).notNull(),
  ipAddress: inet('ip_address'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

export const smsTemplates = pgTable('sms_templates', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
  type: varchar('type', { length: 50 }).notNull(),
  messageTemplate: text('message_template').notNull(),
  variables: text('variables').array().notNull().default([]),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const appSettings = pgTable('app_settings', {
  id: uuid('id').defaultRandom().primaryKey(),
  maintenanceMode: boolean('maintenance_mode').notNull().default(false),
  maintenanceMessage: text('maintenance_message').notNull().default('Mise à jour en cours'),
  smsProvider: varchar('sms_provider', { length: 50 }).notNull().default('mock'),
  smsApiBaseUrl: varchar('sms_api_base_url', { length: 255 }),
  smsApiKey: text('sms_api_key'),
  smsApiKeyLast4: varchar('sms_api_key_last4', { length: 4 }),
  smsApiKeyUpdatedAt: timestamp('sms_api_key_updated_at', { withTimezone: true, mode: 'date' }),
  smsSenderId: varchar('sms_sender_id', { length: 20 }).notNull().default('IvoirEdu'),
  smsFallbackSenderId: varchar('sms_fallback_sender_id', { length: 20 }),
  smsDefaultCountryCode: varchar('sms_default_country_code', { length: 8 }).notNull().default('+225'),
  smsAlertQuotaThresholdPct: integer('sms_alert_quota_threshold_pct').notNull().default(80),
  smsAlertFailureThresholdCount: integer('sms_alert_failure_threshold_count').notNull().default(5),
  smsAlertEmail: varchar('sms_alert_email', { length: 255 }),
  smsMaintenanceMode: boolean('sms_maintenance_mode').notNull().default(false),
  smsMaintenanceMessage: text('sms_maintenance_message').notNull().default('Service SMS en maintenance'),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const schoolSmsFeatures = pgTable(
  'school_sms_features',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    isEnabled: boolean('is_enabled').notNull().default(false),
    monetizeParentAlerts: boolean('monetize_parent_alerts').notNull().default(false),
    commissionPct: numeric('commission_pct', { precision: 5, scale: 2 }).notNull().default('0'),
    smsCapPerStudent: integer('sms_cap_per_student').notNull().default(60),
    smsUnitPriceFcfa: integer('sms_unit_price_fcfa'),
    useRealHours: boolean('use_real_hours').notNull().default(false),
    geoCheckEnabled: boolean('geo_check_enabled').notNull().default(false),
    checkoutToleranceMinutes: integer('checkout_tolerance_minutes').notNull().default(5),
    requireEndScan: boolean("require_end_scan").default(false).notNull(),
    studentAssignmentEnabled: boolean('student_assignment_enabled').notNull().default(false),
    activatedAt: timestamp('activated_at', { withTimezone: true, mode: 'date' }),
    activatedBy: uuid('activated_by'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    schoolSmsFeaturesTenantUnique: unique('school_sms_features_tenant_unique').on(table.tenantId),
    schoolSmsFeaturesCommissionPctRangeCheck: check(
      'school_sms_features_commission_pct_range_check',
      sql`${table.commissionPct} >= 0 AND ${table.commissionPct} <= 100`
    ),
    schoolSmsFeaturesSmsCapNonNegativeCheck: check(
      'school_sms_features_sms_cap_non_negative_check',
      sql`${table.smsCapPerStudent} >= 0`
    ),
    schoolSmsFeaturesCheckoutToleranceRangeCheck: check(
      'school_sms_features_checkout_tolerance_range_check',
      sql`${table.checkoutToleranceMinutes} >= 0 AND ${table.checkoutToleranceMinutes} <= 30`
    ),
  })
);

export const auditFinancialEvents = pgTable('audit_financial_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  actorId: uuid('actor_id'),
  actorRole: varchar('actor_role', { length: 50 }).notNull(),
  action: varchar('action', { length: 100 }).notNull(),
  idempotencyKey: uuid('idempotency_key'),
  payloadBefore: jsonb('payload_before'),
  payloadAfter: jsonb('payload_after').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const edutrackCommissionRecords = pgTable(
  'edutrack_commission_records',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    periodMonth: date('period_month', { mode: 'string' }).notNull(),
    totalSubscriptionsFcfa: integer('total_subscriptions_fcfa').notNull().default(0),
    commissionPct: numeric('commission_pct', { precision: 5, scale: 2 }).notNull(),
    commissionDueFcfa: integer('commission_due_fcfa').notNull().default(0),
    commissionPaidFcfa: integer('commission_paid_fcfa').notNull().default(0),
    lastPaymentAt: timestamp('last_payment_at', { withTimezone: true, mode: 'date' }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => ({
    edutrackCommissionTenantMonthUnique: unique('edutrack_commission_records_tenant_month_unique').on(
      table.tenantId,
      table.periodMonth
    ),
    edutrackCommissionTotalNonNegativeCheck: check(
      'edutrack_commission_records_total_non_negative_check',
      sql`${table.totalSubscriptionsFcfa} >= 0`
    ),
    edutrackCommissionDueNonNegativeCheck: check(
      'edutrack_commission_records_due_non_negative_check',
      sql`${table.commissionDueFcfa} >= 0`
    ),
    edutrackCommissionPaidNonNegativeCheck: check(
      'edutrack_commission_records_paid_non_negative_check',
      sql`${table.commissionPaidFcfa} >= 0`
    ),
  })
);

export const smsAdminAuditLog = pgTable("sms_admin_audit_log", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  adminId: uuid("admin_id"),
  action: varchar({ length: 80 }).notNull(),
  details: jsonb().default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const planCatalog = pgTable("plan_catalog", {
  plan: tenantPlanEnum().primaryKey().notNull(),
  monthlyPriceFcfa: integer("monthly_price_fcfa").default(0).notNull(),
  annualPriceFcfa: integer("annual_price_fcfa").default(0).notNull(),
  defaultBillingCycle: billingCycleEnum("default_billing_cycle").default('monthly').notNull(),
  maxUsers: integer("max_users").default(10).notNull(),
  maxAdminPositions: integer("max_admin_positions").default(5).notNull(),
  maxSmsPerMonth: integer("max_sms_per_month").default(2000).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const drizzleMigrations = pgTable("drizzle_migrations", {
  id: serial().primaryKey().notNull(),
  hash: text().notNull(),
  // You can use { mode: "bigint" } if numbers are exceeding js number limitations
  createdAt: bigint("created_at", { mode: "number" }),
});
