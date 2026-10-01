import { sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { FinanceRepository } from '../../src/modules/finance/finance.repository.js';

type SqlChunk = { value?: unknown; queryChunks?: unknown[] };
const renderSql = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(renderSql).join('');
  if (typeof value !== 'object' || value === null) return '';
  const chunk = value as SqlChunk;
  if (Array.isArray(chunk.value)) return chunk.value.map(renderSql).join('');
  if (Array.isArray(chunk.queryChunks)) return chunk.queryChunks.map(renderSql).join('');
  return '';
};

describe('historical finance scope', () => {
  it('uses the confirmed enrollment of a closed year even when the student and class are inactive', async () => {
    const queries: string[] = [];
    const db = {
      execute: vi.fn(async (query: ReturnType<typeof sql>) => {
        queries.push(renderSql(query));
        return { rows: [] };
      }),
    };
    const repository = new FinanceRepository(db as never);
    await repository.hasConfirmedEnrollment('student', 'old-year', true);
    await repository.getAmountDueContext('student', 'old-year', false, true);
    await repository.getExpectedAtDate('student', 'old-year', '2026-09-30', true);
    expect(queries[0]).toContain("sy.status = 'closed'");
    expect(queries[0]).toContain("e.status = 'confirmed'");
    expect(queries[1]).toContain("e.status = 'confirmed'");
    expect(queries[1]).not.toContain('s.is_active = true');
    expect(queries[1]).not.toContain('c.is_active = true');
    expect(queries[2]).not.toContain('s.is_active = true');
    expect(queries[2]).not.toContain('c.is_active = true');
  });
});
