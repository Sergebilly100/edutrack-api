import 'dotenv/config';

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { buildFinancialCacheService } from '../../modules/finance/financial-cache.service.js';

/** Dry run by default. Each school's derived caches are rebuilt atomically. */
async function main() {
  const args = process.argv.slice(2);
  const usage = 'finance:recalculate-caches -- --schema=school_demo_t3|--all-active [--apply]';
  if (args.includes('--help')) {
    console.log(usage);
    return;
  }
  const schemas = args.filter((arg) => arg.startsWith('--schema=')).map((arg) => arg.slice(9));
  const allActive = args.includes('--all-active');
  if (args.some((arg) => !arg.startsWith('--schema=') && !['--all-active', '--apply'].includes(arg))
    || (allActive ? schemas.length !== 0 : schemas.length !== 1)
    || schemas.some((schema) => !/^school_[a-z0-9_]{1,56}$/.test(schema))) {
    throw new Error(`Specify exactly one scope: ${usage}`);
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const result = await pool.query<{ schema_name: string }>(
      "SELECT schema_name FROM public.tenants WHERE status = 'active' AND ($1::text IS NULL OR schema_name = $1) ORDER BY schema_name",
      [schemas[0] ?? null]
    );
    if (!allActive && result.rows.length !== 1) throw new Error('Active school not found');
    for (const { schema_name: schema } of result.rows) {
      if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid tenant schema');
      if (!args.includes('--apply')) {
        console.log(`Dry run: ${schema}`);
        continue;
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL search_path TO "${schema}", public`);
        const result = await buildFinancialCacheService(drizzle(client)).recalcAll();
        await client.query('COMMIT');
        console.log(`Recalculated: ${schema} (${result.studentCount} students)`);
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
  console.error(error instanceof Error ? error.message : 'Financial cache recalculation failed');
  process.exitCode = 1;
});
