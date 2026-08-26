import { FinancialCacheRepository } from './financial-cache.repository.js';

export type FinancialCacheStatus = 'up_to_date' | 'late' | 'waived';

/** Statut de cache : à jour si couvert à la date du jour, waived si couvert par remises. */
export const resolveCacheStatus = (input: {
  expectedToDate: number;
  paidConfirmed: number;
  waivedAmount: number;
}): FinancialCacheStatus => {
  // Une remise qui couvre entièrement le dû à date prime (l'élève n'est pas
  // en retard de sa faute).
  if (input.waivedAmount > 0 && input.waivedAmount >= input.expectedToDate && input.waivedAmount > input.paidConfirmed) {
    return 'waived';
  }
  const effectivePaid = input.paidConfirmed + input.waivedAmount;
  return effectivePaid >= input.expectedToDate ? 'up_to_date' : 'late';
};

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

  async getStudentCachedStatus(studentId: string, schoolYearId?: string) {
    const yearId = schoolYearId ?? (await this.repository.getActiveSchoolYearId());
    if (!yearId) return null;
    return this.repository.getStudentCachedStatus(studentId, yearId);
  }

  private toCacheRow(snapshot: {
    studentId: string;
    expectedToDate: number;
    paidConfirmed: number;
    waivedAmount: number;
    totalDueYear: number;
    earliestOverdueStepDueDate: string | null;
  }) {
    const status = resolveCacheStatus({
      expectedToDate: snapshot.expectedToDate,
      paidConfirmed: snapshot.paidConfirmed,
      waivedAmount: snapshot.waivedAmount,
    });
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
