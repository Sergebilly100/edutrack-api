import { z } from 'zod';

export const riskRuleUpsertSchema = z.object({
  thresholdValue: z.number().finite().min(0),
  periodDays: z.number().int().min(0).max(365).default(30),
  isActive: z.boolean(),
});

export type RiskLevel = 'none' | 'attention' | 'warning' | 'critical';
export type RiskSubjectType = 'student' | 'teacher';
