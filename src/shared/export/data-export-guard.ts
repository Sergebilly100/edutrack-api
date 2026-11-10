import { sql } from 'drizzle-orm';

import { db as publicDb } from '../database/db.js';

/**
 * Réglage de l'école `public.tenants.can_export_data` (piloté par le super-administrateur).
 * L'export est autorisé sauf s'il vaut explicitement `false`. Vérifié côté API pour tout export de données.
 */
export const isDataExportAllowed = async (schemaName: string): Promise<boolean> => {
  const result = await publicDb.execute<{ allowed: boolean }>(sql`
    SELECT COALESCE(can_export_data, true) AS allowed FROM public.tenants WHERE schema_name = ${schemaName} LIMIT 1
  `);
  const list = (Array.isArray(result) ? result : (result as { rows?: Array<{ allowed: boolean }> }).rows ?? []) as Array<{ allowed: boolean }>;
  return list[0]?.allowed !== false;
};

export const exportDisabledBody = { error: 'Data export is disabled for this school', code: 'EXPORT_DISABLED', statusCode: 403 } as const;
