import { withTenantSchema } from '../../shared/database/db.js';

import { buildAttendanceService } from './attendance.service.js';

// Ce worker est déclenché par un cron quotidien pour détecter les cours du jour qui n'ont pas de scan QR enregistré 15 minutes après l'heure de début prévue du cours,
//  et générer les notifications d'absence pour les élèves inscrits à ces cours (si le pointage est géolocalisé, on vérifie aussi que le prof n'était pas simplement en retard au scan QR, mais bien absent du lieu de cours).
export const runAttendanceMissingQrScanHandler = async (params: {
  schemaName: string;
  date?: string;
}): Promise<number> => {
  return withTenantSchema(params.schemaName, async (tenantDb) => {
    const service = buildAttendanceService(tenantDb);
    return service.detectMissingQrScans({
      schemaName: params.schemaName,
      date: params.date,
    });
  });
};
