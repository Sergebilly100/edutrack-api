import { PERMISSION_KEYS } from './permissions.types.js';

export const PERMISSION_CATALOGUE_VERSION = 1 as const;
type CatalogueKey = (typeof PERMISSION_KEYS)[number];

const DOMAINS = {
  teachers: 'Professeurs', students: 'Élèves', schedule: 'Emploi du temps',
  attendance: 'Présences', salary: 'Salaires', validations: 'Validations horaires',
  rooms: 'Salles et QR codes', school_years: 'Années scolaires',
  class_decisions: 'Décisions de fin d’année', conduct: 'Conduite',
  enrollments: 'Inscriptions', tuition: 'Frais scolaires', payments: 'Paiements',
  risk_alerts: 'Alertes de risque', financial_alerts: 'Alertes financières',
  subscription_plans: 'Plans d’abonnement', classes: 'Classes et niveaux',
  report_cards: 'Bulletins', import: 'Imports', positions: 'Postes et utilisateurs',
  evaluations: 'Évaluations et notes',
  school: 'Paramètres école', sms_templates: 'Modèles SMS', subscriptions: 'Abonnements parents',
} as const;

type Definition = { domain: keyof typeof DOMAINS; label: string };

// Record exhaustif : ajouter une clé dans PERMISSION_KEYS sans son libellé
// provoque une erreur TypeScript. Les lignes exposées sont issues de PERMISSION_KEYS.
const DEFINITIONS = {
  'teachers.view': { domain: 'teachers', label: 'Voir les professeurs' },
  'teachers.create': { domain: 'teachers', label: 'Créer un professeur' },
  'teachers.edit': { domain: 'teachers', label: 'Modifier les professeurs' },
  'teachers.block': { domain: 'teachers', label: 'Bloquer un professeur' },
  'teachers.documents': { domain: 'teachers', label: 'Gérer les documents des professeurs' },
  'teachers.ranking.view': { domain: 'teachers', label: 'Voir le classement des professeurs' },
  'teachers.attendance.view': { domain: 'teachers', label: 'Analyser les présences et absences des professeurs' },
  'teachers.password.reset': { domain: 'teachers', label: 'Réinitialiser le mot de passe d’un professeur' },
  'students.view': { domain: 'students', label: 'Voir les élèves' },
  'students.create': { domain: 'students', label: 'Créer un élève' },
  'students.edit': { domain: 'students', label: 'Modifier les élèves' },
  'students.documents': { domain: 'students', label: 'Gérer les documents des élèves' },
  'students.excuse': { domain: 'students', label: 'Excuser une absence d’élève' },
  'schedule.view': { domain: 'schedule', label: 'Voir l’emploi du temps' },
  'schedule.edit': { domain: 'schedule', label: 'Modifier l’emploi du temps' },
  'attendance.view': { domain: 'attendance', label: 'Voir les présences' },
  'attendance.mark_students': { domain: 'attendance', label: 'Marquer les présences des élèves' },
  'salary.view': { domain: 'salary', label: 'Voir les salaires' },
  'salary.compute': { domain: 'salary', label: 'Calculer les salaires' },
  'salary.mark_paid': { domain: 'salary', label: 'Marquer un salaire comme payé' },
  'salary.export': { domain: 'salary', label: 'Exporter les salaires' },
  'validations.view': { domain: 'validations', label: 'Voir les présences à valider' },
  'validations.approve': { domain: 'validations', label: 'Valider une présence' },
  'validations.reject': { domain: 'validations', label: 'Refuser une présence' },
  'rooms.view': { domain: 'rooms', label: 'Voir les salles' },
  'rooms.create': { domain: 'rooms', label: 'Créer une salle' },
  'rooms.edit': { domain: 'rooms', label: 'Modifier les salles' },
  'rooms.delete': { domain: 'rooms', label: 'Supprimer une salle' },
  'school_years.view': { domain: 'school_years', label: 'Voir les années scolaires' },
  'school_years.edit': { domain: 'school_years', label: 'Gérer les années scolaires' },
  'class_decisions.view': { domain: 'class_decisions', label: 'Voir les décisions de fin d’année' },
  'class_decisions.validate': { domain: 'class_decisions', label: 'Valider une décision de fin d’année' },
  'conduct.finalize': { domain: 'conduct', label: 'Finaliser les notes de conduite' },
  'enrollments.view': { domain: 'enrollments', label: 'Voir les inscriptions' },
  'enrollments.create': { domain: 'enrollments', label: 'Créer une inscription' },
  'enrollments.edit': { domain: 'enrollments', label: 'Modifier les inscriptions' },
  'enrollments.confirm_payment': { domain: 'enrollments', label: 'Confirmer un paiement d’inscription' },
  'tuition.view': { domain: 'tuition', label: 'Voir les frais scolaires' },
  'tuition.edit': { domain: 'tuition', label: 'Configurer les frais scolaires' },
  'tuition.grant_discount': { domain: 'tuition', label: 'Accorder une remise sur les frais' },
  'payments.view': { domain: 'payments', label: 'Voir les paiements' },
  'payments.record': { domain: 'payments', label: 'Enregistrer un paiement' },
  'payments.cancel': { domain: 'payments', label: 'Annuler un paiement' },
  'risk_alerts.edit': { domain: 'risk_alerts', label: 'Configurer les alertes de risque' },
  'financial_alerts.edit': { domain: 'financial_alerts', label: 'Configurer les alertes financières' },
  'subscription_plans.view': { domain: 'subscription_plans', label: 'Voir les plans d’abonnement' },
  'subscription_plans.edit': { domain: 'subscription_plans', label: 'Gérer les plans d’abonnement' },
  'classes.view': { domain: 'classes', label: 'Voir les classes et niveaux' },
  'classes.create': { domain: 'classes', label: 'Créer une classe' },
  'classes.edit': { domain: 'classes', label: 'Modifier les classes' },
  'classes.delete': { domain: 'classes', label: 'Supprimer une classe' },
  'report_cards.view': { domain: 'report_cards', label: 'Voir les bulletins' },
  'evaluations.view': { domain: 'evaluations', label: 'Consulter les évaluations et notes' },
  'report_cards.publish': { domain: 'report_cards', label: 'Publier les bulletins' },
  'report_cards.published_correction': { domain: 'report_cards', label: 'Autoriser une correction exceptionnelle après publication' },
  'import.students': { domain: 'import', label: 'Importer les élèves' },
  'import.teachers': { domain: 'import', label: 'Importer les professeurs' },
  'import.schedule': { domain: 'import', label: 'Importer l’emploi du temps' },
  'settings.positions': { domain: 'positions', label: 'Gérer les postes et utilisateurs administratifs' },
  'settings.school': { domain: 'school', label: 'Gérer les informations de l’école' },
  'settings.sms_templates': { domain: 'sms_templates', label: 'Modifier les modèles SMS' },
  'subscriptions.view': { domain: 'subscriptions', label: 'Voir les abonnements parents' },
  'subscriptions.create': { domain: 'subscriptions', label: 'Créer un abonnement parent' },
  'subscriptions.edit': { domain: 'subscriptions', label: 'Modifier un abonnement parent' },
  'subscriptions.renew': { domain: 'subscriptions', label: 'Renouveler un abonnement parent' },
  'subscriptions.cancel': { domain: 'subscriptions', label: 'Annuler un abonnement parent' },
  'subscriptions.password.reset': { domain: 'subscriptions', label: 'Réinitialiser le mot de passe d’un parent' },
  'subscriptions.revenue': { domain: 'subscriptions', label: 'Voir les revenus et commissions des abonnements' },
} as const satisfies Record<CatalogueKey, Definition>;

