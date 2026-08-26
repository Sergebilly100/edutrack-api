import { withTenantSchema } from '../../shared/database/db.js';
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

    return buildDashboardActionsService(tenantDb).generateAll({
      weeklyAbsenceCount,
      salaryPendingCount: (salaryAlerts?.count ?? 0),
      pendingValidations: pending.total,
      commissionOverdueCount,
    });
  });
};
