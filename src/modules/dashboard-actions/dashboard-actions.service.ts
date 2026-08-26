import { DashboardActionsRepository } from './dashboard-actions.repository.js';
import type { ActionItemPriority } from './dashboard-actions.repository.js';

/** Résultats des 4 sources migrées, injectés depuis le point de composition. */
export type MigratedSources = {
  weeklyAbsenceCount: number;
  salaryPendingCount: number;
  pendingValidations: number;
  commissionOverdueCount: number;
};

export const EMPTY_SOURCES: MigratedSources = {
  weeklyAbsenceCount: 0,
  salaryPendingCount: 0,
  pendingValidations: 0,
  commissionOverdueCount: 0,
};

const WEEKLY_ABSENCE_THRESHOLD = 3; // reprend le seuil du bloc "Priorités du jour" remplacé

export class DashboardActionsService {
  constructor(private readonly repository: DashboardActionsRepository) {}

  async generateAll(sources: Partial<MigratedSources> = {}): Promise<{ generated: number }> {
    const weeklyAbsenceCount = sources.weeklyAbsenceCount ?? 0;
    const salaryPending = sources.salaryPendingCount ?? 0;
    const pendingValidations = sources.pendingValidations ?? 0;
    const commissionOverdue = sources.commissionOverdueCount ?? 0;

    // Migration des 4 cartes "Priorités du jour" (logique source conservée)
    await this.repository.replaceType('teacher_absences_high',
      weeklyAbsenceCount > WEEKLY_ABSENCE_THRESHOLD
        ? [{ referenceId: null, priority: 'high', message: `${weeklyAbsenceCount} absences de professeurs sur les 7 derniers jours` }]
        : []);

    await this.repository.replaceType('salary_pending',
      salaryPending > 0
        ? [{ referenceId: null, priority: 'medium', message: `${salaryPending} fiche(s) de salaire à terminer` }]
        : []);

    await this.repository.replaceType('validations_pending',
      pendingValidations > 0
        ? [{ referenceId: null, priority: 'high', message: `${pendingValidations} décision(s) à prendre sur les pointages` }]
        : []);

    await this.repository.replaceType('commission_overdue',
      commissionOverdue > 0
        ? [{ referenceId: null, priority: 'medium', message: `${commissionOverdue} reversement(s) de commission en retard` }]
        : []);

    // Nouveaux types V2 : lus depuis les tables de risque / complétude / cache
    const riskCounts = await this.repository.countRiskByLevel();
    const atRisk = (riskCounts['warning'] ?? 0) + (riskCounts['critical'] ?? 0);
    await this.repository.replaceType('student_at_risk',
      atRisk > 0
        ? [{ referenceId: null, priority: atRisk >= 5 ? 'high' : 'medium', message: `${atRisk} élève(s) à examiner (niveau warning/critical)` }]
        : []);

    await this.repository.replaceType('teacher_at_risk',
      (riskCounts['critical'] ?? 0) > 0
        ? [{ referenceId: null, priority: 'medium', message: `${riskCounts['critical']} prof(s) au niveau critique` }]
        : []);

    const blocked = await this.repository.listBlockedClasses(10);
    await this.repository.replaceType('report_cards_blocked',
      blocked.map((row) => ({
        referenceId: row.classId,
        priority: 'medium' as ActionItemPriority,
        message: `Bulletins bloqués : ${row.incomplete} matière(s) incomplète(s) en ${row.className}`,
      })));

    await this.repository.replaceType('payment_reminder_needed', []);
    await this.repository.replaceType('dossier_incomplete', []);

    return { generated:
      (weeklyAbsenceCount > WEEKLY_ABSENCE_THRESHOLD ? 1 : 0) +
      (salaryPending > 0 ? 1 : 0) +
      (pendingValidations > 0 ? 1 : 0) +
      (commissionOverdue > 0 ? 1 : 0) +
      (atRisk > 0 ? 1 : 0) +
      ((riskCounts['critical'] ?? 0) > 0 ? 1 : 0) +
      blocked.length,
    };
  }

  listOpen() {
    return this.repository.listOpen();
  }

  resolve(id: string, userId: string) {
    return this.repository.resolve(id, userId);
  }
}

export const buildDashboardActionsService = (
  db: ConstructorParameters<typeof DashboardActionsRepository>[0]
) => new DashboardActionsService(new DashboardActionsRepository(db));
