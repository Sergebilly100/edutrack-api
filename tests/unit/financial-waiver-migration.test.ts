import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { shouldApplyFinancialWaiverMigration } from '../../src/shared/database/financial-waiver-migration.js';

type LegacyShape = {
  paymentLabels: string[];
  cacheLabels: string[];
  hasWaivedAmount: boolean;
  waivedPayments: number;
  waivedCacheRows: number;
};

function mockClient(shape: LegacyShape): PoolClient {
  const query = vi.fn(async (statement: string) => {
    if (statement.includes('SELECT t.typname, e.enumlabel')) {
      return { rows: [
        ...shape.paymentLabels.map((enumlabel) => ({ typname: 'finance_payment_status', enumlabel })),
        ...shape.cacheLabels.map((enumlabel) => ({ typname: 'financial_cache_status', enumlabel })),
      ] };
    }
    if (statement.includes('information_schema.columns')) {
      return { rows: [{ exists: shape.hasWaivedAmount }] };
    }
    if (statement.includes('FROM payments')) {
      return { rows: [{ count: String(shape.waivedPayments) }] };
    }
    if (statement.includes('FROM student_financial_status')) {
      return { rows: [{ count: String(shape.waivedCacheRows) }] };
    }
    return { rows: [] };
  });
  return { query } as unknown as PoolClient;
}

const oldShape = (overrides: Partial<LegacyShape> = {}): LegacyShape => ({
  paymentLabels: ['confirmed', 'waived_by_school', 'cancelled'],
  cacheLabels: ['up_to_date', 'late', 'waived'],
  hasWaivedAmount: true,
  waivedPayments: 0,
  waivedCacheRows: 0,
  ...overrides,
});

describe('financial waiver migration preflight', () => {
  it('skips schemas already on the target shape', async () => {
    const client = mockClient(oldShape({
      paymentLabels: ['confirmed', 'cancelled'],
      cacheLabels: ['up_to_date', 'late'],
      hasWaivedAmount: false,
    }));

    await expect(shouldApplyFinancialWaiverMigration(client, 'school_clean')).resolves.toBe(false);
  });

  it('allows the generated migration after historical waiver rows are reconciled', async () => {
    await expect(shouldApplyFinancialWaiverMigration(mockClient(oldShape()), 'school_clean')).resolves.toBe(true);
  });

  it('blocks migration while any old payment or cache waiver remains', async () => {
    const client = mockClient(oldShape({ waivedPayments: 1 }));

    await expect(shouldApplyFinancialWaiverMigration(client, 'school_review'))
      .rejects.toThrow('C43_RECONCILIATION_REQUIRED: school_review; waivedPayments=1; waivedCacheRows=0');
  });

  it('rejects a partially migrated schema for manual review', async () => {
    const client = mockClient(oldShape({ cacheLabels: ['up_to_date', 'late'] }));

    await expect(shouldApplyFinancialWaiverMigration(client, 'school_partial'))
      .rejects.toThrow('C43_PARTIAL_SCHEMA_REQUIRES_REVIEW: school_partial');
  });
});
