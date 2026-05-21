import { withTenantSchema } from '../../shared/database/db.js';
import { buildAttendanceService } from './attendance.service.js';

/**
 * Marque comme absents tous les enseignants n'ayant pas pointé après la fin
 * de leur créneau + 15 min. Appelé via un job BullMQ cron (toutes les 15 min
 * pendant les heures scolaires) — jamais depuis un GET HTTP.
 */
export const runAbsenceMarkingForSchema = async (params: {
  schemaName: string;
}): Promise<{ marked: number }> => {
  const marked = await withTenantSchema(params.schemaName, async (tenantDb) => {
    const service = buildAttendanceService(tenantDb);
    return service.markMissingAttendancesAsAbsent();
  });
  return { marked };
};
