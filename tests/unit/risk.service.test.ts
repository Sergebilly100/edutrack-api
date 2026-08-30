import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RISK_RULES,
  isAbsenceRisk,
  isGradeDropRisk,
  isPaymentRisk,
  resolveRollingRiskRule,
} from '../../src/modules/risk/risk.calculations.js';
import { deriveLevel } from '../../src/modules/risk/risk.service.js';

describe('deriveLevel (niveau de risque par score)', () => {
  it('0 signal → none', () => {
    expect(deriveLevel(0)).toBe('none');
  });

  it('1 signal → attention', () => {
    expect(deriveLevel(1)).toBe('attention');
  });

  it('2 signaux → warning', () => {
    expect(deriveLevel(2)).toBe('warning');
  });

  it('3 signaux → critical', () => {
    expect(deriveLevel(3)).toBe('critical');
    expect(deriveLevel(4)).toBe('critical');
  });
});

describe('risk signal calculations', () => {
  it('utilise les valeurs sûres par défaut pour chaque signal', () => {
    expect(DEFAULT_RISK_RULES).toEqual({
      studentAbsences: { thresholdValue: 3, periodDays: 30, isActive: true },
      studentGrades: { thresholdValue: 2, periodDays: 0, isActive: true },
      studentPayments: { thresholdValue: 1, periodDays: 0, isActive: true },
      teacherAbsences: { thresholdValue: 3, periodDays: 30, isActive: true },
    });
  });

  it('applique les valeurs renseignées et restaure la fenêtre par défaut si elle est invalide', () => {
    expect(resolveRollingRiskRule(
      { thresholdValue: 4, periodDays: 21, isActive: false },
      DEFAULT_RISK_RULES.studentAbsences
    )).toEqual({ thresholdValue: 4, periodDays: 21, isActive: false });
    expect(resolveRollingRiskRule(
      { thresholdValue: 4, periodDays: 0, isActive: true },
      DEFAULT_RISK_RULES.studentAbsences
    )).toEqual({ thresholdValue: 4, periodDays: 30, isActive: true });
  });

  it('applique le seuil d’absence et sa désactivation', () => {
    expect(isAbsenceRisk(3, 3, true)).toBe(true);
    expect(isAbsenceRisk(2, 3, true)).toBe(false);
    expect(isAbsenceRisk(4, 3, false)).toBe(false);
  });

  it('ne signale qu’une baisse de moyenne qui atteint le seuil', () => {
    expect(isGradeDropRisk(2, 2, true)).toBe(true);
    expect(isGradeDropRisk(-2, 2, true)).toBe(false);
    expect(isGradeDropRisk(1.5, 2, true)).toBe(false);
    expect(isGradeDropRisk(3, 2, false)).toBe(false);
  });

  it('respecte la désactivation du signal de paiement', () => {
    expect(isPaymentRisk(true, true)).toBe(true);
    expect(isPaymentRisk(true, false)).toBe(false);
    expect(isPaymentRisk(false, true)).toBe(false);
  });
});
