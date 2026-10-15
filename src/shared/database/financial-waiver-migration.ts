import type { PoolClient } from 'pg';

const validSchema = (schema: string): boolean => /^[a-z][a-z0-9_]{0,62}$/.test(schema);

/**
 * Confirms the historical values are reconciled before the generated C43 DDL
 * casts both enums. Returns false when the schema already has the target shape.
 */
export async function shouldApplyFinancialWaiverMigration(
  client: PoolClient,
  schema: string
): Promise<boolean> {
  if (!validSchema(schema)) throw new Error('C43_INVALID_TENANT_SCHEMA');
  const types = await client.query<{ typname: string; enumlabel: string }>(`
    SELECT t.typname, e.enumlabel
    FROM pg_type t
    INNER JOIN pg_namespace n ON n.oid = t.typnamespace
    INNER JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE n.nspname = $1 AND t.typname IN ('finance_payment_status', 'financial_cache_status')
    ORDER BY t.typname, e.enumsortorder
  `, [schema]);
  const paymentLabels = types.rows.filter((row) => row.typname === 'finance_payment_status').map((row) => row.enumlabel);
  const cacheLabels = types.rows.filter((row) => row.typname === 'financial_cache_status').map((row) => row.enumlabel);
  const columns = await client.query<{ exists: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'student_financial_status' AND column_name = 'waived_amount'
    ) AS exists
  `, [schema]);
  const hasOldStatus = paymentLabels.includes('waived_by_school');
  const hasOldCacheStatus = cacheLabels.includes('waived');
  const hasOldCacheColumn = columns.rows[0]?.exists === true;
  if (!hasOldStatus && !hasOldCacheStatus && !hasOldCacheColumn) return false;

  const clientSchema = await client.query(`SET LOCAL search_path TO "${schema}", public`);
  void clientSchema;
  const [paymentRows, cacheRows] = await Promise.all([
    client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM payments WHERE status::text = 'waived_by_school'"),
    client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM student_financial_status WHERE status::text = 'waived'"),
  ]);
  const paymentCount = Number(paymentRows.rows[0]?.count ?? 0);
  const cacheCount = Number(cacheRows.rows[0]?.count ?? 0);
  if (paymentCount > 0 || cacheCount > 0) {
    throw new Error(`C43_RECONCILIATION_REQUIRED: ${schema}; waivedPayments=${paymentCount}; waivedCacheRows=${cacheCount}`);
  }
  if (!hasOldStatus || !hasOldCacheStatus || !hasOldCacheColumn) {
    throw new Error(`C43_PARTIAL_SCHEMA_REQUIRES_REVIEW: ${schema}`);
  }
  return true;
}
