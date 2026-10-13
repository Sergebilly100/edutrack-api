import { describe, expect, it } from 'vitest';

import { formatStudentRank, formatStudentRankWithHeadcount } from '../../src/shared/utils/format-student-rank.js';

describe('formatStudentRank', () => {
  it.each([
    [1, '1er'], [2, '2ème'], [10, '10ème'],
    [null, null], [undefined, null], [0, null], [-1, null], [1.5, null], [NaN, null],
  ])('formate %s en %s', (rank, expected) => {
    expect(formatStudentRank(rank)).toBe(expected);
  });

  it('affiche l’effectif sans altérer le rang', () => {
    expect(formatStudentRankWithHeadcount(1, 30)).toBe('1er / 30');
    expect(formatStudentRankWithHeadcount(2, 30)).toBe('2ème / 30');
    expect(formatStudentRankWithHeadcount(null, 30)).toBeNull();
  });
});
