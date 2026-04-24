import 'dotenv/config';

import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('[db] DATABASE_URL environment variable is required');
}
export const databaseUrl = DATABASE_URL;

const pool = new Pool({ connectionString: DATABASE_URL });

pool.on('error', (err) => {
  console.error('[db] Unexpected PostgreSQL pool error:', err);
  process.exit(1);
});

export const db = drizzle(pool);
export type TenantDb = NodePgDatabase<Record<string, unknown>>;

const tenantSchemaCompatInFlight = new Map<string, Promise<void>>();

const ensureTenantSchemaCompatibility = async (
  schemaName: string,
  client: PoolClient
): Promise<void> => {
  const existing = tenantSchemaCompatInFlight.get(schemaName);
  if (existing) {
    await existing;
    return;
  }

  const ensurePromise = (async () => {
    const schema = `"${schemaName}"`;

    await client.query(`
      ALTER TABLE ${schema}.schedules
      ADD COLUMN IF NOT EXISTS end_date date
    `);

    await client.query(`
      ALTER TABLE ${schema}.schedules
      DROP CONSTRAINT IF EXISTS schedules_period_teacher_slot_day_unique
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS schedules_period_teacher_slot_day_active_unique
      ON ${schema}.schedules (schedule_period_id, teacher_id, time_slot_id, day_of_week)
      WHERE is_active = true
        AND end_date IS NULL
    `);
  })();

  tenantSchemaCompatInFlight.set(schemaName, ensurePromise);

  try {
    await ensurePromise;
  } finally {
    tenantSchemaCompatInFlight.delete(schemaName);
  }
};

export const acquireTenantDb = async (
  schemaName: string
): Promise<{ db: TenantDb; release: () => void }> => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schemaName)) {
    throw new Error(`[db] Invalid schema name: "${schemaName}"`);
  }

  const client = await pool.connect();
  await client.query(`SET search_path TO "${schemaName}", public`);
  await ensureTenantSchemaCompatibility(schemaName, client);

  return {
    db: drizzle(client) as TenantDb,
    release: () => {
      client.release();
    },
  };
};

/**
 * Exécute `callback` avec une instance Drizzle dont le search_path est
 * positionné sur `schemaName`. La connexion est libérée après la callback.
 *
 * Règle AGENTS.md §3 : toute query tenant DOIT passer par ce wrapper —
 * jamais de `db` global pour des données école.
 */
export const withTenantSchema = async <T>(
  schemaName: string,
  callback: (tenantDb: TenantDb) => Promise<T>
): Promise<T> => {
  const tenant = await acquireTenantDb(schemaName);
  try {
    return await callback(tenant.db);
  } finally {
    tenant.release();
  }
};
