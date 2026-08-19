import { describe, expect, it } from 'vitest';

import {
  calculateGeneralAverage,
  calculateSubjectAverage,
} from '../../src/modules/academic/academic-grading.calculations.js';

describe('academic grading cascade', () => {
  it('normalise une évaluation unique sur 20', () => {
    expect(calculateSubjectAverage([{ score: 15, maxScore: 30, coefficient: 2 }])).toBe(10);
  });

  it('pondère plusieurs évaluations par leur coefficient propre', () => {
    expect(
      calculateSubjectAverage([
        { score: 10, maxScore: 20, coefficient: 1 },
        { score: 18, maxScore: 20, coefficient: 3 },
      ])
    ).toBe(16);
  });

  it('retourne null pour une matière sans évaluation', () => {
    expect(calculateSubjectAverage([])).toBeNull();
  });

  it('exclut les matières sans note et pondère les moyennes matière', () => {
    expect(
      calculateGeneralAverage([
        { average: 16, coefficient: 4 },
        { average: 12, coefficient: 2 },
        { average: null, coefficient: 1 },
      ])
    ).toBe(14.667);
  });

  it('refuse un barème ou un coefficient invalide', () => {
    expect(() => calculateSubjectAverage([{ score: 1, maxScore: 0, coefficient: 1 }])).toThrow();
    expect(() => calculateGeneralAverage([{ average: 10, coefficient: 0 }])).toThrow();
  });
});
