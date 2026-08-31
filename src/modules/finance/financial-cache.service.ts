import { FinancialCacheRepository } from './financial-cache.repository.js';
import {
  resolveIndividualFinancialStatus,
  type FinancialCacheStatus,
} from './finance.calculations.js';

export type { FinancialCacheStatus } from './finance.calculations.js';

/** @deprecated Use resolveIndividualFinancialStatus for individual status. */
export const resolveCacheStatus = (input: {
  expectedToDate: number;
  paidConfirmed: number;
  waivedAmount: number;
}): FinancialCacheStatus => resolveIndividualFinancialStatus({
  totalDue: input.expectedToDate,
  cumulativeExpectedAtDate: input.expectedToDate,
  confirmedPaid: input.paidConfirmed,
  waivedAmount: input.waivedAmount,
}).cacheStatus;

/** Taux de recouvrement borné à [0, 1] ; 1 quand rien n'est encore attendu. */
export const computeRecoveryRate = (totalPaid: number, totalExpectedToDate: number): number => {
  if (totalExpectedToDate <= 0) return 1;
  return Math.min(1, Math.round((totalPaid / totalExpectedToDate) * 10000) / 10000);
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
    await this.repository.refreshClassSummaries(yearId);
    await this.repository.refreshSchoolSummary(yearId);

    return { schoolYearId: yearId, studentCount: snapshots.length };
  }

  /** Recalcul ciblé d'un seul élève (après paiement confirmé/annulé). */
  async recalcStudent(studentId: string, schoolYearId: string): Promise<void> {
    const snapshots =
      await this.repository.listStudentFinancialSnapshotSingle(studentId, schoolYearId);
    if (snapshots.length === 0) return;

    await this.repository.upsertStudentStatuses(
      schoolYearId,
      snapshots.map((snapshot) => this.toCacheRow(snapshot))
    );
    await this.repository.refreshClassSummaries(schoolYearId);
    await this.repository.refreshSchoolSummary(schoolYearId);
  }

  async getSchoolSummary(schoolYearId?: string) {
    const yearId = schoolYearId ?? (await this.repository.getActiveSchoolYearId());
    if (!yearId) return null;
    return this.repository.getSchoolSummary(yearId);
  }

  async listClassSummaries(schoolYearId?: string) {
    const yearId = schoolYearId ?? (await this.repository.getActiveSchoolYearId());
    if (!yearId) return [];
    return this.repository.listClassSummaries(yearId);
  }

  async listLevelSummaries(schoolYearId?: string) {
    const yearId = schoolYearId ?? (await this.repository.getActiveSchoolYearId());
    if (!yearId) return [];
    return this.repository.listLevelSummaries(yearId);
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
    waivedAmount: number;
    totalDueYear: number;
    earliestOverdueStepDueDate: string | null;
  }) {
    const status = resolveIndividualFinancialStatus({
      totalDue: snapshot.totalDueYear,
      cumulativeExpectedAtDate: snapshot.expectedToDate,
      confirmedPaid: snapshot.paidConfirmed,
      waivedAmount: snapshot.waivedAmount,
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
      expectedToDate: snapshot.expectedToDate,
      paidConfirmed: snapshot.paidConfirmed,
      waivedAmount: snapshot.waivedAmount,
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
