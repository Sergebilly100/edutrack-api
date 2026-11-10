import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { FinanceRepository } from '../../src/modules/finance/finance.repository.js';

const dialect = new PgDialect();

const capture = async (run: (repository: FinanceRepository) => Promise<unknown>, rowsToReturn: unknown[] = []) => {
  const statements: string[] = [];
  const db = { execute: async (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
    statements.push(dialect.sqlToQuery(query).sql.replace(/\s+/g, ' ').trim());
    return { rows: rowsToReturn };
  } };
  try { await run(new FinanceRepository(db as never)); } catch { /* seul le SQL émis importe ici */ }
  return statements;
};

describe('numéro de reçu REC-AAAAMMJJ-NNNN', () => {
  it('utilise un compteur par jour incrémenté de façon atomique, au format AAAAMMJJ-NNNN', async () => {
    const [sqlText] = await capture((repository) => repository.nextReceiptNumber(), [{ receipt_number: 'REC-20261105-0001' }]);
    expect(sqlText).toContain('INSERT INTO payment_receipt_counters');
    expect(sqlText).toContain('ON CONFLICT (day) DO UPDATE SET last_number = payment_receipt_counters.last_number + 1');
    expect(sqlText).toContain("to_char(day, 'YYYYMMDD')");
    expect(sqlText).toContain("LPAD(last_number::text, 4, '0')");
    expect(sqlText).toContain("'Africa/Abidjan'");
  });

  it('renvoie le numéro émis tel quel', async () => {
    const db = { execute: async () => ({ rows: [{ receipt_number: 'REC-20261105-0002' }] }) };
    await expect(new FinanceRepository(db as never).nextReceiptNumber()).resolves.toBe('REC-20261105-0002');
  });

  it('échoue explicitement si aucun numéro n’est émis', async () => {
    const db = { execute: async () => ({ rows: [] }) };
    await expect(new FinanceRepository(db as never).nextReceiptNumber()).rejects.toThrow('Failed to generate receipt number');
  });
});

describe('heure réelle du paiement (paid_at)', () => {
  const insert = (source: 'cashier_manual' | 'bulk_import' | 'migration_import' | 'in_app_button', paymentDate?: string) =>
    capture((repository) => repository.insertPayment({
      studentId: '00000000-0000-0000-0000-000000000001', schoolYearId: '00000000-0000-0000-0000-000000000002',
      amount: 1000, method: 'cash', source, receiptNumber: 'REC-20261105-0001', ...(paymentDate ? { paymentDate } : {}),
    }), [{ id: 'p1' }]).then(([text]) => text!);

  it('enregistrée pour un encaissement à la caisse à la date du jour', async () => {
    expect(await insert('cashier_manual')).toMatch(/paid_at \) VALUES .*NOW\(\) \) RETURNING/);
  });
  it('jamais pour un import ni un paiement rétrodaté (heure inconnue)', async () => {
    expect(await insert('bulk_import', '2026-09-01')).toContain('NULL ) RETURNING');
    expect(await insert('migration_import', '2026-09-01')).toContain('NULL ) RETURNING');
    expect(await insert('cashier_manual', '2026-09-01')).toContain('NULL ) RETURNING');
  });
});
