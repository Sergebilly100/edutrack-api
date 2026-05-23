import { sql } from 'drizzle-orm';

import { db } from '../database/db.js';
import { cached, cacheDel } from './redis-cache.js';

export type TenantLifecycleStatus = 'trial' | 'active' | 'suspended' | 'cancelled';

type TenantStatusRow = { status: TenantLifecycleStatus };

const TTL_SECONDS = 60;

const buildKey = (schemaName: string): string => `tenant:status:${schemaName}`;

export const getTenantStatus = async (
  schemaName: string
): Promise<TenantLifecycleStatus | null> => {
  return cached<TenantLifecycleStatus | null>(buildKey(schemaName), TTL_SECONDS, async () => {
    const result = await db.execute<TenantStatusRow>(sql`
      SELECT status::text AS status
      FROM public.tenants
      WHERE schema_name = ${schemaName}
      LIMIT 1
    `);
    return result.rows[0]?.status ?? null;
  });
};

export const invalidateTenantStatusCache = async (schemaName: string): Promise<void> => {
  await cacheDel(buildKey(schemaName));
};
