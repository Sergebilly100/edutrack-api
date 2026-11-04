import type { SQL, SQLWrapper } from 'drizzle-orm';

export type TenantSqlExecutor = {
  execute: (query: SQL | SQLWrapper) => Promise<unknown>;
};
