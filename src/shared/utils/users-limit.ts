import { sql } from 'drizzle-orm';

import { db } from '../database/db.js';

type TenantPlan = 'essential' | 'pro' | 'establishment';

type TenantLimitRow = {
  max_users: number | null;
  plan: TenantPlan;
};

const getRows = <TRow>(result: unknown): TRow[] => {
  if (typeof result !== 'object' || result === null || !('rows' in result)) {
    return [];
  }

  const rows = (result as { rows?: TRow[] }).rows;
  return Array.isArray(rows) ? rows : [];
};

const PLAN_MAX_USERS: Record<TenantPlan, number> = {
  essential: 5,
  pro: 20,
  establishment: 50,
};

export const getDefaultMaxUsersForPlan = (plan: TenantPlan): number => PLAN_MAX_USERS[plan];

export const buildUsersLimitReachedMessage = (currentCount: number, maxUsers: number): string => {
  return `Limite d'utilisateurs atteinte (${currentCount}/${maxUsers}). Contactez EduTrack CI pour augmenter votre quota.`;
};

export const getMaxUsersBySchemaName = async (schemaName: string): Promise<number> => {
  const result = await db.execute<TenantLimitRow>(sql`
    SELECT max_users, plan
    FROM public.tenants
    WHERE schema_name = ${schemaName}
    LIMIT 1
  `);

  const tenant = getRows<TenantLimitRow>(result)[0];
  if (!tenant) {
    throw new Error('Tenant not found');
  }

  if (typeof tenant.max_users === 'number' && tenant.max_users > 0) {
    return tenant.max_users;
  }

  return getDefaultMaxUsersForPlan(tenant.plan);
};
