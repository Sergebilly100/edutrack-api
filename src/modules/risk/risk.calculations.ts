export type RiskRuleValues = {
  thresholdValue: number;
  periodDays: number;
  isActive: boolean;
};

export const DEFAULT_RISK_RULES = {
  studentAbsences: { thresholdValue: 3, periodDays: 30, isActive: true },
  studentGrades: { thresholdValue: 2, periodDays: 0, isActive: true },
  studentPayments: { thresholdValue: 1, periodDays: 0, isActive: true },
  teacherAbsences: { thresholdValue: 3, periodDays: 30, isActive: true },
} as const satisfies Record<string, RiskRuleValues>;

export const resolveRiskRule = (
  rule: Partial<RiskRuleValues> | undefined,
  defaults: RiskRuleValues
): RiskRuleValues => ({
  thresholdValue: rule?.thresholdValue ?? defaults.thresholdValue,
  periodDays: rule?.periodDays ?? defaults.periodDays,
  isActive: rule?.isActive ?? defaults.isActive,
});

/** Une fenêtre glissante ne peut pas être nulle, sinon on restaure sa valeur sûre par défaut. */
export const resolveRollingRiskRule = (
  rule: Partial<RiskRuleValues> | undefined,
  defaults: RiskRuleValues
): RiskRuleValues => ({
  ...resolveRiskRule(rule, defaults),
  periodDays: rule?.periodDays && rule.periodDays > 0 ? rule.periodDays : defaults.periodDays,
});

export const isAbsenceRisk = (
  absenceCount: number,
  threshold: number,
  isActive: boolean
): boolean => isActive && absenceCount >= threshold;

export const isGradeDropRisk = (
  drop: number | null,
  threshold: number,
  isActive: boolean
): boolean => isActive && drop !== null && drop >= threshold;

export const isPaymentRisk = (paymentLate: boolean, isActive: boolean): boolean =>
  isActive && paymentLate;
