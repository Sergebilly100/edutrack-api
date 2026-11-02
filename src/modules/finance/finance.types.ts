import { civilDateSchema } from '../../shared/utils/date-validation.js';
import { z } from 'zod';

export const paymentMethodSchema = z.enum(['mobile_money', 'cash', 'bank_transfer']);
export const subscriptionPeriodSchema = z.enum(['monthly', 'quarterly', 'semester', 'annual']);
export const mobileMoneyProviderSchema = z.enum(['orange_money', 'mtn_momo', 'moov_money', 'wave']);
const moneySchema = z.coerce.number().finite().nonnegative().max(999_999_999.99);
const positiveMoneySchema = moneySchema.refine((value) => value > 0, 'Amount must be greater than zero');
const uuidSchema = z.string().uuid();

export const paymentIdParamsSchema = z.object({ id: uuidSchema }).strict();
export const studentFinancialParamsSchema = z.object({ studentId: uuidSchema }).strict();
export const parentReceiptParamsSchema = z.object({ studentId: uuidSchema, id: uuidSchema }).strict();
export const tuitionPlanLevelParamsSchema = z.object({ levelId: uuidSchema }).strict();
export const subscriptionPlanParamsSchema = z.object({ id: uuidSchema }).strict();

export const schoolYearQuerySchema = z.object({ school_year_id: uuidSchema });
const cashJournalFiltersSchema = z.object({
  school_year_id: uuidSchema.optional(),
  from: civilDateSchema.optional(),
  to: civilDateSchema.optional(),
  class_id: uuidSchema.optional(),
  method: paymentMethodSchema.optional(),
}).refine((value) => !value.from || !value.to || value.from <= value.to, {
  message: 'La date de fin doit être postérieure ou égale à la date de début.', path: ['from'],
});

export const cashJournalQuerySchema = cashJournalFiltersSchema.extend({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const cashJournalExportQuerySchema = cashJournalFiltersSchema.extend({
  format: z.enum(['xlsx', 'pdf']),
});

export const paymentHistoryQuerySchema = z.object({
  school_year_id: uuidSchema,
  from: civilDateSchema.optional(),
  to: civilDateSchema.optional(),
  level_id: uuidSchema.optional(),
  class_id: uuidSchema.optional(),
  status: z.enum(['up_to_date', 'late']).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).refine((value) => !value.from || !value.to || value.from <= value.to, {
  message: 'La date de fin doit être postérieure ou égale à la date de début.', path: ['from'],
});

export const financialAlertLogsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export const paymentMappingProfileBodySchema = z.object({
  label: z.string().trim().min(1).max(255).optional(),
  fields: z.array(z.object({
    sourceColumnLabel: z.string().trim().min(1).max(255),
    targetField: z.enum(['matricule', 'montant', 'date', 'reference', 'method']),
    translations: z.array(z.object({
      sourceValue: z.string().trim().min(1).max(255),
      targetValue: paymentMethodSchema,
    }).strict()).default([]),
  }).strict()).length(5),
}).strict();
export const tuitionPlansQuerySchema = z.object({
  school_year_id: uuidSchema,
  level_id: uuidSchema.optional(),
});
export const agreementsRegisterQuerySchema = z.object({
  school_year_id: uuidSchema,
  kind: z.enum(['overrides', 'schedules']).default('overrides'),
  search: z.string().trim().max(120).optional(),
  student_id: uuidSchema.optional(),
  class_id: uuidSchema.optional(),
  level_id: uuidSchema.optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  status: z.enum(['active', 'withdrawn', 'replaced', 'reset', 'all']).default('all'),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const agreementDetailParamsSchema = z.object({
  kind: z.enum(['overrides', 'schedules']),
  agreementId: uuidSchema,
});

export const recordPaymentBodySchema = z.object({
  studentId: uuidSchema,
  schoolYearId: uuidSchema,
  amount: positiveMoneySchema,
  method: paymentMethodSchema,
  providerReference: z.string().trim().min(1).max(255).optional(),
  schoolReceiptReference: z.string().trim().min(1).max(255).optional(),
}).strict();

export const confirmEnrollmentPaymentBodySchema = z.object({
  amount: positiveMoneySchema,
  method: paymentMethodSchema,
  providerReference: z.string().trim().min(1).max(255).optional(),
  schoolReceiptReference: z.string().trim().min(1, 'Cash receipt reference is required').max(255),
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

export const withdrawTuitionOverrideBodySchema = z.object({
  schoolYearId: uuidSchema,
  reason: z.string().trim().min(1, 'Le motif du retrait est obligatoire').max(1_000),
  scheduleResolution: z.enum(['keep', 'reset', 'replace']).default('keep'),
  installments: z.array(z.object({ dueDate: civilDateSchema, amount: positiveMoneySchema }).strict()).optional(),
}).strict();

export const upsertTuitionPlanBodySchema = z.object({
  schoolYearId: uuidSchema,
  totalAmount: moneySchema,
  registrationAmount: moneySchema.default(0),
  currency: z.string().trim().min(3).max(10).default('FCFA'),
  scheduleSteps: z.array(z.object({
    dueDate: civilDateSchema,
    cumulativeAmountExpected: moneySchema,
  }).strict()).default([]),
}).strict();

export const upsertStudentTuitionScheduleBodySchema = z.object({
  schoolYearId: uuidSchema,
  reason: z.string().trim().min(1, 'Le motif de l’accord est obligatoire').max(1_000),
  installments: z.array(z.object({
    dueDate: civilDateSchema,
    amount: positiveMoneySchema,
  }).strict()).min(1),
}).strict();

export const resetStudentTuitionScheduleBodySchema = z.object({
  reason: z.string().trim().min(1, 'Le motif du retour au plan commun est obligatoire').max(1_000),
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

export const financialSummaryQuerySchema = z.object({
  school_year_id: uuidSchema.optional(),
});

export const recoveryQuerySchema = z.object({
  school_year_id: uuidSchema,
  level_id: uuidSchema.optional(),
  class_id: uuidSchema.optional(),
}).strict();

export const recoveryStudentsQuerySchema = recoveryQuerySchema.extend({
  class_id: uuidSchema,
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const upsertFinancialAlertRuleBodySchema = z.object({
  daysOffset: z.number().int().min(0).max(365),
  channel: z.enum(['sms', 'in_app', 'both']),
  isActive: z.boolean(),
});

export const financialAlertRuleTypeParamsSchema = z.object({
  type: z.enum(['preventive', 'late', 'severe_late']),
});

export const classFinancialStatusQuerySchema = z.object({
  class_id: uuidSchema,
  school_year_id: uuidSchema.optional(),
});
