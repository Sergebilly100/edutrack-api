import 'dotenv/config';

import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { logger } from '../observability/logger.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('[db] DATABASE_URL environment variable is required');
}
export const databaseUrl = DATABASE_URL;

const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: parsePositiveInt(process.env.PG_POOL_MAX, 30),
  min: parsePositiveInt(process.env.PG_POOL_MIN, 4),
  idleTimeoutMillis: parsePositiveInt(process.env.PG_IDLE_TIMEOUT_MS, 30_000),
  connectionTimeoutMillis: parsePositiveInt(process.env.PG_CONNECTION_TIMEOUT_MS, 5_000),
  statement_timeout: parsePositiveInt(process.env.PG_STATEMENT_TIMEOUT_MS, 15_000),
  query_timeout: parsePositiveInt(process.env.PG_QUERY_TIMEOUT_MS, 15_000),
});

pool.on('error', (err) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, '[db] Unexpected PostgreSQL pool error');
});

export const getPoolStats = (): {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
} => ({
  totalCount: pool.totalCount,
  idleCount: pool.idleCount,
  waitingCount: pool.waitingCount,
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
