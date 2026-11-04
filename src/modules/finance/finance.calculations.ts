export type FinancialStanding = 'up_to_date' | 'late';
export type FinancialCacheStatus = FinancialStanding;
export type PaymentStatus = 'confirmed' | 'cancelled';

export type CumulativeScheduleStep = {
  dueDate: string;
  cumulativeAmountExpected: number;
};

export type TuitionInstallment = {
  dueDate: string;
  amount: number;
};

export const toCumulativeScheduleSteps = (
  installments: readonly TuitionInstallment[]
): CumulativeScheduleStep[] => {
  let cumulativeAmountExpected = 0;
  return installments.map((installment) => {
    cumulativeAmountExpected = roundMoney(cumulativeAmountExpected + installment.amount);
    return { dueDate: installment.dueDate, cumulativeAmountExpected };
  });
};

export const amountFromCumulativeStep = (
  current: CumulativeScheduleStep,
  previous?: CumulativeScheduleStep
): number => roundMoney(current.cumulativeAmountExpected - (previous?.cumulativeAmountExpected ?? 0));

export const isValidCumulativeSchedule = (
  scheduleSteps: readonly CumulativeScheduleStep[],
  totalAmount: number
): boolean => {
  if (scheduleSteps.length === 0) return false;

  let previousDate = '';
  let previousAmount = -1;
  for (const step of scheduleSteps) {
    if (!Number.isFinite(step.cumulativeAmountExpected)
      || step.cumulativeAmountExpected <= 0
      || (
      step.dueDate <= previousDate
      || step.cumulativeAmountExpected <= previousAmount
      || step.cumulativeAmountExpected > totalAmount
      )) {
      return false;
    }
    previousDate = step.dueDate;
    previousAmount = step.cumulativeAmountExpected;
  }
  return previousAmount === totalAmount;
};

const roundMoney = (value: number): number => Math.round(value * 100) / 100;

export const calculateAnnualFinancialBalances = (input: {
  annualTotalDue: number;
  collected: number;
  overdueToDate: number;
}): { annualRemaining: number; upcomingDue: number } => {
  const annualRemaining = roundMoney(input.annualTotalDue - input.collected);
  return {
    annualRemaining,
    upcomingDue: roundMoney(annualRemaining - input.overdueToDate),
  };
};

export const calculateStudentTotalDue = (input: {
  planTotalAmount: number;
  overrideTotalAmount?: number | null;
  discountAmount?: number | null;
}): number => {
  const tuitionAmount = input.overrideTotalAmount !== null && input.overrideTotalAmount !== undefined
    ? input.overrideTotalAmount
    : input.planTotalAmount - (input.discountAmount ?? 0);
  return roundMoney(Math.max(0, tuitionAmount));
};

/**
 * Référence unique du statut individuel. Les remises de l'école couvrent la
 * dette de l'élève, mais restent séparées des paiements effectivement encaissés
 * pour les indicateurs de recouvrement.
 */
export const resolveIndividualFinancialStatus = (input: {
  totalDue: number;
  cumulativeExpectedAtDate: number;
  confirmedPaid: number;
}) => {
  const coveredAmount = roundMoney(input.confirmedPaid);
  const standing: FinancialStanding = coveredAmount >= input.cumulativeExpectedAtDate
    ? 'up_to_date'
    : 'late';

  return {
    coveredAmount,
    remainingDue: Math.max(0, roundMoney(input.totalDue - coveredAmount)),
    standing,
    cacheStatus: standing,
  };
};

/** @deprecated Use resolveIndividualFinancialStatus for individual status. */
export const resolveFinancialStanding = (
  confirmedPaid: number,
  cumulativeExpectedAtDate: number
): FinancialStanding => resolveIndividualFinancialStatus({
  totalDue: cumulativeExpectedAtDate,
  cumulativeExpectedAtDate,
  confirmedPaid,
}).standing;

export const canCancelPayment = (status: PaymentStatus): boolean =>
  status === 'confirmed';
