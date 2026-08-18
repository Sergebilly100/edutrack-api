import { sql } from 'drizzle-orm';

import { getSharedRedis } from '../../shared/queue/shared-redis.js';
import type { TenantDb } from '../../shared/database/db.js';
import { ensureAdminPublicInfrastructure } from './admin.infrastructure.service.js';

type MaintenanceConfigRow = {
  maintenance_mode: boolean;
  maintenance_message: string;
  updated_at: string;
};

export const getMaintenanceConfig = async (
  publicDb: TenantDb
): Promise<{
  maintenanceMode: boolean;
  maintenanceMessage: string;
  updatedAt: string;
}> => {
  await ensureAdminPublicInfrastructure(publicDb);
  const result = await publicDb.execute<MaintenanceConfigRow>(sql`
    SELECT maintenance_mode, maintenance_message, updated_at::text
    FROM public.app_settings
    ORDER BY updated_at DESC
    LIMIT 1
  `);
  const row = result.rows[0];
  return {
    maintenanceMode: row?.maintenance_mode ?? false,
    maintenanceMessage: row?.maintenance_message ?? 'Mise à jour en cours',
    updatedAt: row?.updated_at ?? new Date().toISOString(),
  };
};

export const updateMaintenanceConfig = async (
  publicDb: TenantDb,
  payload: { maintenance_mode: boolean; maintenance_message: string }
): Promise<void> => {
  await ensureAdminPublicInfrastructure(publicDb);
  await publicDb.execute(sql`
    UPDATE public.app_settings
    SET maintenance_mode = ${payload.maintenance_mode},
        maintenance_message = ${payload.maintenance_message},
        updated_at = NOW()
  `);
};

export const clearAdminCache = async (): Promise<void> => {
  await getSharedRedis().flushdb('ASYNC');
};
