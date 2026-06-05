import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { sql } from 'drizzle-orm';
import { Pool } from 'pg';

import { logger } from '../observability/logger.js';
import { databaseUrl, db } from './db.js';

const DEFAULT_ROOMS = ['Salle A1', 'Salle A2', 'Labo Sciences', 'Salle Langues'] as const;

const DEFAULT_TIME_SLOTS = [
  { label: '7h30 - 9h00', startTime: '07:30', endTime: '09:00', sortOrder: 1 },
  { label: '9h00 - 10h30', startTime: '09:00', endTime: '10:30', sortOrder: 2 },
  { label: '10h30 - 12h00', startTime: '10:30', endTime: '12:00', sortOrder: 3 },
  { label: '12h00 - 13h30', startTime: '12:00', endTime: '13:30', sortOrder: 4 },
  { label: '13h30 - 15h00', startTime: '13:30', endTime: '15:00', sortOrder: 5 },
  { label: '15h00 - 16h30', startTime: '15:00', endTime: '16:30', sortOrder: 6 },
] as const;

const assertValidSchemaName = (schemaName: string): void => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schemaName)) {
    throw new Error(`[tenant-init] Invalid schema name: "${schemaName}"`);
  }
};

const generateQrToken = (): string => randomBytes(32).toString('hex');

// Extrait le nom (éventuellement qualifié par schéma) d'un `CREATE OR REPLACE VIEW`
// déjà passé par la substitution de schéma, ex. `"school_x"."teacher_scan_compliance"`
// ou `view_name`. Renvoie undefined si le statement n'est pas un CREATE OR REPLACE VIEW.
const extractCreateOrReplaceViewName = (statement: string): string | undefined => {
  const match =
    /CREATE\s+OR\s+REPLACE\s+VIEW\s+((?:"[^"]+"|[a-zA-Z_][a-zA-Z0-9_]*)(?:\.(?:"[^"]+"|[a-zA-Z_][a-zA-Z0-9_]*))?)/i.exec(
      statement
    );
  return match?.[1];
};

const runTenantMigrations = async (
  schemaName: string,
  injectedDatabaseUrl: string
): Promise<void> => {
  const migrationPool = new Pool({ connectionString: injectedDatabaseUrl });
  const client = await migrationPool.connect();

  try {
    logger.info({ schemaName }, '[tenant-init] Running tenant migrations');
    const migrationsFolder = path.resolve(process.cwd(), 'src/shared/database/migrations');
    const migrationFiles = (await readdir(migrationsFolder))
      .filter((file) => /^(000[1-9]\d*|00[1-9]\d*|0[1-9]\d*|[1-9]\d*)_.*\.sql$/.test(file))
      .sort();

    for (const migrationFile of migrationFiles) {
      const migrationPath = path.join(migrationsFolder, migrationFile);
      const content = await readFile(migrationPath, 'utf-8');

      const schemaAwareSql = content
        .replace(/CREATE SCHEMA "tenant";/g, `CREATE SCHEMA IF NOT EXISTS "${schemaName}";`)
        .replace(/"tenant"/g, `"${schemaName}"`)
        .replace(/nspname\s*=\s*'tenant'/g, `nspname = '${schemaName}'`);

      const statements = schemaAwareSql
        .split('--> statement-breakpoint')
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0);

      for (const statement of statements) {
        try {
          await client.query(statement);
        } catch (error) {
          const pgError = error as { code?: string };
          const duplicateCodes = new Set(['42P06', '42P07', '42710', '42701']);

          if (pgError.code && duplicateCodes.has(pgError.code)) {
            continue;
          }

          // 42P16 "cannot drop columns from view" : se produit quand on rejoue les
          // migrations sur un schéma existant et qu'un `CREATE OR REPLACE VIEW`
          // redéfinit une vue avec des colonnes différentes (Postgres interdit le
          // REPLACE qui retire/réordonne des colonnes). On droppe alors la vue puis
          // on rejoue la définition — idempotent et sans effet sur un schéma neuf.
          if (pgError.code === '42P16') {
            const viewName = extractCreateOrReplaceViewName(statement);
            if (viewName) {
              await client.query(`DROP VIEW IF EXISTS ${viewName} CASCADE`);
              await client.query(statement);
              continue;
            }
          }

          throw error;
        }
      }
    }

    logger.info({ schemaName }, '[tenant-init] Tenant migrations completed');
  } finally {
    client.release();
    await migrationPool.end();
  }
};

/**
 * Crée le schéma tenant s'il n'existe pas, joue les migrations,
 * puis seed les salles et créneaux horaires de référence.
 */
export const createTenantSchema = async (schemaName: string): Promise<void> => {
  assertValidSchemaName(schemaName);

  await db.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`));

  await runTenantMigrations(schemaName, databaseUrl);

  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL search_path TO "${schemaName}", public`));

    for (const roomName of DEFAULT_ROOMS) {
      await tx.execute(sql`
        INSERT INTO rooms (name, qr_token, is_active)
        VALUES (${roomName}, ${generateQrToken()}, true)
        ON CONFLICT (name) DO NOTHING
      `);
    }

    for (const slot of DEFAULT_TIME_SLOTS) {
      await tx.execute(sql`
        INSERT INTO time_slots (label, start_time, end_time, sort_order)
        VALUES (${slot.label}, ${slot.startTime}, ${slot.endTime}, ${slot.sortOrder})
        ON CONFLICT (label) DO NOTHING
      `);
    }
  });
};
