import { z } from 'zod';

export type SubscriptionStatus = 'active' | 'expired' | 'cancelled';
export type PaymentMethod = 'cash' | 'momo_mtn' | 'momo_orange';
export type NotificationChannel = 'sms' | 'email';

export type CanSendResult =
  | { allowed: true; subscriptionId: string; parentPhone: string | null; parentEmail: string | null }
  | {
      allowed: false;
      reason: 'no_active_subscription' | 'feature_disabled' | 'cap_reached' | 'subscription_expired';
    };

export const paymentMethodSchema = z.enum(['cash', 'momo_mtn', 'momo_orange']);
export const durationSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export const ciPhoneSchema = z.string().regex(/^225\d{10}$/);

export const listParentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().min(1).max(255).optional(),
  status: z.enum(['active', 'expired', 'cancelled']).optional(),
});

export const createParentSubscriptionBodySchema = z.object({
  full_name: z.string().trim().min(2).max(255),
  phone: ciPhoneSchema,
  email: z.string().trim().toLowerCase().email().optional(),
  student_ids: z.array(z.string().uuid()).min(1),
  duration_months: durationSchema,
  payment_method: paymentMethodSchema,
  paid_now: z.boolean().default(true),
});

export const renewParentSubscriptionBodySchema = z.object({
  duration_months: durationSchema,
  payment_method: paymentMethodSchema,
  paid_now: z.boolean().default(true),
});

export const resetPasswordParamsSchema = z.object({
  parentId: z.string().uuid(),
});

export const parentIdParamsSchema = z.object({
  parentId: z.string().uuid(),
});

export const cancelSubscriptionParamsSchema = z.object({
  parentId: z.string().uuid(),
  subscriptionId: z.string().uuid(),
});

export const cancelSubscriptionBodySchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const revenueSummaryQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});

export const revenueHistoryQuerySchema = z.object({
  months: z.coerce.number().int().min(1).max(24).default(12),
});

export const commissionRecordPaymentBodySchema = z.object({
  period_month: z.string().regex(/^\d{4}-\d{2}$/),
  amount_fcfa: z.coerce.number().int().positive(),
  notes: z.string().trim().max(500).optional(),
  idempotency_key: z.string().uuid(),
});

export const updateSmsPriceBodySchema = z.object({
  sms_unit_price_fcfa: z.coerce.number().int().min(1).max(50000),
});

export type ListParentsQuery = z.infer<typeof listParentsQuerySchema>;
export type CreateParentSubscriptionBody = z.infer<typeof createParentSubscriptionBodySchema>;
export type RenewParentSubscriptionBody = z.infer<typeof renewParentSubscriptionBodySchema>;
