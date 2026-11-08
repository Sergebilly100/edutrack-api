import { describe, expect, it } from 'vitest';

import { needsSalaryRecalculation } from '../../src/modules/billing/billing.service.js';

const base = {
  teacher_type: 'vacataire' as const,
  hourly_rate: 3500,
  hours_planned: 10,
  hours_done: 8,
  salary_record_id: 'rec-1',
  stored_hours_done: 8,
};

describe('needsSalaryRecalculation', () => {
  it('false quand la fiche est à jour', () => {
    expect(needsSalaryRecalculation(base)).toBe(false);
  });
  it('true quand la fiche est absente alors que le prof a des heures', () => {
    expect(needsSalaryRecalculation({ ...base, salary_record_id: null, stored_hours_done: null })).toBe(true);
  });
  it('true quand les heures figées ne correspondent plus aux pointages', () => {
    expect(needsSalaryRecalculation({ ...base, stored_hours_done: 5 })).toBe(true);
  });
  it('false pour un vacataire sans taux horaire ou sans activité (aucune fiche ne sera créée)', () => {
    expect(needsSalaryRecalculation({ ...base, hourly_rate: null, salary_record_id: null, stored_hours_done: null })).toBe(false);
    expect(needsSalaryRecalculation({ ...base, hours_planned: 0, hours_done: 0, salary_record_id: null, stored_hours_done: null })).toBe(false);
  });
  it('permanent : fiche requise seulement avec des heures planifiées', () => {
    const permanent = { ...base, teacher_type: 'permanent' as const, hourly_rate: null, salary_record_id: null, stored_hours_done: null };
    expect(needsSalaryRecalculation(permanent)).toBe(true);
    expect(needsSalaryRecalculation({ ...permanent, hours_planned: 0 })).toBe(false);
  });
});
