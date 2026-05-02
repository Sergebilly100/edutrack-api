import { sql } from 'drizzle-orm';

import { db } from '../database/db.js';

type TenantLimitRow = {
  max_users: number;
  max_admin_positions: number;
};

const getRows = <TRow>(result: unknown): TRow[] => {
  if (typeof result !== 'object' || result === null || !('rows' in result)) {
    return [];
  }

  const rows = (result as { rows?: TRow[] }).rows;
  return Array.isArray(rows) ? rows : [];
};

export const buildUsersLimitReachedMessage = (currentCount: number, maxUsers: number): string => {
  return `Limite d'utilisateurs atteinte (${currentCount}/${maxUsers}). Contactez EduTrack CI pour augmenter votre quota.`;
};

export const getPlanLimitsBySchemaName = async (schemaName: string): Promise<TenantLimitRow> => {
  const result = await db.execute<TenantLimitRow>(sql`
    SELECT pc.max_users, pc.max_admin_positions
    FROM public.plan_catalog pc
    WHERE pc.plan = (
      SELECT plan
      FROM public.tenants
      WHERE schema_name = ${schemaName}
      LIMIT 1
    )
    LIMIT 1
  `);

  const planLimits = getRows<TenantLimitRow>(result)[0];
  if (!planLimits) {
    throw new Error('Tenant not found');
  }

  return planLimits;
};

export const getMaxUsersBySchemaName = async (schemaName: string): Promise<number> => {
  const limits = await getPlanLimitsBySchemaName(schemaName);
  return limits.max_users;
};
