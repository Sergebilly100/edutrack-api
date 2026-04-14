import { withTenantSchema } from '../../shared/database/db.js';

import { buildAttendanceService } from './attendance.service.js';

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
