/**
 * Script to apply pending migrations to all existing tenant schemas.
 * Run after adding new migrations: npx tsx src/shared/database/migrate-all-tenants.ts
 */
import 'dotenv/config';

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { Pool } from 'pg';
import { findMatriculeCollisions } from './matricule-collisions.js';
import { verifyConductMigrationContract } from './conduct-migration-contract.js';
import { unresolvedScheduleSubjects } from './schedule-subject-migration-report.js';
import { shouldApplyFinancialWaiverMigration } from './financial-waiver-migration.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
const fromMigration = process.argv.find((argument) => argument.startsWith('--from='))?.slice('--from='.length);
if (fromMigration && !/^\d{4}$/.test(fromMigration)) throw new Error('INVALID_MIGRATION_FROM');

const EXCLUDED_SCHEMAS = new Set([
  'public',
  'information_schema',
  'pg_catalog',
  'pg_toast',
  'drizzle',
  'tenant',
]);

const getExistingTenantSchemas = async (pool: Pool): Promise<string[]> => {
  const result = await pool.query<{ schema_name: string }>(
    `SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT LIKE 'pg_%' ORDER BY schema_name`
  );
  return result.rows
    .map((r) => r.schema_name)
    .filter((name) => !EXCLUDED_SCHEMAS.has(name));
};

const runMigrationsForSchema = async (pool: Pool, schemaName: string): Promise<void> => {
  const client = await pool.connect();
  try {
    const migrationsFolder = path.resolve(process.cwd(), 'src/shared/database/migrations');
    const migrationFiles = (await readdir(migrationsFolder))
      .filter((file) => /^(000[1-9]\d*|00[1-9]\d*|0[1-9]\d*|[1-9]\d*)_.*\.sql$/.test(file))
      .filter((file) => !fromMigration || file.slice(0, 4) >= fromMigration)
      .sort();

    for (const migrationFile of migrationFiles) {
      if (migrationFile === '0079_matricule_normalized_unique.sql') {
        const collisions = await findMatriculeCollisions(client, schemaName);
        if (collisions.length > 0) {
          // Only UUIDs and population names are emitted, never matricules or names.
          throw new Error(`Matricule collisions in ${schemaName}: ${JSON.stringify(collisions)}. Resolve each UUID group before retrying.`);
        }
      }
      const migrationPath = path.join(migrationsFolder, migrationFile);
      const content = await readFile(migrationPath, 'utf-8');

      const schemaAwareSql = content
        .replace(/CREATE SCHEMA "tenant";/g, `CREATE SCHEMA IF NOT EXISTS "${schemaName}";`)
        .replace(/"tenant"/g, `"${schemaName}"`);

      const statements = schemaAwareSql
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      // C44 remplace l'ancienne identité élève/année des lignes par un accord.
      // Lors d'un replay idempotent, ne rejouons pas la migration historique qui
      // tenterait de recréer son index sur des colonnes désormais supprimées.
      if (migrationFile === '0071_student_tuition_schedule_steps.sql') {
        const hasLegacyColumns = await client.query<{ table_exists: boolean; legacy_exists: boolean }>(`
          SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'student_tuition_schedule_steps') AS table_exists,
                 EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'student_tuition_schedule_steps' AND column_name = 'student_id') AS legacy_exists
        `, [schemaName]);
        if (hasLegacyColumns.rows[0]?.table_exists && !hasLegacyColumns.rows[0]?.legacy_exists) continue;
      }

      if (migrationFile === '0090_finance_drop_payment_status_index.sql') {
        await client.query('BEGIN');
        try {
          const state = await client.query<{ has_index: boolean; has_old_status: boolean }>(
            `SELECT
               EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = $2) AS has_index,
               EXISTS (
                 SELECT 1 FROM pg_type t
                 JOIN pg_namespace n ON n.oid = t.typnamespace
                 JOIN pg_enum e ON e.enumtypid = t.oid
                 WHERE n.nspname = $1 AND t.typname = 'finance_payment_status' AND e.enumlabel = 'waived_by_school'
               ) AS has_old_status`,
            [schemaName, 'idx_payments_confirmed_student_year']
          );
          if (state.rows[0]?.has_index && state.rows[0]?.has_old_status) {
            for (const statement of statements) await client.query(statement);
            await client.query('COMMIT');
          } else {
            await client.query('ROLLBACK');
          }
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
        continue;
      }

      if (migrationFile === '0091_finance_remove_waivers.sql') {
        await client.query('BEGIN');
        try {
          if (!(await shouldApplyFinancialWaiverMigration(client, schemaName))) {
            await client.query('ROLLBACK');
            continue;
          }
          for (const statement of statements) await client.query(statement);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
        continue;
      }

      if (migrationFile === '0093_student_tuition_schedule_agreements.sql') {
        const state = await client.query<{ agreement_exists: boolean; legacy_columns_exist: boolean }>(`
          SELECT
            EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'student_tuition_schedule_agreements') AS agreement_exists,
            EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'student_tuition_schedule_steps' AND column_name = 'student_id') AS legacy_columns_exist
        `, [schemaName]);
        if (state.rows[0]?.agreement_exists && !state.rows[0]?.legacy_columns_exist) continue;
        await client.query('BEGIN');
        try {
          for (const statement of statements) await client.query(statement);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
        continue;
      }

      for (const statement of statements) {
        try {
          await client.query(statement);
        } catch (error) {
          const pgError = error as { code?: string };
          // Ignore: duplicate schema/table/type/column, cannot drop columns from view
          const ignoredCodes = new Set(['42P06', '42P07', '42710', '42701', '42P16']);
          if (pgError.code && ignoredCodes.has(pgError.code)) continue;
          throw error;
        }
      }
    }
    await verifyConductMigrationContract(client, schemaName);
    const unresolved = await unresolvedScheduleSubjects(client, schemaName);
    if (unresolved.length > 0) {
      console.warn(JSON.stringify({ tenant: schemaName, unresolvedSchedules: unresolved }));
    }
    console.log(`Conduct migration contract verified: ${schemaName}`);
  } finally {
    client.release();
  }
};

const main = async (): Promise<void> => {
  const pool = new Pool({ connectionString: DATABASE_URL });

  try {
    const schemas = await getExistingTenantSchemas(pool);
    console.log(`Found ${schemas.length} tenant schema(s):`, schemas);

    const migrationsFolder = path.resolve(process.cwd(), 'src/shared/database/migrations');
    const hasC43Migration = (await readdir(migrationsFolder)).includes('0091_finance_remove_waivers.sql')
      && (!fromMigration || '0091' >= fromMigration);
    if (hasC43Migration) {
      for (const schema of schemas) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN READ ONLY');
          await shouldApplyFinancialWaiverMigration(client, schema);
          await client.query('ROLLBACK');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      }
      console.log('C43 global preflight passed for all tenant schemas.');
    }

    for (const schema of schemas) {
      process.stdout.write(`Migrating ${schema}... `);
      await runMigrationsForSchema(pool, schema);
      console.log('done');
    }

    console.log('All tenants migrated successfully.');
  } finally {
    await pool.end();
  }
};

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
