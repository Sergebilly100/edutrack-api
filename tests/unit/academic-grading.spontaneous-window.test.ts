import { describe, expect, it } from 'vitest';

import { isWithinSpontaneousGradeWindow } from '../../src/modules/academic/academic-grading.service.js';

describe('isWithinSpontaneousGradeWindow', () => {
  const date = '2026-09-07';

  it('autorise la saisie pendant le cours et pendant les 24 heures suivantes', () => {
    expect(isWithinSpontaneousGradeWindow(date, '08:00', '09:00', new Date('2026-09-07T08:00:00.000Z'))).toBe(true);
    expect(isWithinSpontaneousGradeWindow(date, '08:00', '09:00', new Date('2026-09-08T09:00:00.000Z'))).toBe(true);
  });

  it('refuse la saisie avant le cours et après la fenêtre de 24 heures', () => {
    expect(isWithinSpontaneousGradeWindow(date, '08:00', '09:00', new Date('2026-09-07T07:59:59.000Z'))).toBe(false);
    expect(isWithinSpontaneousGradeWindow(date, '08:00', '09:00', new Date('2026-09-08T09:00:01.000Z'))).toBe(false);
  });
});
