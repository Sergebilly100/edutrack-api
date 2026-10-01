import type { PoolClient } from 'pg';
import { sql } from 'drizzle-orm';
import type { TenantDb } from './db.js';

const requiredColumns = ['conduct_decision_mode', 'conduct_coefficient'];
const requiredTables = ['conduct_grade_audit', 'conduct_policy_audit'];
const requiredConstraints = [
  'conduct_grade_audit_conduct_grade_id_conduct_grades_id_fk',
  'conduct_grade_audit_changed_by_user_id_users_id_fk',
  'conduct_policy_audit_school_year_id_school_years_id_fk',
  'conduct_policy_audit_changed_by_user_id_users_id_fk',
  'school_years_conduct_mode',
  'school_years_conduct_coefficient_positive',
];

export const isMissingConductMigration = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: string; cause?: unknown };
  return candidate.code === '42703' || candidate.code === '42P01' || candidate.code === 'CONDUCT_MIGRATION_REQUIRED'
    || isMissingConductMigration(candidate.cause);
};

export async function assertConductMigrationContract(db: TenantDb): Promise<void> {
  const result = await db.execute<{ ready: boolean }>(sql`
    SELECT
      (SELECT COUNT(*) = 2 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'school_years'
         AND column_name IN ('conduct_decision_mode', 'conduct_coefficient')
         AND is_nullable = 'NO' AND column_default IS NOT NULL)
      AND (SELECT COUNT(*) = 2 FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name IN ('conduct_grade_audit', 'conduct_policy_audit'))
      AND (SELECT COUNT(*) = 6 FROM pg_constraint con
       INNER JOIN pg_namespace ns ON ns.oid = con.connamespace
       WHERE ns.nspname = current_schema() AND con.conname IN (
         'conduct_grade_audit_conduct_grade_id_conduct_grades_id_fk',
         'conduct_grade_audit_changed_by_user_id_users_id_fk',
         'conduct_policy_audit_school_year_id_school_years_id_fk',
         'conduct_policy_audit_changed_by_user_id_users_id_fk',
         'school_years_conduct_mode',
         'school_years_conduct_coefficient_positive'
       )) AS ready
  `);
  if (result.rows[0]?.ready !== true) {
    const error = new Error('Migration de conduite requise pour cette école') as Error & { code: string; statusCode: number };
    error.code = 'CONDUCT_MIGRATION_REQUIRED';
    error.statusCode = 503;
    throw error;
  }
}

export async function verifyConductMigrationContract(client: PoolClient, schema: string): Promise<void> {
  const columns = await client.query<{ column_name: string; column_default: string | null; is_nullable: string }>(
    `SELECT column_name, column_default, is_nullable FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = 'school_years' AND column_name = ANY($2::text[])`,
    [schema, requiredColumns],
  );
  const tables = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1 AND table_name = ANY($2::text[])`,
    [schema, requiredTables],
  );
  const constraints = await client.query<{ conname: string }>(
    `SELECT con.conname FROM pg_constraint con
     INNER JOIN pg_namespace ns ON ns.oid = con.connamespace
     WHERE ns.nspname = $1 AND con.conname = ANY($2::text[])`,
    [schema, requiredConstraints],
  );
  const validColumns = requiredColumns.every((name) => {
    const column = columns.rows.find((item) => item.column_name === name);
    return column?.is_nullable === 'NO' && Boolean(column.column_default);
  });
  if (!validColumns || !requiredTables.every((name) => tables.rows.some((item) => item.table_name === name))
    || !requiredConstraints.every((name) => constraints.rows.some((item) => item.conname === name))) {
    throw new Error(`CONDUCT_MIGRATION_CONTRACT_FAILED: ${schema}`);
  }
}
