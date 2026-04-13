import 'dotenv/config';

import { drizzle } from 'drizzle-orm/node-postgres';
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

/**
 * Exécute `callback` avec une instance Drizzle dont le search_path est
 * positionné sur `schemaName`. La connexion est libérée après la callback.
 *
 * Règle AGENTS.md §3 : toute query tenant DOIT passer par ce wrapper —
 * jamais de `db` global pour des données école.
 */
export const withTenantSchema = async <T>(
  schemaName: string,
  callback: (tenantDb: ReturnType<typeof drizzle>) => Promise<T>
): Promise<T> => {
  // Validation stricte : schéma PostgreSQL = lettres minuscules, chiffres, underscore
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schemaName)) {
    throw new Error(`[db] Invalid schema name: "${schemaName}"`);
  }

  const client = await pool.connect();
  try {
    // Identifiant entre guillemets doubles pour éviter toute injection SQL
    await client.query(`SET search_path TO "${schemaName}", public`);
    const tenantDb = drizzle(client);
    return await callback(
      tenantDb as unknown as ReturnType<typeof drizzle>
    );
  } finally {
    client.release();
  }
};
