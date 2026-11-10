import { describe, expect, it } from 'vitest';

import { listAgingBucketStudents, summarizeFinancialInstallments, type InstallmentLedgerRow } from '../../src/modules/finance/financial-installments.js';

const row = (
  student_id: string,
  due_date: string | null,
  installment_amount: string,
  total_paid = '0',
  as_of_date = '2026-03-02',
  annual_due = installment_amount,
  scheduled_amount = annual_due,
): InstallmentLedgerRow => ({
  student_id,
  due_date,
  installment_amount: due_date === null ? null : installment_amount,
  schedule_valid: true,
  annual_due,
  scheduled_amount,
  total_paid,
  as_of_date,
});

describe('financial installment summary', () => {
  it('applies confirmed payments FIFO before splitting overdue and upcoming balances', () => {
    const result = summarizeFinancialInstallments([
      row('student-1', '2026-03-01', '100.00', '50.00', '2026-03-02', '300.00', '300.00'),
      row('student-1', '2026-04-01', '200.00', '50.00', '2026-03-02', '300.00', '300.00'),
    ]);

    expect(result).toEqual({
      scheduleComplete: true,
      upcomingInstallments: [{ due_date: '2026-04-01', expected_amount: '200.00', student_count: 1 }],
      aging: [
        { bucket: '0-30', total_amount: '50.00', student_count: 1 },
        { bucket: '31-60', total_amount: '0.00', student_count: 0 },
        { bucket: '>60', total_amount: '0.00', student_count: 0 },
      ],
    });
  });

  it('assigns aging buckets at exact day boundaries and counts each student once per bucket', () => {
    const result = summarizeFinancialInstallments([
      row('student-30', '2026-01-31', '10.00'),
      row('student-31', '2026-01-30', '20.00', '0', '2026-03-02', '25.00', '25.00'),
      row('student-60', '2026-01-01', '30.00'),
      row('student-61', '2025-12-31', '40.00'),
      row('student-31', '2026-01-29', '5.00', '0', '2026-03-02', '25.00', '25.00'),
    ]);

    expect(result).toMatchObject({
      scheduleComplete: true,
      aging: [
      { bucket: '0-30', total_amount: '10.00', student_count: 1 },
      { bucket: '31-60', total_amount: '55.00', student_count: 2 },
      { bucket: '>60', total_amount: '40.00', student_count: 1 },
      ],
    });
  });

  it('aggregates future amounts by date and returns only the three nearest dates', () => {
    const result = summarizeFinancialInstallments([
      row('student-1', '2026-03-10', '10.00'),
      row('student-2', '2026-03-10', '15.00'),
      row('student-3', '2026-03-11', '20.00'),
      row('student-4', '2026-03-12', '25.00'),
      row('student-5', '2026-03-13', '30.00'),
    ]);

    expect(result.scheduleComplete).toBe(true);
    expect(result.upcomingInstallments).toEqual([
      { due_date: '2026-03-10', expected_amount: '25.00', student_count: 2 },
      { due_date: '2026-03-11', expected_amount: '20.00', student_count: 1 },
      { due_date: '2026-03-12', expected_amount: '25.00', student_count: 1 },
    ]);
  });

  it('returns complete zero-valued aging buckets when there are no ledger rows', () => {
    expect(summarizeFinancialInstallments([])).toEqual({
      scheduleComplete: true,
      upcomingInstallments: [],
      aging: [
        { bucket: '0-30', total_amount: '0.00', student_count: 0 },
        { bucket: '31-60', total_amount: '0.00', student_count: 0 },
        { bucket: '>60', total_amount: '0.00', student_count: 0 },
      ],
    });
  });

  it('does not report zero aging when an enrolled student has no schedule', () => {
    expect(summarizeFinancialInstallments([
      row('student-without-schedule', null, '0', '0', '2026-03-02', '300.00', '0.00'),
    ])).toEqual({
      scheduleComplete: false,
      upcomingInstallments: [],
      aging: null,
    });
  });

  it('does not report complete aging when an installment schedule covers only part of the annual due', () => {
    const result = summarizeFinancialInstallments([
      row('student-partial-schedule', '2026-03-10', '60.00', '0', '2026-03-02', '100.00', '60.00'),
    ]);

    expect(result.scheduleComplete).toBe(false);
    expect(result.aging).toBeNull();
    expect(result.upcomingInstallments).toEqual([
      { due_date: '2026-03-10', expected_amount: '60.00', student_count: 1 },
    ]);
  });

  it('does not report complete aging for a non-monotonic cumulative schedule', () => {
    const result = summarizeFinancialInstallments([
      {
        ...row('student-invalid-schedule', '2026-02-20', '100.00', '0', '2026-03-02', '100.00', '100.00'),
        schedule_valid: false,
      },
      {
        ...row('student-invalid-schedule', '2026-02-25', '0.00', '0', '2026-03-02', '100.00', '100.00'),
        schedule_valid: false,
      },
    ]);

    expect(result.scheduleComplete).toBe(false);
    expect(result.aging).toBeNull();
  });

  it('rejects invalid calendar dates instead of assigning an incorrect age bucket', () => {
    expect(() => summarizeFinancialInstallments([
      row('student-invalid-date', '2026-02-31', '100.00', '0', '2026-03-02'),
    ])).toThrow('Invalid financial installment date.');
  });
});

