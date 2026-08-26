import { withTenantSchema } from '../../shared/database/db.js';
import { buildFinancialCacheService } from './financial-cache.service.js';
import { FinancialAlertsRepository, FinancialAlertsService } from './financial-alerts.service.js';

type MinimalSmsQueue = {
  add: (name: string, data: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>;
};

/**
 * Exécute les relances de paiement pour un schéma tenant :
 * - s'appuie sur le cache financier (6a), sans recalculer les montants ;
 * - envoie les SMS via la queue notifications existante ('send-sms') ;
 * - logue chaque relance dans financial_alert_logs.
 */
export const runFinancialAlertsForSchema = async (params: {
  schemaName: string;
  smsQueue: unknown;
}): Promise<{ sentCount: number; skippedCount: number }> => {
  return withTenantSchema(params.schemaName, async (tenantDb) => {
    // Le lot rafraîchit le cache avant d'évaluer les règles.
    await buildFinancialCacheService(tenantDb).recalcAll();

    const service = new FinancialAlertsService(
      new FinancialAlertsRepository(tenantDb),
      params.smsQueue as unknown as MinimalSmsQueue
    );
    return service.runDailyOnDb(tenantDb, params.schemaName);
  });
};
