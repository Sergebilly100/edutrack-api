import { describe, expect, it, vi } from 'vitest';

import { FinancialCacheService } from '../../src/modules/finance/financial-cache.service.js';
import type { FinancialCacheRepository } from '../../src/modules/finance/financial-cache.repository.js';

const ledger = (student: string, due: string, amount: string) => ({
  student_id: student, annual_due: amount, scheduled_amount: amount, due_date: due, installment_amount: amount,
  schedule_valid: true, total_paid: '0', as_of_date: '2026-11-08',
});
const identity = (id: string, last: string, classId: string, className: string) => ({
  student_id: id, first_name: 'Awa', last_name: last, matricule: `M-${id}`, class_id: classId, class_name: className, last_payment_date: null,
});

const build = () => {
  const repository = {
    getActiveSchoolYearId: vi.fn().mockResolvedValue('year-1'),
    listInstallmentLedger: vi.fn().mockResolvedValue([
      ledger('s1', '2026-10-20', '100.00'), ledger('s2', '2026-10-25', '200.00'), ledger('s3', '2026-10-28', '300.00'),
    ]),
    listStudentAgingIdentities: vi.fn().mockResolvedValue([
      identity('s1', 'Koné', 'c-a', '6e A'), identity('s2', 'Yao', 'c-b', '5e B'), identity('s3', 'Bamba', 'c-a', '6e A'),
    ]),
  };
  return { service: new FinancialCacheService(repository as unknown as FinancialCacheRepository), repository };
};

describe('FinancialCacheService.listAgingStudents', () => {
  it('filtre par classe sans changer les chiffres de la tranche, et propose les classes de la tranche', async () => {
    const { service } = build();
    const all = await service.listAgingStudents({ bucket: '0-30', page: 1, limit: 10 });
    const filtered = await service.listAgingStudents({ bucket: '0-30', page: 1, limit: 10, classId: 'c-b' });
    expect(all.pagination.total).toBe(3);
    expect(filtered.pagination.total).toBe(1);
    expect(filtered.students[0]).toMatchObject({ last_name: 'Yao', class_name: '5e B' });
    // Totaux de la tranche identiques à ceux du tableau de bord, quel que soit le filtre.
    expect(filtered.student_count).toBe(3);
    expect(filtered.total_amount).toBe('600.00');
    expect(filtered.classes).toEqual([{ id: 'c-b', name: '5e B' }, { id: 'c-a', name: '6e A' }].sort((a, b) => a.name.localeCompare(b.name, 'fr')));
  });

  it('combine recherche sans accents et classe', async () => {
    const { service } = build();
    const result = await service.listAgingStudents({ bucket: '0-30', page: 1, limit: 10, search: 'kone', classId: 'c-a' });
    expect(result.students.map((row) => row.last_name)).toEqual(['Koné']);
    const none = await service.listAgingStudents({ bucket: '0-30', page: 1, limit: 10, search: 'kone', classId: 'c-b' });
    expect(none.students).toEqual([]);
  });
});