describe('détail des tranches d’ancienneté', () => {
  // Élève A : paiement partiel ; élève B : 2 échéances dans 2 tranches ; élève C : remise (annual_due réduit) tout payé.
  const ledger = [
    row('A', '2026-02-01', '100.00', '40.00', '2026-03-02', '100.00', '100.00'),
    row('B', '2025-12-01', '50.00', '0', '2026-03-02', '80.00', '80.00'),
    row('B', '2026-02-20', '30.00', '0', '2026-03-02', '80.00', '80.00'),
    row('C', '2026-02-10', '70.00', '70.00', '2026-03-02', '70.00', '70.00'),
  ];

  it('les totaux et effectifs de chaque tranche sont identiques à ceux du tableau de bord', () => {
    const summary = summarizeFinancialInstallments(ledger);
    for (const bucket of summary.aging!) {
      const detail = listAgingBucketStudents(ledger, bucket.bucket);
      expect((detail.totalCents / 100).toFixed(2)).toBe(bucket.total_amount);
      expect(detail.students).toHaveLength(bucket.student_count);
    }
  });

  it('paiement partiel : seul le reste dû figure, un élève soldé (remise) est absent, la somme des tranches = reste échu', () => {
    const recent = listAgingBucketStudents(ledger, '0-30');
    expect(recent.students.map((item) => item.studentId).sort()).toEqual(['A', 'B']);
    expect(recent.students.find((item) => item.studentId === 'A')).toMatchObject({ amountCents: 6000, oldestDueDate: '2026-02-01', daysLate: 29 });
    const old = listAgingBucketStudents(ledger, '>60');
    expect(old.students).toEqual([expect.objectContaining({ studentId: 'B', amountCents: 5000, daysLate: 91 })]);
    const total = (['0-30', '31-60', '>60'] as const).reduce((sum, bucket) => sum + listAgingBucketStudents(ledger, bucket).totalCents, 0);
    expect(total).toBe(6000 + 3000 + 5000); // A 60 + B 30 (0-30) + B 50 (>60)
  });

  it('un élève ayant des retards dans deux tranches apparaît dans chacune avec son montant propre', () => {
    expect(listAgingBucketStudents(ledger, '0-30').students.find((item) => item.studentId === 'B')?.amountCents).toBe(3000);
    expect(listAgingBucketStudents(ledger, '>60').students.find((item) => item.studentId === 'B')?.amountCents).toBe(5000);
  });
});
