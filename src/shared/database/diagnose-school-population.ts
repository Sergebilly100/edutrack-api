import 'dotenv/config';

import { Pool } from 'pg';
import { POPULATION_DIAGNOSTIC_QUERY } from './population-diagnostic.query.js';

/** Read-only C24 inventory. No source or derived row is changed. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const schemas = args.filter((arg) => arg.startsWith('--schema=')).map((arg) => arg.slice('--schema='.length));
  const allActive = args.includes('--all-active');
  const usage = 'population:diagnose -- --schema=school_name|--all-active';
  if (args.includes('--help')) { console.log(usage); return; }
  if (args.some((arg) => !arg.startsWith('--schema=') && arg !== '--all-active')
    || (allActive ? schemas.length !== 0 : schemas.length !== 1)
    || schemas.some((schema) => !/^school_[a-z0-9_]{1,56}$/.test(schema))) {
    throw new Error(`Specify exactly one scope: ${usage}`);
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const tenants = await pool.query<{ schema_name: string }>(
      "SELECT schema_name FROM public.tenants WHERE ($1::text IS NULL AND status = 'active') OR schema_name = $1 ORDER BY schema_name",
      [schemas[0] ?? null]
    );
    if (!allActive && tenants.rows.length !== 1) throw new Error('School not found');
    for (const { schema_name: schema } of tenants.rows) {
      if (!/^school_[a-z0-9_]{1,56}$/.test(schema)) throw new Error('Invalid tenant schema');
      const client = await pool.connect();
      try {
        await client.query('BEGIN READ ONLY');
        await client.query(`SET LOCAL search_path TO "${schema}", public`);
        const audit = await client.query(POPULATION_DIAGNOSTIC_QUERY);
        console.log(JSON.stringify({ schema, mode: 'read-only', years: audit.rows }));
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Population diagnostic failed');
  process.exitCode = 1;
});
