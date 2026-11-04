import { describe, expect, it } from 'vitest';

import {
  allocateEnrollmentPayment,
  calculateEnrollmentMinimum,
  calculateImposedParentAlertsAmount,
  isParentAlertsRenewalEligible,
  resolveParentAlertsSubscriptionStatus,
} from '../../src/shared/utils/parent-alerts.js';

describe('parent alerts enrollment calculations', () => {
  it.each([
    [1, 2000],
    [3, 6000],
    [6, 12000],
    [12, 24000],
  ] as const)('calculates the imposed %i-month period', (months, amount) => {
    expect(calculateImposedParentAlertsAmount(2000, months)).toBe(amount);
  });

  it('adds the imposed service amount to the first tuition installment', () => {
    expect(calculateEnrollmentMinimum(25000, 6000)).toBe(31000);
  });

  it('keeps school tuition and the complete service payment separate', () => {
    expect(allocateEnrollmentPayment({
      amount: 45000,
      remainingTuition: 100000,
      parentAlertsAmountFcfa: 6000,
    })).toEqual({
      totalAmount: 45000,
      tuitionAmount: 39000,
      parentAlertsAmount: 6000,
    });
  });

  it('rejects allocations that cannot cover the full service period or exceed balances', () => {
    expect(() => allocateEnrollmentPayment({
      amount: 5000,
      remainingTuition: 100000,
      parentAlertsAmountFcfa: 6000,
    })).toThrow(RangeError);
    expect(() => allocateEnrollmentPayment({
      amount: 110001,
      remainingTuition: 100000,
      parentAlertsAmountFcfa: 6000,
    })).toThrow(RangeError);
  });

  it('resolves expiry without allowing cancelled subscriptions to reactivate', () => {
    expect(resolveParentAlertsSubscriptionStatus('active', '2026-10-31', '2026-11-01')).toBe('expired');
    expect(resolveParentAlertsSubscriptionStatus('cancelled', '2026-10-31', '2026-11-01')).toBe('cancelled');
  });

  it('allows renewal only after expiry and never after cancellation', () => {
    expect(isParentAlertsRenewalEligible('expired', '2026-10-31', '2026-11-01')).toBe(true);
    expect(isParentAlertsRenewalEligible('active', '2026-11-02', '2026-11-01')).toBe(false);
    expect(isParentAlertsRenewalEligible('cancelled', '2026-10-31', '2026-11-01')).toBe(false);
  });
});
