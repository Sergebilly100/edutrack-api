import { sql } from 'drizzle-orm';

import { withTenantSchema } from '../../shared/database/db.js';
import { logger } from '../../shared/observability/logger.js';
import type { QueryExecutor } from './attendance.repository.js';

/**
 * Auto-approve les validations géo en attente depuis plus de 7 jours
 *
 * SÉRIEUX FIX : Évite les heures payées bloquées indéfiniment
 * Job appelé quotidiennement par le scheduler
 */

// la logique d'auto-approbation est définie pour approuver automatiquement les validations géo qui sont en attente depuis plus de 7 jours, en mettant à jour leur statut de validation et de géo, et en retournant le nombre de validations approuvées pour chaque tenant. 
// le but est de s'assurer que les validations géo qui sont restées en attente pendant une période prolongée sont automatiquement approuvées pour éviter les blocages dans le processus de validation et garantir que les heures payées ne restent pas bloquées indéfiniment.

const AUTO_APPROVE_AFTER_DAYS = 7; // Nombre de jours après lesquels les validations géo en attente seront auto-approuvées

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
    logger.info({ count, schemaName }, '[geo-auto-approve] approved pending validations');
  }

  return count;
};

// Job pour tous les tenants, appelé quotidiennement par le scheduler
// et aussi manuellement si besoin pour rattraper les validations en attente
export const runGeoAutoApproveForAllTenants = async (): Promise<void> => {
  const tenantsResult = await withTenantSchema('public', async (publicDb) => { // On utilise le schéma public pour récupérer la liste des tenants actifs, car les informations sur les tenants sont stockées dans ce schéma partagé.  
    return publicDb.execute<{ schema_name: string }>(sql`
      SELECT schema_name
      FROM tenants
      WHERE status = 'active'
      ORDER BY schema_name ASC
    `);
  });

  const tenants = tenantsResult.rows;
  // On itère sur chaque tenant actif pour exécuter la fonction d'auto-approbation des validations géo en attente depuis plus de 7 jours, 
  // en gérant les erreurs pour chaque tenant individuellement afin de ne pas interrompre le processus global en cas de problème avec un tenant spécifique.  
  for (const tenant of tenants) {
    try {
      await withTenantSchema(tenant.schema_name, async (tenantDb) => {
        await autoApproveOldGeoValidations(tenantDb, tenant.schema_name); // Appel de la fonction d'auto-approbation pour le tenant actuel, en passant la base de données spécifique au tenant et son nom de schéma pour les logs.
      });
    } catch (error) {
      logger.error(
        {
          schemaName: tenant.schema_name,
          err: error instanceof Error ? error.message : String(error),
        },
        '[geo-auto-approve] failed for tenant'
      );
    }
  }
};
