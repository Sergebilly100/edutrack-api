import { DashboardActionsRepository } from './dashboard-actions.repository.js';
import type { ActionItemPriority } from './dashboard-actions.repository.js';

/** Résultats des 4 sources migrées, injectés depuis le point de composition. */
export type MigratedSources = {
  weeklyAbsenceCount: number;
  salaryPendingCount: number;
  pendingValidations: number;
  commissionOverdueCount: number;
  /** Même définition que la liste « Élèves à suivre » (au moins un signal) : le compteur et la page concordent. */
  studentsAtRiskCount: number;
  teachersAtRiskCount: number;
  conductPendingStudents: number;
  conductPendingClasses: number;
  config: ConfigSources;
};

/** Prérequis de configuration : vrai = configuré. Rassemblés par le point de composition. */
export type ConfigSources = {
  activeYear: boolean; schoolInfoComplete: boolean; levels: boolean; subjects: boolean; rooms: boolean;
  fees: boolean; teachers: boolean; requiredDocuments: boolean; scheduleConfigured: boolean;
  gradingPeriods: boolean; reminderRules: boolean; riskRules: boolean; hasLogo: boolean; hasSeal: boolean;
};

/** Types réservés au directeur (configuration et décisions de conduite). */
export const DIRECTOR_ONLY_ACTION_TYPES: readonly string[] = [
  'conduct_decision_pending', 'config_active_year', 'config_school_info', 'config_levels', 'config_subjects',
  'config_rooms', 'config_fees', 'config_required_documents', 'config_schedule', 'config_grading_periods',
  'config_teachers', 'config_reminder_rules', 'config_risk_rules', 'config_document_identity',
];

export const EMPTY_SOURCES: Pick<MigratedSources, 'weeklyAbsenceCount' | 'salaryPendingCount' | 'pendingValidations' | 'commissionOverdueCount'> = {
  weeklyAbsenceCount: 0,
  salaryPendingCount: 0,
  pendingValidations: 0,
  commissionOverdueCount: 0,
};

type ConfigRule = { type: string; missing: (config: ConfigSources) => boolean; priority: ActionItemPriority; message: (config: ConfigSources) => string };

// Le message est affiché tel quel à l'utilisateur : français courant, sans terme technique.
const CONFIG_RULES: ConfigRule[] = [
  { type: 'config_active_year', missing: (c) => !c.activeYear, priority: 'high', message: () => 'Aucune année scolaire n’est active : contactez l’administration IvoirEdu pour l’ouvrir.' },
  { type: 'config_school_info', missing: (c) => !c.schoolInfoComplete, priority: 'medium', message: () => 'Les informations de l’école (nom, adresse, téléphone) sont incomplètes.' },
  { type: 'config_levels', missing: (c) => !c.levels, priority: 'high', message: () => 'Aucun niveau n’est configuré.' },
  { type: 'config_subjects', missing: (c) => !c.subjects, priority: 'high', message: () => 'Aucune matière n’est configurée.' },
  { type: 'config_rooms', missing: (c) => !c.rooms, priority: 'low', message: () => 'Aucune salle n’est enregistrée.' },
  { type: 'config_fees', missing: (c) => c.activeYear && !c.fees, priority: 'high', message: () => 'Les frais de scolarité ne sont pas configurés pour l’année en cours.' },
  { type: 'config_required_documents', missing: (c) => !c.requiredDocuments, priority: 'medium', message: () => 'Aucun document requis n’est défini pour les inscriptions.' },
  { type: 'config_schedule', missing: (c) => c.activeYear && !c.scheduleConfigured, priority: 'high', message: () => 'Aucun cours n’est planifié dans l’emploi du temps.' },
  { type: 'config_grading_periods', missing: (c) => c.activeYear && !c.gradingPeriods, priority: 'medium', message: () => 'Aucune période de notation n’est configurée pour l’année en cours.' },
  { type: 'config_teachers', missing: (c) => !c.teachers, priority: 'medium', message: () => 'Aucun professeur n’est enregistré.' },
  { type: 'config_reminder_rules', missing: (c) => !c.reminderRules, priority: 'medium', message: () => 'Aucune règle de relance de paiement n’est active.' },
  { type: 'config_risk_rules', missing: (c) => !c.riskRules, priority: 'medium', message: () => 'Aucune règle de suivi des élèves et des professeurs n’est active.' },
  { type: 'config_document_identity', missing: (c) => !c.hasLogo || !c.hasSeal,
    priority: 'low', message: (c) => `${!c.hasLogo && !c.hasSeal ? 'Le logo et le cachet de l’école manquent' : !c.hasLogo ? 'Le logo de l’école manque' : 'Le cachet de l’école manque'} sur les documents (bulletins, reçus).` },
];

