import { withTenantSchema } from '../../shared/database/db.js';
import { DashboardActionsRepository } from './dashboard-actions.repository.js';
import { buildDashboardActionsService } from './dashboard-actions.service.js';

// Composition des sources migrées : les 4 calculs métier restent la propriété
// de leurs modules d'origine, on se contente de les appeler (voir Tâche 7b :
// "appelle-les depuis le nouveau job de génération").
export const runDashboardActionsForSchema = async (params: {
  schemaName: string;
}): Promise<{ generated: number }> => {
  return withTenantSchema(params.schemaName, async (tenantDb) => {
    const { buildAttendanceService } = await import('../attendance/attendance.service.js');
    const { buildBillingService } = await import('../billing/billing.service.js');
    const { buildValidationsService } = await import('../validations/validations.service.js');
    const { SubscriptionsRepository } = await import('../subscriptions/subscriptions.repository.js');
    const { SubscriptionsService } = await import('../subscriptions/subscriptions.service.js');

    const now = new Date();
    const referenceMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

    // 1. Absences profs sur 7 jours : même source que getHistoryForDirector.
    const history = await buildAttendanceService(tenantDb).getHistoryForDirector(7);
    const weeklyAbsenceCount = history.reduce((sum, day) => sum + Number(day.absent ?? 0), 0);

    // 2. Salaires à terminer
    const salaryAlerts = await buildBillingService(tenantDb).getPastUnpaidSalaryAlerts(referenceMonth);

    // 3. Validations en attente
    const pending = await buildValidationsService(tenantDb).countPending();

    // 4. Reversements de commission en retard
    let commissionOverdueCount = 0;
    try {
      const subscriptionsService = new SubscriptionsService(new SubscriptionsRepository(tenantDb));
      const overdue = await subscriptionsService.commissionOverdueAlerts(params.schemaName);
      commissionOverdueCount = Array.isArray(overdue) ? overdue.length : 0;
    } catch {
      commissionOverdueCount = 0;
    }

    // 5. Élèves et professeurs à suivre : même requête que les pages « à suivre » (compteur = résultats).
    const { buildRiskService } = await import('../risk/risk.service.js');
    const riskService = buildRiskService(tenantDb);
    const studentsAtRiskCount = (await riskService.listStudentRisks({ page: 1, limit: 1, atRisk: true, includePayments: true })).pagination.total;
    const teachersAtRiskCount = (await riskService.listTeacherRisks({ page: 1, limit: 1, atRisk: true })).pagination.total;

    // 6. Configuration de l'école : assistant de démarrage + règles et réglages complémentaires.
    const { OnboardingService } = await import('../school/onboarding.service.js');
    const { OnboardingRepository } = await import('../school/onboarding.repository.js');
    const onboarding = await new OnboardingService(new OnboardingRepository(tenantDb as never)).status(params.schemaName);
    const extra = await new DashboardActionsRepository(tenantDb).readConfigState();

    // 7. Décisions de conduite en attente (périmètre complet de la direction).
    let conductPendingStudents = 0;
    let conductPendingClasses = 0;
    try {
      const { buildConductReviewService } = await import('../conduct-review/conduct-review.service.js');
      const workspace = await buildConductReviewService(tenantDb).getDecisionWorkspace({
        userId: '00000000-0000-0000-0000-000000000000', canFinalize: true,
      });
      const open = workspace.decisionScopes.filter((scope) =>
        scope.schoolYearStatus === 'active' && scope.reviewOpen && !scope.isClosed && scope.studentCount > 0 && scope.pendingCount > 0);
      conductPendingStudents = open.reduce((total, scope) => total + scope.pendingCount, 0);
      conductPendingClasses = new Set(open.map((scope) => scope.classId)).size;
    } catch {
      conductPendingStudents = 0;
    }

    return buildDashboardActionsService(tenantDb).generateAll({
      weeklyAbsenceCount,
      salaryPendingCount: (salaryAlerts?.count ?? 0),
      pendingValidations: pending.total,
      commissionOverdueCount,
      studentsAtRiskCount,
      teachersAtRiskCount,
      conductPendingStudents,
      conductPendingClasses,
      config: {
        activeYear: onboarding.activeYear, schoolInfoComplete: onboarding.schoolInfoComplete, levels: onboarding.levels,
        subjects: onboarding.subjects, rooms: onboarding.rooms, fees: onboarding.fees, teachers: onboarding.teachers,
        requiredDocuments: extra.requiredDocuments, scheduleConfigured: extra.scheduleConfigured,
        gradingPeriods: extra.gradingPeriods, reminderRules: extra.reminderRules, riskRules: extra.riskRules,
        hasLogo: extra.hasLogo, hasSeal: extra.hasSeal,
      },
    });
  });
};

// Rafraîchissement à la demande : les items sont recalculés à chaque lecture pour refléter une action
// qui vient d'être effectuée. Les lectures simultanées d'une même école partagent un seul calcul.
const inFlight = new Map<string, Promise<unknown>>();

export const refreshDashboardActionsForSchema = async (schemaName: string): Promise<void> => {
  const running = inFlight.get(schemaName);
  if (running) { await running.catch(() => undefined); return; }
  const job = runDashboardActionsForSchema({ schemaName }).finally(() => inFlight.delete(schemaName));
  inFlight.set(schemaName, job);
  await job;
};
