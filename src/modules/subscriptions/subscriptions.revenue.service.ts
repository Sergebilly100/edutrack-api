import type { TenantDb } from '../../shared/database/db.js';
import EventEmitter from 'events';
import { buildSubscriptionsRevenueRepository } from './subscriptions.revenue.repository.js';

export const subscriptionRevenueEvents = new EventEmitter();

export type ReverseOverdueEvent = {
  tenantId: string;
  schemaName: string;
  month: string;
  amount: number;
  dueDate: string;
};

export function buildSubscriptionsRevenueService(db: TenantDb) {
  const repository = buildSubscriptionsRevenueRepository(db);

  /**
   * Vérifie les reversements en retard et émet un event si nécessaire
   */
  async function checkAndNotifyOverdueReversals(tenantId: string, schemaName: string) {
    const overdueReversals = await repository.getOverdueReversals(tenantId);

    for (const reversal of overdueReversals) {
      // Récupérer le reversement complet pour vérifier si notification déjà envoyée
      const stats = await repository.getRevenueStatsForMonth(
        reversal.dueDate.slice(0, 7), // Extract YYYY-MM from ISO date
        tenantId
      );

      // Si pas encore notifié, émettre l'event
      if (!stats.isReverseOverdue) {
        continue;
      }

      // Émettre l'event pour déclencher l'envoi SMS
      subscriptionRevenueEvents.emit('reverse.overdue', {
        tenantId,
        schemaName,
        month: reversal.month,
        amount: reversal.amount,
        dueDate: reversal.dueDate,
      } satisfies ReverseOverdueEvent);

      // Marquer comme notifié
      await repository.markReversalNotificationSent(tenantId, reversal.dueDate.slice(0, 7));
    }
  }

  return {
    checkAndNotifyOverdueReversals,
  };
}

export type SubscriptionsRevenueService = ReturnType<typeof buildSubscriptionsRevenueService>;