const WEEKLY_ABSENCE_THRESHOLD = 3; // reprend le seuil du bloc "Priorités du jour" remplacé
const STUDENT_RISK_PRIORITY_THRESHOLD = 5; // seuil de priorité dashboard : au-delà de 5 élèves en risque, la carte passe en haut de pile

/** Accord simple en français : 1 → singulier, sinon pluriel. */
const plural = (count: number, singular: string, pluralForm = `${singular}s`): string =>
  `${count} ${count > 1 ? pluralForm : singular}`;

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
        ? [{ referenceId: null, priority: 'medium', message: `${plural(salaryPending, 'fiche de salaire')} à terminer` }]
        : []);

    await this.repository.replaceType('validations_pending',
      pendingValidations > 0
        ? [{ referenceId: null, priority: 'high', message: `${plural(pendingValidations, 'décision')} à prendre sur les pointages` }]
        : []);

    await this.repository.replaceType('commission_overdue',
      commissionOverdue > 0
        ? [{ referenceId: null, priority: 'medium', message: `${plural(commissionOverdue, 'reversement')} de commission en retard` }]
        : []);

    // Nouveaux types V2 : lus depuis les tables de risque / complétude / cache
    const riskCounts = await this.repository.countRiskByLevel();
    const atRisk = sources.studentsAtRiskCount ?? ((riskCounts['warning'] ?? 0) + (riskCounts['critical'] ?? 0));
    await this.repository.replaceType('student_at_risk',
      atRisk > 0
        ? [{ referenceId: null, priority: atRisk >= STUDENT_RISK_PRIORITY_THRESHOLD ? 'high' : 'medium', message: `${plural(atRisk, 'élève')} à suivre` }]
        : []);

    const teachersAtRisk = sources.teachersAtRiskCount ?? await this.repository.countTeachersAtRisk();
    await this.repository.replaceType('teacher_at_risk', teachersAtRisk > 0
      ? [{ referenceId: null, priority: 'high', message: `${plural(teachersAtRisk, 'professeur')} à suivre pour leur assiduité` }]
      : []);

    const blocked = await this.repository.listBlockedClasses(10);
    await this.repository.replaceType('report_cards_blocked',
      blocked.map((row) => ({
        referenceId: row.classId,
        priority: 'medium' as ActionItemPriority,
        message: `En ${row.className} (${row.periodLabel}), les moyennes de ${plural(row.incomplete, 'matière')} ne sont pas validées : les bulletins ne peuvent pas être générés. Les professeurs doivent clôturer ces matières.`,
      })));

    if (sources.config) {
      for (const rule of CONFIG_RULES) {
        await this.repository.replaceType(rule.type, rule.missing(sources.config)
          ? [{ referenceId: null, priority: rule.priority, message: rule.message(sources.config) }] : []);
      }
    }
    if (sources.conductPendingStudents !== undefined) {
      const students = sources.conductPendingStudents;
      const classes = sources.conductPendingClasses ?? 0;
      await this.repository.replaceType('conduct_decision_pending', students > 0
        ? [{ referenceId: null, priority: 'medium',
            message: `${plural(students, 'élève attend', 'élèves attendent')} une décision de conduite (${plural(classes, 'classe')}).` }]
        : []);
    }

    await this.repository.replaceType('payment_reminder_needed', []);
    await this.repository.replaceType('dossier_incomplete', []);

    return { generated:
      (weeklyAbsenceCount > WEEKLY_ABSENCE_THRESHOLD ? 1 : 0) +
      (salaryPending > 0 ? 1 : 0) +
      (pendingValidations > 0 ? 1 : 0) +
      (commissionOverdue > 0 ? 1 : 0) +
      (atRisk > 0 ? 1 : 0) +
      (teachersAtRisk > 0 ? 1 : 0) +
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
