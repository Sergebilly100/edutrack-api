import { FinancialCacheRepository } from './financial-cache.repository.js';
import {
  calculateAnnualFinancialBalances,
  resolveIndividualFinancialStatus,
  type FinancialCacheStatus,
} from './finance.calculations.js';

export type { FinancialCacheStatus } from './finance.calculations.js';

/** @deprecated Use resolveIndividualFinancialStatus for individual status. */
export const resolveCacheStatus = (input: {
  expectedToDate: number;
  paidConfirmed: number;
}): FinancialCacheStatus => resolveIndividualFinancialStatus({
  totalDue: input.expectedToDate,
  cumulativeExpectedAtDate: input.expectedToDate,
  confirmedPaid: input.paidConfirmed,
}).cacheStatus;

/** Taux de recouvrement borné à [0, 1] ; 1 quand rien n'est encore attendu. */
export const computeRecoveryRate = (totalPaid: number, totalExpectedToDate: number): number => {
  if (totalExpectedToDate <= 0) return 1;
  return Math.min(1, Math.round((totalPaid / totalExpectedToDate) * 10000) / 10000);
};

const aggregateAmount = (value: string | number | undefined, field: string): number => {
  if (value === undefined) throw new Error(`Missing financial aggregate field: ${field}`);
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(amount)) throw new Error(`Invalid financial aggregate field: ${field}`);
  return amount;
};

const withAnnualBalances = <T extends Record<string, string | number>>(row: T) => {
  const balances = calculateAnnualFinancialBalances({
    annualTotalDue: aggregateAmount(row.annual_total_due, 'annual_total_due'),
    collected: aggregateAmount(row.total_paid, 'total_paid'),
    overdueToDate: aggregateAmount(row.remaining_to_collect, 'remaining_to_collect'),
  });
  return {
    ...row,
    annual_remaining: balances.annualRemaining.toFixed(2),
    upcoming_due: balances.upcomingDue.toFixed(2),
  };
};

export class FinancialCacheService {
  constructor(private readonly repository: FinancialCacheRepository) {}

  /** Lot périodique : recalcule tous les élèves, puis agrégats classe et école. */
  async recalcAll(schoolYearId?: string): Promise<{ schoolYearId: string; studentCount: number }> {
    const yearId = schoolYearId ?? (await this.repository.getActiveSchoolYearId());
    if (!yearId) {
      return { schoolYearId: '', studentCount: 0 };
    }

    const snapshots = await this.repository.listStudentFinancialSnapshots(yearId);
    await this.repository.upsertStudentStatuses(
      yearId,
      snapshots.map((snapshot) => this.toCacheRow(snapshot))
    );
    await this.repository.pruneOutOfScope(yearId);
    await this.repository.refreshClassSummaries(yearId);
    await this.repository.refreshSchoolSummary(yearId);

    return { schoolYearId: yearId, studentCount: snapshots.length };
  }

  /** Recalcul ciblé d'un seul élève (après paiement confirmé/annulé). */
  async recalcStudent(studentId: string, schoolYearId: string): Promise<void> {
    const snapshots =
      await this.repository.listStudentFinancialSnapshotSingle(studentId, schoolYearId);
    if (snapshots.length === 0) {
      await this.repository.deleteStudentStatus(studentId, schoolYearId);
      await this.repository.pruneOutOfScope(schoolYearId);
      await this.repository.refreshClassSummaries(schoolYearId);
      await this.repository.refreshSchoolSummary(schoolYearId);
      return;
    }

    await this.repository.upsertStudentStatuses(
      schoolYearId,
      snapshots.map((snapshot) => this.toCacheRow(snapshot))
    );
    await this.repository.pruneOutOfScope(schoolYearId);
    await this.repository.refreshClassSummaries(schoolYearId);
    await this.repository.refreshSchoolSummary(schoolYearId);
  }

  async getSchoolSummary(schoolYearId?: string) {
    const yearId = schoolYearId ?? (await this.repository.getActiveSchoolYearId());
    if (!yearId) return null;
    const summary = await this.repository.getSchoolSummary(yearId);
    return summary ? withAnnualBalances(summary) : null;
  }

  async listClassSummaries(schoolYearId?: string) {
    const yearId = schoolYearId ?? (await this.repository.getActiveSchoolYearId());
    if (!yearId) return [];
    return (await this.repository.listClassSummaries(yearId)).map(withAnnualBalances);
  }

  async listLevelSummaries(schoolYearId?: string) {
    const yearId = schoolYearId ?? (await this.repository.getActiveSchoolYearId());
    if (!yearId) return [];
    return (await this.repository.listLevelSummaries(yearId)).map(withAnnualBalances);
  }

  async listCollectionTrend(schoolYearId?: string) {
    const yearId = schoolYearId ?? (await this.repository.getActiveSchoolYearId());
    if (!yearId) return [];
    return this.repository.listCollectionTrend(yearId);
  }

  async listPaymentMethodSummaries(schoolYearId?: string) {
    const yearId = schoolYearId ?? (await this.repository.getActiveSchoolYearId());
    if (!yearId) return [];
    return this.repository.listPaymentMethodSummaries(yearId);
  }

  async listUpcomingInstallments(schoolYearId?: string) {
    const yearId = schoolYearId ?? (await this.repository.getActiveSchoolYearId());
    if (!yearId) return [];
    return this.repository.listUpcomingInstallments(yearId);
  }

  async listRecentPayments(schoolYearId?: string) {
    const yearId = schoolYearId ?? (await this.repository.getActiveSchoolYearId());
    if (!yearId) return [];
    return this.repository.listRecentPayments(yearId);
  }

  async getStudentCachedStatus(studentId: string, schoolYearId?: string) {
    const yearId = schoolYearId ?? (await this.repository.getActiveSchoolYearId());
    if (!yearId) return null;
    return this.repository.getStudentCachedStatus(studentId, yearId);
  }

  async listClassStudentStatuses(classId: string, schoolYearId?: string) {
    const yearId = schoolYearId ?? (await this.repository.getActiveSchoolYearId());
    if (!yearId) return [];
    return this.repository.listClassStudentStatuses(classId, yearId);
  }

  private toCacheRow(snapshot: {
    studentId: string;
    expectedToDate: number;
    paidConfirmed: number;
    totalDueYear: number;
    earliestOverdueStepDueDate: string | null;
  }) {
    const expectedToDate = Math.max(0, Math.min(snapshot.expectedToDate, snapshot.totalDueYear));
    const status = resolveIndividualFinancialStatus({
      totalDue: snapshot.totalDueYear,
      cumulativeExpectedAtDate: expectedToDate,
      confirmedPaid: snapshot.paidConfirmed,
    }).cacheStatus;
    const daysLate =
      status === 'late' && snapshot.earliestOverdueStepDueDate
        ? Math.max(
            0,
            Math.floor(
              (Date.now() - new Date(`${snapshot.earliestOverdueStepDueDate}T00:00:00Z`).getTime()) /
                86_400_000
            )
          )
        : null;
    return {
      studentId: snapshot.studentId,
      expectedToDate,
      paidConfirmed: snapshot.paidConfirmed,
      totalDueYear: snapshot.totalDueYear,
      status,
      daysLate,
      earliestOverdueStepDueDate:
        status === 'late' ? snapshot.earliestOverdueStepDueDate : null,
    };
  }
}

export const buildFinancialCacheService = (
  db: ConstructorParameters<typeof FinancialCacheRepository>[0]
) => new FinancialCacheService(new FinancialCacheRepository(db));
