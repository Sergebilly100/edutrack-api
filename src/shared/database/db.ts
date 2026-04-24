import 'dotenv/config';

import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

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

export const acquireTenantDb = async (
  schemaName: string
): Promise<{ db: TenantDb; release: () => void }> => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schemaName)) {
    throw new Error(`[db] Invalid schema name: "${schemaName}"`);
  }

  const client = await pool.connect();
  await client.query(`SET search_path TO "${schemaName}", public`);

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
