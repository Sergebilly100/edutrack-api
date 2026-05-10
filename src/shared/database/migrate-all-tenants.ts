/**
 * Script to apply pending migrations to all existing tenant schemas.
 * Run after adding new migrations: npx tsx src/shared/database/migrate-all-tenants.ts
 */
import 'dotenv/config';

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

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
      .sort();

    for (const migrationFile of migrationFiles) {
      const migrationPath = path.join(migrationsFolder, migrationFile);
      const content = await readFile(migrationPath, 'utf-8');

      const schemaAwareSql = content
        .replace(/CREATE SCHEMA "tenant";/g, `CREATE SCHEMA IF NOT EXISTS "${schemaName}";`)
        .replace(/"tenant"/g, `"${schemaName}"`);

      const statements = schemaAwareSql
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

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
  } finally {
    client.release();
  }
};

const main = async (): Promise<void> => {
  const pool = new Pool({ connectionString: DATABASE_URL });

  try {
    const schemas = await getExistingTenantSchemas(pool);
    console.log(`Found ${schemas.length} tenant schema(s):`, schemas);

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
