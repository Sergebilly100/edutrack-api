import { describe, expect, it } from 'vitest';

import {
  calculateAnnualFinancialBalances,
  calculateStudentTotalDue,
  canCancelPayment,
  isValidCumulativeSchedule,
  amountFromCumulativeStep,
  resolveIndividualFinancialStatus,
  resolveFinancialStanding,
  toCumulativeScheduleSteps,
} from '../../src/modules/finance/finance.calculations.js';

describe('finance calculations', () => {
  it('calcule le solde annuel restant et le futur dû à partir des agrégats à date', () => {
    const balances = calculateAnnualFinancialBalances({
      annualTotalDue: 300_000,
      collected: 100_000,
      overdueToDate: 0,
    });
    expect(balances).toEqual({ annualRemaining: 200_000, upcomingDue: 200_000 });
    expect(balances.annualRemaining).toBe(0 + balances.upcomingDue);
    expect(300_000).toBe(100_000 + balances.annualRemaining);
  });

  it('conserve le signe du solde lorsqu’il existe un trop-perçu', () => {
    expect(calculateAnnualFinancialBalances({
      annualTotalDue: 100_000,
      collected: 125_000,
      overdueToDate: 0,
    })).toEqual({ annualRemaining: -25_000, upcomingDue: -25_000 });
  });

  it('déduit un paiement en avance des échéances annuelles restantes', () => {
    expect(calculateAnnualFinancialBalances({
      annualTotalDue: 300_000,
      collected: 150_000,
      overdueToDate: 0,
    })).toEqual({ annualRemaining: 150_000, upcomingDue: 150_000 });
  });

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

  it('garde le service Alertes Parents hors du dû de scolarité', () => {
    expect(calculateStudentTotalDue({ planTotalAmount: 150_000 })).toBe(150_000);
  });

  it('compare uniquement le cumul confirmé au seuil attendu à date', () => {
    expect(resolveFinancialStanding(50_000, 50_000)).toBe('up_to_date');
    expect(resolveFinancialStanding(49_999, 50_000)).toBe('late');
  });

  it('ne compte que les paiements encaissés après réduction du montant dû', () => {
    expect(calculateStudentTotalDue({ planTotalAmount: 100_000, discountAmount: 50_000 })).toBe(50_000);
    expect(resolveIndividualFinancialStatus({
      totalDue: 50_000, cumulativeExpectedAtDate: 50_000, confirmedPaid: 0,
    })).toMatchObject({ coveredAmount: 0, remainingDue: 50_000, standing: 'late', cacheStatus: 'late' });
  });

  it('autorise l’annulation seulement depuis un statut comptable actif', () => {
    expect(canCancelPayment('confirmed')).toBe(true);
    expect(canCancelPayment('cancelled')).toBe(false);
  });

  it('valide une courbe cumulative individuelle strictement ordonnée et complète', () => {
    expect(isValidCumulativeSchedule([
      { dueDate: '2026-10-01', cumulativeAmountExpected: 30_000 },
      { dueDate: '2027-01-01', cumulativeAmountExpected: 100_000 },
    ], 100_000)).toBe(true);
    expect(isValidCumulativeSchedule([
      { dueDate: '2026-10-01', cumulativeAmountExpected: 30_000 },
      { dueDate: '2026-09-01', cumulativeAmountExpected: 40_000 },
    ], 100_000)).toBe(false);
    expect(isValidCumulativeSchedule([
      { dueDate: '2026-10-01', cumulativeAmountExpected: 120_000 },
    ], 100_000)).toBe(false);
    expect(isValidCumulativeSchedule([
      { dueDate: '2026-10-01', cumulativeAmountExpected: 30_000 },
      { dueDate: '2027-01-01', cumulativeAmountExpected: 80_000 },
    ], 100_000)).toBe(false);
  });

  it('calcule les cumuls et le montant de chaque échéance sans arrondi métier caché', () => {
    const steps = toCumulativeScheduleSteps([
      { dueDate: '2026-10-01', amount: 33_333.33 },
      { dueDate: '2026-11-01', amount: 66_666.67 },
    ]);
    expect(steps).toEqual([
      { dueDate: '2026-10-01', cumulativeAmountExpected: 33_333.33 },
      { dueDate: '2026-11-01', cumulativeAmountExpected: 100_000 },
    ]);
    expect(amountFromCumulativeStep(steps[1]!, steps[0]!)).toBe(66_666.67);
  });
});
