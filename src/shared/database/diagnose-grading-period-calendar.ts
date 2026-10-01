/** Read-only report to run before the tenant-wide review date migration. */
import 'dotenv/config';
import { Pool } from 'pg';
import { validatePeriodSequence } from '../../modules/academic/grading-period-capabilities.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const pool = new Pool({ connectionString: databaseUrl });
const excluded = new Set(['public', 'tenant', 'drizzle', 'information_schema', 'pg_catalog', 'pg_toast']);

try {
  const schemas = (await pool.query<{ schema_name: string }>(
    "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT LIKE 'pg_%' ORDER BY schema_name"
  )).rows.map((row) => row.schema_name).filter((name) => !excluded.has(name));

  for (const schema of schemas) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid tenant schema name');
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL search_path TO "${schema}", public`);
      const hasColumn = (await client.query<{ present: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'grading_periods' AND column_name = 'review_start_date') AS present`,
        [schema]
      )).rows[0]?.present ?? false;
      const periods = (await client.query<{
        id: string; school_year_id: string; order_index: number; start_date: string; end_date: string; review_start_date?: string;
      }>(`SELECT id::text, school_year_id::text, order_index, start_date::text, end_date::text${hasColumn ? ', review_start_date::text' : ''} FROM grading_periods ORDER BY school_year_id, order_index`)).rows;
      const byYear = new Map<string, typeof periods>();
      for (const period of periods) byYear.set(period.school_year_id, [...(byYear.get(period.school_year_id) ?? []), period]);
      const inconsistencies = [...byYear.entries()].flatMap(([schoolYearId, items]) => {
        const error = validatePeriodSequence(items.map((item) => ({
          orderIndex: item.order_index, startDate: item.start_date,
          reviewStartDate: item.review_start_date ?? item.end_date, endDate: item.end_date,
        })));
        return error ? [{ schoolYearId, periodIds: items.map((item) => item.id), reason: error }] : [];
      });
      const classesWithCards = (await client.query<{ class_id: string; grading_period_id: string }>(
        "SELECT DISTINCT class_id::text, grading_period_id::text FROM report_cards WHERE status IN ('generated', 'published') ORDER BY grading_period_id, class_id"
      )).rows;
      console.log(JSON.stringify({ schema, periodsWithoutReviewDate: periods.filter((p) => !p.review_start_date).map((p) => p.id), inconsistencies, classesWithCards }));
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}
