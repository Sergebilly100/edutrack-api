import { sql } from 'drizzle-orm';

import { withTenantSchema } from '../../shared/database/db.js';
import type { QueryExecutor } from './attendance.repository.js';

/**
 * Auto-approve les validations géo en attente depuis plus de 7 jours
 *
 * SÉRIEUX FIX : Évite les heures payées bloquées indéfiniment
 * Job appelé quotidiennement par le scheduler
 */

const AUTO_APPROVE_AFTER_DAYS = 7;

export const autoApproveOldGeoValidations = async (
  db: QueryExecutor,
  schemaName: string
): Promise<number> => {
  const result = await db.execute<{ count: string | number }>(sql`
    WITH updated AS (
      UPDATE attendances_teacher
      SET
        validation_status = 'approved',
        geo_status = 'verified'
      WHERE validation_status = 'pending'
        AND geo_status = 'suspicious'
        AND checked_in_at < (NOW() - INTERVAL '${sql.raw(String(AUTO_APPROVE_AFTER_DAYS))} days')
      RETURNING id
    )
    SELECT COUNT(*)::int AS count FROM updated
  `);

  const count = Number(result.rows[0]?.count ?? 0);

  if (count > 0) {
    console.log(`[geo-auto-approve] approved ${count} validations for schema ${schemaName}`);
  }

  return count;
};

export const runGeoAutoApproveForAllTenants = async (): Promise<void> => {
  const tenantsResult = await withTenantSchema('public', async (publicDb) => {
    return publicDb.execute<{ schema_name: string }>(sql`
      SELECT schema_name
      FROM tenants
      WHERE is_active = true
      ORDER BY schema_name ASC
    `);
  });

  const tenants = tenantsResult.rows;

  for (const tenant of tenants) {
    try {
      await withTenantSchema(tenant.schema_name, async (tenantDb) => {
        await autoApproveOldGeoValidations(tenantDb, tenant.schema_name);
      });
    } catch (error) {
      console.error(
        `[geo-auto-approve] failed for tenant ${tenant.schema_name}`,
        error
      );
    }
  }
};
