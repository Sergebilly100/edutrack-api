import { describe, expect, it } from 'vitest';

import { evaluateSubscriptionAvailability, remainingMonthsInYear } from '../../src/modules/subscriptions/subscriptions.window.js';

const year = { id: 'y1', label: '2025-2026', endDate: '2026-12-31' };

describe('règle fin d’année des abonnements', () => {
  it('compte les mois restants, mois en cours inclus', () => {
    expect(remainingMonthsInYear('2026-11-08', '2026-12-31')).toBe(2);
    expect(remainingMonthsInYear('2026-03-01', '2026-12-31')).toBe(10);
    expect(remainingMonthsInYear('2026-12-31', '2026-12-31')).toBe(1); // dernier jour : dernier mois
    expect(remainingMonthsInYear('2026-12-01', '2026-12-31')).toBe(1);
  });

  it('année terminée : aucun mois restant', () => {
    expect(remainingMonthsInYear('2027-01-01', '2026-12-31')).toBe(0);
  });

  it('année qui chevauche deux années civiles', () => {
    expect(remainingMonthsInYear('2026-10-15', '2027-06-30')).toBe(9);
  });

  it('autorise tant que l’année n’est pas terminée, y compris le dernier jour', () => {
    expect(evaluateSubscriptionAvailability('2026-12-31', year)).toMatchObject({ canSubscribe: true, remainingMonths: 1, schoolYearLabel: '2025-2026' });
  });

  it('refuse après la fin de l’année avec un message clair', () => {
    const result = evaluateSubscriptionAvailability('2027-01-01', year);
    expect(result).toMatchObject({ canSubscribe: false, reason: 'SCHOOL_YEAR_ENDED', remainingMonths: 0 });
    expect(result.canSubscribe === false && result.message).toContain('terminée');
  });

  it('refuse sans année active', () => {
    expect(evaluateSubscriptionAvailability('2026-11-08', null)).toMatchObject({ canSubscribe: false, reason: 'NO_ACTIVE_SCHOOL_YEAR' });
  });
});
