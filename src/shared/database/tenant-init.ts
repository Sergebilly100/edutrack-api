import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

import { databaseUrl, db } from './db.js';

const DEFAULT_ROOMS = ['Salle A1', 'Salle A2', 'Salle A3', 'Salle des profs'] as const;

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

const runTenantMigrations = async (
  schemaName: string,
  injectedDatabaseUrl: string
): Promise<void> => {
  const migrationPool = new Pool({ connectionString: injectedDatabaseUrl });
  const client = await migrationPool.connect();

  try {
    console.info('[tenant-init] Running tenant migrations', { schemaName });
    await client.query(`SET search_path TO "${schemaName}", public`);

    await migrate(drizzle(client), {
      migrationsFolder: path.resolve(process.cwd(), 'src/shared/database/migrations'),
    });

    await client.query('SET search_path TO public');
    console.info('[tenant-init] Tenant migrations completed', { schemaName });
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
