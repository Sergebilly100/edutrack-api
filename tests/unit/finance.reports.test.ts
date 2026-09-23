import { describe, expect, it } from 'vitest';

import { calculateRunningBalances } from '../../src/modules/finance/finance.reports.js';

describe('student account running balance', () => {
  it('déduit uniquement les versements confirmés dans l’ordre des mouvements', () => {
    const result = calculateRunningBalances(100_000, [
      { id: '1', amount: 20_000, status: 'confirmed' as const, paymentDate: '2026-01-10' },
      { id: '2', amount: 5_000, status: 'cancelled' as const, paymentDate: '2026-01-11' },
      { id: '3', amount: 30_000, status: 'confirmed' as const, paymentDate: '2026-01-12' },
    ]);
    expect(result.map(({ runningPaid, balanceAfter }) => ({ runningPaid, balanceAfter }))).toEqual([
      { runningPaid: 20_000, balanceAfter: 80_000 },
      { runningPaid: 20_000, balanceAfter: 80_000 },
      { runningPaid: 50_000, balanceAfter: 50_000 },
    ]);
  });
});
