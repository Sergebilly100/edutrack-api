import { describe, expect, it } from 'vitest';

import { summarizeFinancialInstallments, type InstallmentLedgerRow } from '../../src/modules/finance/financial-installments.js';

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
