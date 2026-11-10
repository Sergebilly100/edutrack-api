import { FinancialCacheRepository } from './financial-cache.repository.js';
import { listAgingBucketStudents, summarizeFinancialInstallments, type FinancialAgingBucket } from './financial-installments.js';
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

  async getInstallmentSummary(schoolYearId?: string) {
    const yearId = schoolYearId ?? (await this.repository.getActiveSchoolYearId());
    if (!yearId) return summarizeFinancialInstallments([]);
    return summarizeFinancialInstallments(await this.repository.listInstallmentLedger(yearId));
  }

  /** Détail d'une tranche : mêmes calculs que le tableau de bord, enrichis (nom, classe, dernier paiement). */
  async listAgingStudents(input: { schoolYearId?: string; bucket: FinancialAgingBucket['bucket']; page: number; limit: number; search?: string; classId?: string }) {
    const yearId = input.schoolYearId ?? (await this.repository.getActiveSchoolYearId());
    const empty = { bucket: input.bucket, total_amount: '0.00', student_count: 0, students: [], classes: [], pagination: { page: 1, limit: input.limit, total: 0, totalPages: 1 } };
    if (!yearId) return empty;
    const { scheduleComplete, totalCents, students } = listAgingBucketStudents(await this.repository.listInstallmentLedger(yearId), input.bucket);
    if (!scheduleComplete) return { ...empty, schedule_complete: false };
    const identities = new Map((await this.repository.listStudentAgingIdentities(yearId, students.map((item) => item.studentId))).map((row) => [row.student_id, row]));
    const fold = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const term = input.search ? fold(input.search) : null;
    const rows = students.flatMap((item) => {
      const identity = identities.get(item.studentId);
      if (!identity) return [];
      return [{
        student_id: item.studentId, first_name: identity.first_name, last_name: identity.last_name, matricule: identity.matricule,
        class_id: identity.class_id, class_name: identity.class_name, remaining_amount: (item.amountCents / 100).toFixed(2), days_late: item.daysLate,
        oldest_due_date: item.oldestDueDate, last_payment_date: identity.last_payment_date,
      }];
    });
    // Classes présentes dans la tranche (indépendantes de la recherche et du filtre de classe) pour alimenter le filtre.
    const classes = [...new Map(rows.map((row) => [row.class_id, row.class_name])).entries()]
      .map(([id, name]) => ({ id, name })).sort((first, second) => first.name.localeCompare(second.name, 'fr'));
    const filtered = rows.filter((row) => !input.classId || row.class_id === input.classId).filter((row) => !term || fold(`${row.first_name} ${row.last_name} ${row.last_name} ${row.first_name} ${row.matricule ?? ''} ${row.class_name}`).includes(term))
      .sort((first, second) => second.days_late - first.days_late || Number(second.remaining_amount) - Number(first.remaining_amount) || first.last_name.localeCompare(second.last_name, 'fr'));
    const totalPages = Math.max(1, Math.ceil(filtered.length / input.limit));
    const page = Math.min(input.page, totalPages);
    return {
      bucket: input.bucket,
      // Chiffres de la tranche (indépendants de la recherche) : identiques à ceux du tableau de bord.
      total_amount: (totalCents / 100).toFixed(2),
      student_count: students.length,
      schedule_complete: true,
      classes,
      students: filtered.slice((page - 1) * input.limit, page * input.limit),
      pagination: { page, limit: input.limit, total: filtered.length, totalPages },
    };
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