export type ActivationFeatures = {
  canEditSmsTemplate: boolean;
  smsEnabled: boolean;
  monetizeParentAlerts: boolean;
};

const ACTIVATION_LABELS = {
  canEditSmsTemplate: 'Édition des modèles SMS autorisée par IvoirEdu',
  smsEnabled: 'Service Alertes Parents activé par IvoirEdu',
  monetizeParentAlerts: 'Monétisation des alertes parents activée pour cette école',
} as const;

const ACTIVATION_REASONS = {
  canEditSmsTemplate: 'L’édition des modèles SMS doit être activée par IvoirEdu.',
  smsEnabled: 'Le service Alertes Parents doit être activé par IvoirEdu.',
  monetizeParentAlerts: 'La monétisation des alertes parents doit être activée pour cette école.',
} as const;

// Dépendances de lecture déjà appliquées par la matrice existante. Elles guident
// seulement une sélection explicite ; aucun rôle enregistré n’est normalisé.
const VIEW_ACTIONS = new Set([
  'create', 'edit', 'delete', 'block', 'documents', 'ranking.view', 'attendance.view',
  'password.reset', 'excuse', 'compute', 'mark_paid', 'export', 'approve', 'reject',
  'validate', 'confirm_payment', 'renew', 'cancel', 'revenue', 'mark_students',
  'publish', 'published_correction', 'grant_discount', 'record',
]);

export const buildPermissionCatalogue = (features: ActivationFeatures) => ({
  version: PERMISSION_CATALOGUE_VERSION,
  permissions: PERMISSION_KEYS.map((key) => {
    const definition = DEFINITIONS[key];
    const activationKeys: Array<keyof ActivationFeatures> = key === 'settings.sms_templates'
      ? ['canEditSmsTemplate']
      : key.startsWith('subscriptions.') ? ['smsEnabled', 'monetizeParentAlerts'] : [];
    const activationDependencies = activationKeys.map((feature) => ({
      feature, label: ACTIVATION_LABELS[feature], enabled: features[feature],
    }));
    const unavailable = activationDependencies.filter((dependency) => !dependency.enabled);
    const [category, ...action] = key.split('.');
    const viewKey = `${category}.view`;
    const requiredPermissions: CatalogueKey[] = key === 'report_cards.published_correction'
      ? ['report_cards.view', 'report_cards.publish']
      : VIEW_ACTIONS.has(action.join('.'))
        ? PERMISSION_KEYS.filter((candidate) => candidate === viewKey) : [];
    return {
      key,
      domain: definition.domain,
      domainLabel: DOMAINS[definition.domain],
      label: definition.label,
      requiredPermissions,
      activationDependencies,
      available: unavailable.length === 0,
      unavailableReason: unavailable.length ? unavailable.map((dependency) => ACTIVATION_REASONS[dependency.feature]).join(' ') : null,
    };
  }),
});
