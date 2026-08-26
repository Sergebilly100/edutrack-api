import { describe, expect, it } from 'vitest';

import { isRuleDue } from '../../src/modules/finance/financial-alerts.service.js';

const baseRule = { type: 'late' as const, daysOffset: 3 };
const severeRule = { type: 'severe_late' as const, daysOffset: 15 };

describe('isRuleDue (détermination des relances dues)', () => {
  it('élève en retard au-delà du seuil : relance due', () => {
    expect(isRuleDue(baseRule, { status: 'late', daysLate: 5 })).toBe(true);
    expect(isRuleDue(baseRule, { status: 'late', daysLate: 3 })).toBe(true); // seuil inclus
  });

  it('retard sous le seuil : pas de relance', () => {
    expect(isRuleDue(baseRule, { status: 'late', daysLate: 2 })).toBe(false);
    expect(isRuleDue(baseRule, { status: 'late', daysLate: null })).toBe(false);
  });

  it('élève à jour ou waived : jamais de relance de retard', () => {
    expect(isRuleDue(baseRule, { status: 'up_to_date', daysLate: 30 })).toBe(false);
    expect(isRuleDue(severeRule, { status: 'waived', daysLate: 20 })).toBe(false);
  });

  it('severe_late exige un retard supérieur au seuil simple', () => {
    expect(isRuleDue(severeRule, { status: 'late', daysLate: 10 })).toBe(false);
    expect(isRuleDue(severeRule, { status: 'late', daysLate: 15 })).toBe(true);
  });
});
