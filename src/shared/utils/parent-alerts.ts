export type ImposedParentAlertsDuration = 1 | 3 | 6 | 12;

export const calculateImposedParentAlertsAmount = (
  monthlyPriceFcfa: number,
  durationMonths: ImposedParentAlertsDuration
): number => {
  if (!Number.isInteger(monthlyPriceFcfa) || monthlyPriceFcfa <= 0) {
    throw new RangeError('Monthly parent alerts price must be a positive integer');
  }
  return monthlyPriceFcfa * durationMonths;
};

export const calculateEnrollmentMinimum = (
  firstTuitionInstallment: number,
  parentAlertsAmountFcfa = 0
): number => {
  if (!Number.isFinite(firstTuitionInstallment) || firstTuitionInstallment < 0
    || !Number.isFinite(parentAlertsAmountFcfa) || parentAlertsAmountFcfa < 0) {
    throw new RangeError('Enrollment payment amounts must be finite and non-negative');
  }
  return Math.round((firstTuitionInstallment + parentAlertsAmountFcfa) * 100) / 100;
};

export const allocateEnrollmentPayment = (input: {
  amount: number;
  remainingTuition: number;
  parentAlertsAmountFcfa: number;
}): { totalAmount: number; tuitionAmount: number; parentAlertsAmount: number } => {
  const { amount, remainingTuition, parentAlertsAmountFcfa } = input;
  if (!Number.isFinite(amount) || amount <= 0
    || !Number.isFinite(remainingTuition) || remainingTuition < 0
    || !Number.isFinite(parentAlertsAmountFcfa) || parentAlertsAmountFcfa < 0) {
    throw new RangeError('Enrollment payment allocation values are invalid');
  }
  if (amount < parentAlertsAmountFcfa || amount > remainingTuition + parentAlertsAmountFcfa) {
    throw new RangeError('Enrollment payment amount cannot be allocated to the configured balances');
  }
  const totalAmount = Math.round(amount * 100) / 100;
  const tuitionAmount = Math.round(Math.min(amount - parentAlertsAmountFcfa, remainingTuition) * 100) / 100;
  const parentAlertsAmount = Math.round(parentAlertsAmountFcfa * 100) / 100;
  return { totalAmount, tuitionAmount, parentAlertsAmount };
};

export const resolveParentAlertsSubscriptionStatus = (
  status: 'active' | 'expired' | 'cancelled',
  endsAt: string,
  today: string
): 'active' | 'expired' | 'cancelled' => {
  if (status === 'cancelled') return 'cancelled';
  return endsAt < today ? 'expired' : status;
};

export const isParentAlertsRenewalEligible = (
  status: 'active' | 'expired' | 'cancelled',
  endsAt: string,
  today: string
): boolean => status !== 'cancelled' && endsAt < today;
