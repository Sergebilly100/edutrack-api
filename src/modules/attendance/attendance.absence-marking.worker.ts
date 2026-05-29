import { schemaIsProvisioned, withTenantSchema } from '../../shared/database/db.js';
import { logger } from '../../shared/observability/logger.js';
import { buildAttendanceService } from './attendance.service.js';

/**
 * Marque comme absents tous les enseignants n'ayant pas pointé après la fin
 * de leur créneau + 15 min. Appelé via un job BullMQ cron (toutes les 15 min
 * pendant les heures scolaires) — jamais depuis un GET HTTP.
 *
 * Garde défensive : un schéma tenant non provisionné (ligne orpheline dans
 * public.tenants dont le schéma PG n'existe pas / n'est pas migré) est ignoré
 * proprement. Sans cette garde, le job plantait en boucle toutes les 15 min
 * avec « relation "schedule_periods" does not exist ».
 */
export const runAbsenceMarkingForSchema = async (params: {
  schemaName: string;
}): Promise<{ marked: number; skipped?: boolean }> => {
  if (!(await schemaIsProvisioned(params.schemaName))) {
    logger.warn(
      { schemaName: params.schemaName },
      '[absence-marking] schéma tenant non provisionné — job ignoré'
    );
    return { marked: 0, skipped: true };
  }

  const marked = await withTenantSchema(params.schemaName, async (tenantDb) => {
    const service = buildAttendanceService(tenantDb);
    return service.markMissingAttendancesAsAbsent();
  });
  return { marked };
};
