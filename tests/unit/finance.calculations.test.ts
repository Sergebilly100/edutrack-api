import { describe, expect, it } from 'vitest';

import {
  calculateStudentTotalDue,
  canCancelPayment,
  isValidCumulativeSchedule,
  prorateSubscriptionAmount,
  resolveIndividualFinancialStatus,
  resolveFinancialStanding,
} from '../../src/modules/finance/finance.calculations.js';

describe('finance calculations', () => {
  it('calcule le montant dû sans remise', () => {
    expect(calculateStudentTotalDue({ planTotalAmount: 150_000 })).toBe(150_000);
  });

  it('applique une remise au cas par cas', () => {
    expect(calculateStudentTotalDue({
      planTotalAmount: 150_000,
      discountAmount: 20_000,
    })).toBe(130_000);
  });

  it('donne priorité au montant personnalisé sur la remise', () => {
    expect(calculateStudentTotalDue({
      planTotalAmount: 150_000,
      overrideTotalAmount: 95_000,
      discountAmount: 20_000,
    })).toBe(95_000);
  });

  it('ajoute le montant proratisé de l’abonnement imposé', () => {
    const mandatorySubscription = prorateSubscriptionAmount(1_000, 'monthly', 'quarterly');
    expect(mandatorySubscription).toBe(3_000);
    expect(calculateStudentTotalDue({
      planTotalAmount: 150_000,
      mandatorySubscriptionAmounts: [mandatorySubscription],
    })).toBe(153_000);
  });

  it('compare uniquement le cumul confirmé au seuil attendu à date', () => {
    expect(resolveFinancialStanding(50_000, 50_000)).toBe('up_to_date');
    expect(resolveFinancialStanding(49_999, 50_000)).toBe('late');
  });

  it('considère une remise de l’école comme une couverture individuelle, sans paiement encaissé', () => {
    expect(resolveIndividualFinancialStatus({
      totalDue: 100_000,
      cumulativeExpectedAtDate: 60_000,
      confirmedPaid: 0,
      waivedAmount: 100_000,
    })).toMatchObject({
      coveredAmount: 100_000,
      remainingDue: 0,
      standing: 'up_to_date',
      cacheStatus: 'waived',
    });
  });

  it('autorise l’annulation seulement depuis un statut comptable actif', () => {
    expect(canCancelPayment('confirmed')).toBe(true);
    expect(canCancelPayment('waived_by_school')).toBe(true);
    expect(canCancelPayment('cancelled')).toBe(false);
  });

  it('valide une courbe cumulative individuelle strictement ordonnée et bornée', () => {
    expect(isValidCumulativeSchedule([
      { dueDate: '2026-10-01', cumulativeAmountExpected: 30_000 },
      { dueDate: '2027-01-01', cumulativeAmountExpected: 80_000 },
    ], 100_000)).toBe(true);
    expect(isValidCumulativeSchedule([
      { dueDate: '2026-10-01', cumulativeAmountExpected: 30_000 },
      { dueDate: '2026-09-01', cumulativeAmountExpected: 40_000 },
    ], 100_000)).toBe(false);
    expect(isValidCumulativeSchedule([
      { dueDate: '2026-10-01', cumulativeAmountExpected: 120_000 },
    ], 100_000)).toBe(false);
  });
});
