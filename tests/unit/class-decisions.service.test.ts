import { describe, expect, it, vi } from 'vitest';

import type { ClassDecisionsRepository } from '../../src/modules/class-decisions/class-decisions.repository.js';
import {
  ClassDecisionsService,
  isEndOfYearReviewVisible,
} from '../../src/modules/class-decisions/class-decisions.service.js';

const activeSchoolYear = {
  id: '550e8400-e29b-41d4-a716-446655440001',
  label: '09/2026 - 06/2027',
  endDate: '2027-06-30',
  endOfYearReviewStartDate: '2027-05-31',
};

const repository = {
  getActiveSchoolYear: vi.fn(),
  listForSchoolYear: vi.fn(),
  listLevels: vi.fn(),
  levelExists: vi.fn(),
  validateDecision: vi.fn(),
} as unknown as ClassDecisionsRepository;

describe('end-of-year review visibility', () => {
  it('reste masquée avant la date seuil', () => {
    expect(isEndOfYearReviewVisible('2027-05-31', '2027-05-30')).toBe(false);
  });

  it('devient visible à la date seuil', () => {
    expect(isEndOfYearReviewVisible('2027-05-31', '2027-05-31')).toBe(true);
  });

  it("reste masquée lorsqu'aucune année n'est active", async () => {
    vi.mocked(repository.getActiveSchoolYear).mockResolvedValue(null);
    const service = new ClassDecisionsService(repository);
    await expect(service.getReviewStatus('2027-06-01')).resolves.toEqual({
      visible: false,
      activeSchoolYear: null,
    });
  });

  it('expose l’année active une fois le seuil atteint', async () => {
    vi.mocked(repository.getActiveSchoolYear).mockResolvedValue(activeSchoolYear);
    const service = new ClassDecisionsService(repository);
    await expect(service.getReviewStatus('2027-05-31')).resolves.toEqual({
      visible: true,
      activeSchoolYear,
    });
  });
});
