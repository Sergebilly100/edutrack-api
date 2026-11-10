import { civilMonthSchema } from '../../shared/utils/date-validation.js';
import { z } from 'zod';

export const riskRuleUpsertSchema = z.object({
  thresholdValue: z.number().finite().min(0),
  periodDays: z.number().int().min(0).max(365).default(30),
  isActive: z.boolean(),
  lateMinutes: z.number().int().min(0).nullable().optional(),
});

export const teacherLatenessRuleUpsertSchema = riskRuleUpsertSchema.extend({
  thresholdValue: z.number().int().min(1),
  periodDays: z.literal(30).default(30),
  lateMinutes: z.number().int().min(0),
});

const riskLevelSchema = z.enum(['attention', 'warning', 'critical']);
const queryBooleanSchema = z.preprocess(
  (value) => value === 'true' || value === true ? true : value === 'false' || value === false ? false : value,
  z.boolean().default(false)
);

export const riskStudentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  schoolYearId: z.string().uuid().optional(),
  gradingPeriodId: z.string().uuid().optional(),
  schoolLevelId: z.string().uuid().optional(),
  classId: z.string().uuid().optional(),
  category: z.enum(['absences', 'grades', 'payments']).optional(),
  riskLevel: riskLevelSchema.optional(),
  atRisk: queryBooleanSchema,
});

export const riskTeachersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  month: civilMonthSchema.optional(),
  signal: z.enum(['absences', 'lateness']).optional(),
  atRisk: queryBooleanSchema,
});

export type RiskLevel = 'none' | 'attention' | 'warning' | 'critical';
export type RiskSubjectType = 'student' | 'teacher';
export type RiskStudentsQuery = z.infer<typeof riskStudentsQuerySchema>;
export type RiskTeachersQuery = z.infer<typeof riskTeachersQuerySchema>;
