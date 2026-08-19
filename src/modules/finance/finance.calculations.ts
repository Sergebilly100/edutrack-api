export type SubscriptionPeriod = 'monthly' | 'quarterly' | 'semester' | 'annual';
export type FinancialStanding = 'up_to_date' | 'late';
export type PaymentStatus = 'confirmed' | 'waived_by_school' | 'cancelled';

const PERIOD_MONTHS: Record<SubscriptionPeriod, number> = {
  monthly: 1,
  quarterly: 3,
  semester: 6,
  annual: 12,
};

const roundMoney = (value: number): number => Math.round(value * 100) / 100;

export const prorateSubscriptionAmount = (
  amount: number,
  period: SubscriptionPeriod,
  imposedDuration: SubscriptionPeriod
): number => roundMoney(amount * PERIOD_MONTHS[imposedDuration] / PERIOD_MONTHS[period]);

export const calculateStudentTotalDue = (input: {
  planTotalAmount: number;
  overrideTotalAmount?: number | null;
  discountAmount?: number | null;
  mandatorySubscriptionAmounts?: readonly number[];
}): number => {
  const tuitionAmount = input.overrideTotalAmount !== null && input.overrideTotalAmount !== undefined
    ? input.overrideTotalAmount
    : input.planTotalAmount - (input.discountAmount ?? 0);
  const subscriptions = (input.mandatorySubscriptionAmounts ?? []).reduce(
    (sum, amount) => sum + amount,
    0
  );
  return roundMoney(Math.max(0, tuitionAmount) + subscriptions);
};

export const resolveFinancialStanding = (
  confirmedPaid: number,
  cumulativeExpectedAtDate: number
): FinancialStanding => confirmedPaid >= cumulativeExpectedAtDate ? 'up_to_date' : 'late';

export const canCancelPayment = (status: PaymentStatus): boolean =>
  status === 'confirmed' || status === 'waived_by_school';

