import {
  boolean,
  inet,
  integer,
  pgEnum,
  pgTable,
  timestamp,
  uuid,
  varchar,
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
  onboardingCompleted: boolean('onboarding_completed').notNull().default(false),
  trialEndsAt: timestamp('trial_ends_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
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
