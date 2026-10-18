export type InstallmentLedgerRow = {
  student_id: string;
  annual_due: string | number;
  scheduled_amount: string | number;
  due_date: string | null;
  installment_amount: string | number | null;
  schedule_valid: boolean;
  total_paid: string | number;
  as_of_date: string;
};

export type FinancialAgingBucket = {
  bucket: '0-30' | '31-60' | '>60';
  total_amount: string;
  student_count: number;
};

export type FinancialInstallmentSummary = {
  scheduleComplete: boolean;
  upcomingInstallments: Array<{
    due_date: string;
    expected_amount: string;
    student_count: number;
  }>;
  aging: FinancialAgingBucket[] | null;
};

const AGING_BUCKETS = ['0-30', '31-60', '>60'] as const;
const CIVIL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const cents = (value: string | number, field: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid financial installment field: ${field}`);
  }
  return Math.round(parsed * 100);
};

const formatCents = (value: number): string => (value / 100).toFixed(2);

const daysBetween = (earlier: string, later: string): number => {
  if (!CIVIL_DATE_PATTERN.test(earlier) || !CIVIL_DATE_PATTERN.test(later)) {
    throw new Error('Invalid financial installment date.');
  }
  const earlierMs = Date.parse(`${earlier}T00:00:00.000Z`);
  const laterMs = Date.parse(`${later}T00:00:00.000Z`);
  if (!Number.isFinite(earlierMs) || !Number.isFinite(laterMs)) {
    throw new Error('Invalid financial installment date.');
  }
  if (
    new Date(earlierMs).toISOString().slice(0, 10) !== earlier
    || new Date(laterMs).toISOString().slice(0, 10) !== later
  ) {
    throw new Error('Invalid financial installment date.');
  }
  return Math.floor((laterMs - earlierMs) / 86_400_000);
};

const bucketForAge = (days: number): FinancialAgingBucket['bucket'] => {
  if (days <= 30) return '0-30';
  if (days <= 60) return '31-60';
  return '>60';
};

export const summarizeFinancialInstallments = (
  rows: readonly InstallmentLedgerRow[],
): FinancialInstallmentSummary => {
  const students = new Map<string, InstallmentLedgerRow[]>();
  for (const row of rows) {
    const studentRows = students.get(row.student_id) ?? [];
    studentRows.push(row);
    students.set(row.student_id, studentRows);
  }

  const upcomingByDate = new Map<string, { amount: number; students: Set<string> }>();
  const agingTotals = new Map<FinancialAgingBucket['bucket'], { amount: number; students: Set<string> }>(
    AGING_BUCKETS.map((bucket) => [bucket, { amount: 0, students: new Set<string>() }]),
  );
  let scheduleComplete = true;

  for (const [studentId, studentRows] of students) {
    studentRows.sort((first, second) => (first.due_date ?? '').localeCompare(second.due_date ?? ''));
    const firstRow = studentRows[0]!;
    const totalPaid = cents(firstRow.total_paid, 'total_paid');
    const annualDue = cents(firstRow.annual_due, 'annual_due');
    const scheduledAmount = cents(firstRow.scheduled_amount, 'scheduled_amount');
    if (annualDue !== scheduledAmount || !firstRow.schedule_valid) scheduleComplete = false;

    for (const row of studentRows) {
      if (
        cents(row.total_paid, 'total_paid') !== totalPaid
        || cents(row.annual_due, 'annual_due') !== annualDue
        || cents(row.scheduled_amount, 'scheduled_amount') !== scheduledAmount
        || row.schedule_valid !== firstRow.schedule_valid
      ) {
        throw new Error('Inconsistent financial installment ledger rows.');
      }
    }

    const asOfDate = studentRows[0]!.as_of_date;
    let unappliedPayment = totalPaid;

    for (const row of studentRows) {
      if (row.as_of_date !== asOfDate) {
        throw new Error('Inconsistent financial installment ledger rows.');
      }
      if (row.due_date === null) continue;
      if (row.installment_amount === null) {
        throw new Error('Missing financial installment amount.');
      }

      const installmentAmount = cents(row.installment_amount, 'installment_amount');
      const appliedPayment = Math.min(unappliedPayment, installmentAmount);
      const outstandingAmount = installmentAmount - appliedPayment;
      unappliedPayment -= appliedPayment;
      if (outstandingAmount === 0) continue;

      if (row.due_date > asOfDate) {
        const dueDate = upcomingByDate.get(row.due_date) ?? { amount: 0, students: new Set<string>() };
        dueDate.amount += outstandingAmount;
        dueDate.students.add(studentId);
        upcomingByDate.set(row.due_date, dueDate);
        continue;
      }

      const ageBucket = bucketForAge(daysBetween(row.due_date, asOfDate));
      const bucket = agingTotals.get(ageBucket)!;
      bucket.amount += outstandingAmount;
      bucket.students.add(studentId);
    }
  }

  const upcomingInstallments = [...upcomingByDate.entries()]
    .sort(([firstDate], [secondDate]) => firstDate.localeCompare(secondDate))
    .slice(0, 3)
    .map(([due_date, summary]) => ({
      due_date,
      expected_amount: formatCents(summary.amount),
      student_count: summary.students.size,
    }));

  const aging = AGING_BUCKETS.map((bucket) => {
    const summary = agingTotals.get(bucket)!;
    return {
      bucket,
      total_amount: formatCents(summary.amount),
      student_count: summary.students.size,
    };
  });

  return { scheduleComplete, upcomingInstallments, aging: scheduleComplete ? aging : null };
};
