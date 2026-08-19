import { z } from 'zod';

export const paymentMethodSchema = z.enum(['mobile_money', 'cash', 'bank_transfer']);
export const subscriptionPeriodSchema = z.enum(['monthly', 'quarterly', 'semester', 'annual']);
export const mobileMoneyProviderSchema = z.enum(['orange_money', 'mtn_momo', 'moov_money', 'wave']);
const moneySchema = z.coerce.number().finite().nonnegative().max(999_999_999.99);
const positiveMoneySchema = moneySchema.refine((value) => value > 0, 'Amount must be greater than zero');
const uuidSchema = z.string().uuid();

export const paymentIdParamsSchema = z.object({ id: uuidSchema }).strict();
export const studentFinancialParamsSchema = z.object({ studentId: uuidSchema }).strict();
export const tuitionPlanClassParamsSchema = z.object({ classId: uuidSchema }).strict();
export const subscriptionPlanParamsSchema = z.object({ id: uuidSchema }).strict();

export const schoolYearQuerySchema = z.object({ school_year_id: uuidSchema });
export const tuitionPlansQuerySchema = z.object({ class_id: uuidSchema.optional() });

export const recordPaymentBodySchema = z.object({
  studentId: uuidSchema,
  schoolYearId: uuidSchema,
  amount: positiveMoneySchema,
  method: paymentMethodSchema,
  providerReference: z.string().trim().min(1).max(255).optional(),
  schoolReceiptReference: z.string().trim().min(1).max(255).optional(),
}).strict();

export const confirmEnrollmentPaymentBodySchema = z.object({
  method: paymentMethodSchema,
  providerReference: z.string().trim().min(1).max(255).optional(),
  schoolReceiptReference: z.string().trim().min(1).max(255).optional(),
}).strict();

export const cancelPaymentBodySchema = z.object({
  reason: z.string().trim().min(1, 'Cancellation reason is required').max(1_000),
}).strict();

export const grantTuitionOverrideBodySchema = z.object({
  studentId: uuidSchema,
  schoolYearId: uuidSchema,
  overrideTotalAmount: moneySchema.optional(),
  discountAmount: moneySchema.optional(),
  reason: z.string().trim().min(1).max(1_000),
}).strict().superRefine((value, context) => {
  const count = Number(value.overrideTotalAmount !== undefined) + Number(value.discountAmount !== undefined);
  if (count !== 1) {
    context.addIssue({
      code: 'custom',
      message: 'Exactly one of overrideTotalAmount or discountAmount is required',
    });
  }
});

export const upsertTuitionPlanBodySchema = z.object({
  totalAmount: moneySchema,
  currency: z.string().trim().min(3).max(10).default('FCFA'),
  scheduleSteps: z.array(z.object({
    dueDate: z.iso.date(),
    cumulativeAmountExpected: moneySchema,
  }).strict()).default([]),
}).strict();

export const upsertProviderSettingBodySchema = z.object({
  provider: mobileMoneyProviderSchema,
  merchantNumber: z.string().trim().min(1).max(100),
  apiCredentials: z.record(z.string(), z.unknown()),
  isActive: z.boolean(),
}).strict();

export const createSubscriptionPlanBodySchema = z.object({
  amount: moneySchema,
  period: subscriptionPeriodSchema,
  label: z.string().trim().min(1).max(255),
  isMandatoryAtEnrollment: z.boolean().default(false),
  imposedDuration: subscriptionPeriodSchema.nullable().optional(),
  showOnReceiptAsSeparateLine: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  if (value.isMandatoryAtEnrollment !== Boolean(value.imposedDuration)) {
    context.addIssue({
      code: 'custom',
      message: 'imposedDuration is required only for a mandatory enrollment plan',
    });
  }
});

export const updateSubscriptionPlanBodySchema = createSubscriptionPlanBodySchema;

export type PaymentMethod = z.infer<typeof paymentMethodSchema>;
export type MobileMoneyProvider = z.infer<typeof mobileMoneyProviderSchema>;
export type UpsertTuitionPlanInput = z.infer<typeof upsertTuitionPlanBodySchema>;
export type SubscriptionPlanInput = z.infer<typeof createSubscriptionPlanBodySchema>;

