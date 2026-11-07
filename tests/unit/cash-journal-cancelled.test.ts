import ExcelJS from 'exceljs';
import { describe, expect, it, vi } from 'vitest';

import { ARCHIVED_USER_LABEL, FinanceService } from '../../src/modules/finance/finance.service.js';
import type { CashJournalRow, FinanceRepository } from '../../src/modules/finance/finance.repository.js';

const row = (overrides: Partial<CashJournalRow>): CashJournalRow => ({
  id: 'p', student_id: 's', school_year_id: 'y', amount: 100000, method: 'cash', source: 'cashier_manual', status: 'confirmed',
  confirmed_by_user_id: null, provider_reference: null, school_receipt_reference: null, receipt_number: 'REC-1',
  cancelled_at: null, cancelled_by_user_id: null, cancellation_reason: null, payment_date: '2026-11-05', created_at: '2026-11-05T10:00:00Z',
  student_matricule: 'M1', student_name: 'Awa', class_id: 'c', class_name: '6A', cancelled_by_name: null, cancelled_by_active: null,
  ...overrides,
}) as CashJournalRow;

const confirmed = row({ id: 'a', amount: 100000 });
const mobile = row({ id: 'b', amount: 50000, method: 'mobile_money' });
const cancelled = row({ id: 'c', amount: 70000, status: 'cancelled', cancelled_at: '2026-11-06T09:14:00Z', cancelled_by_user_id: 'u', cancelled_by_name: 'Direction Démo', cancelled_by_active: true, cancellation_reason: 'Erreur' });
const archived = row({ id: 'd', amount: 10000, status: 'cancelled', cancelled_at: '2026-11-06T09:14:00Z', cancelled_by_user_id: 'u2', cancelled_by_name: 'Ex Caissier', cancelled_by_active: false, cancellation_reason: 'Doublon' });

const makeService = (rows: CashJournalRow[]) => {
  const listCashJournal = vi.fn(async (filter: { status?: string }) => rows.filter((item) => !filter.status || item.status === filter.status));
  const repository = {
    listCashJournal,
    listCashJournalPage: vi.fn(async (filter: { status?: string }) => rows.filter((item) => !filter.status || item.status === filter.status)),
    getCashJournalSummary: vi.fn(async () => ({
      total: rows.length, confirmed_count: rows.filter((r) => r.status === 'confirmed').length, cancelled_count: rows.filter((r) => r.status === 'cancelled').length,
      cash_total: 100000, mobile_money_total: 50000, bank_transfer_total: 0, grand_total: 150000,
    })),
  } as unknown as FinanceRepository;
  return { service: new FinanceService(repository), repository };
};

describe('cash journal – cancelled payments', () => {
  it('excludes cancelled payments from every total, even when listing them', async () => {
    const { service } = makeService([confirmed, mobile, cancelled]);
    const journal = await service.getCashJournal({ includeCancelled: true });
    expect(journal.entries).toHaveLength(3);
    expect(journal.totals).toEqual({ cash: 100000, mobile_money: 50000, bank_transfer: 0, grandTotal: 150000 });
  });

  it('keeps the confirmed total when filtering on cancelled only', async () => {
    const { service } = makeService([confirmed, mobile, cancelled]);
    const journal = await service.getCashJournal({ includeCancelled: true, status: 'cancelled' });
    expect(journal.entries.map((entry) => entry.status)).toEqual(['cancelled']);
    expect(journal.totals.grandTotal).toBe(150000);
  });

  it('exposes who cancelled, and labels archived authors', async () => {
    const { service } = makeService([cancelled, archived, confirmed]);
    const journal = await service.getCashJournal({ includeCancelled: true });
    expect(journal.entries[0]).toMatchObject({ cancelledBy: 'Direction Démo', cancellationReason: 'Erreur' });
    expect(journal.entries[1].cancelledBy).toBe(ARCHIVED_USER_LABEL);
    expect(journal.entries[2].cancelledBy).toBeNull();
  });

  it('paginates with separate confirmed / cancelled counters', async () => {
    const { service } = makeService([confirmed, mobile, cancelled]);
    const all = await service.getPaginatedCashJournal({ includeCancelled: true, page: 1, limit: 20 });
    expect(all.counts).toEqual({ confirmed: 2, cancelled: 1 });
    expect(all.pagination.total).toBe(3);
    const onlyCancelled = await service.getPaginatedCashJournal({ includeCancelled: true, status: 'cancelled', page: 1, limit: 20 });
    expect(onlyCancelled.pagination.total).toBe(1);
    expect(onlyCancelled.totals.grandTotal).toBe(150000);
  });

  it('adds status and cancellation columns to the Excel export and a confirmed-only total row', async () => {
    const { service } = makeService([confirmed, mobile, cancelled]);
    const buffer = await service.exportCashJournalExcel({ includeCancelled: true });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];
    const header = (sheet.getRow(1).values as unknown[]).slice(1);
    expect(header).toEqual(expect.arrayContaining(['Statut', 'Annulé par', 'Annulé le', 'Motif']));
    const cancelledRow = sheet.getRow(4).values as unknown[];
    expect(cancelledRow).toEqual(expect.arrayContaining(['Annulé', 'Direction Démo', 'Erreur']));
    const totalRow = sheet.getRow(5).values as unknown[];
    expect(totalRow).toEqual(expect.arrayContaining(['Total confirmé (annulés exclus)', 150000]));
  });
});
