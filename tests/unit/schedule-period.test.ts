import { describe, expect, it } from 'vitest';
import { weeklyPeriodSchema } from '../../src/shared/utils/schedule-period.js';

describe('complete weekly schedule periods', () => {
  it.each([
    ['2026-06-01', '2026-06-07', true],
    ['2026-06-01', '2026-06-21', true],
    ['2024-02-26', '2024-03-03', true],
    ['2026-12-28', '2027-01-03', true],
    ['2026-06-02', '2026-06-07', false],
    ['2026-06-01', '2026-06-06', false],
    ['2026-06-08', '2026-06-07', false],
    ['2026-06-01', '2026-06-01', false],
    ['2026-02-30', '2026-03-08', false],
    ['2026-6-1', '2026-06-07', false],
    ['', '2026-06-07', false],
    ['2026-06-01', '', false]
  ])('%s to %s: valid=%s', (validFrom, validTo, expected) => {
    expect(weeklyPeriodSchema.safeParse({ validFrom, validTo }).success).toBe(expected);
  });
});
