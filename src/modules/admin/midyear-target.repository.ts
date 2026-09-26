import { sql } from 'drizzle-orm';
import type { TenantDb } from '../../shared/database/db.js';
import { MidyearImportError } from '../../shared/import-mapping/midyear.types.js';

export const getRecoveryTenantSchema = async (db: TenantDb, tenantId: string): Promise<string> => {
  const result = await db.execute<{ schema_name: string }>(sql`
    SELECT schema_name FROM public.tenants WHERE id = ${tenantId}::uuid
  `);
  const schema = result.rows[0]?.schema_name;
  if (!schema) throw new MidyearImportError('École introuvable', 404, 'NOT_FOUND');
  return schema;
};
