import { withTenantSchema, type TenantDb } from './db.js';
import { assertConductMigrationContract } from './conduct-migration-contract.js';

export const withReadyConductTenant = <T>(schemaName: string, callback: (db: TenantDb) => Promise<T>): Promise<T> =>
  withTenantSchema(schemaName, async (db) => {
    await assertConductMigrationContract(db);
    return callback(db);
  });
