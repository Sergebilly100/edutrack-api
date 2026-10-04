import { sql } from 'drizzle-orm';
import type { TenantDb } from './db.js';

/** Les exports ne peuvent lire que la carte courante, jamais une révision archivée. */
export class ReportCardCurrentRepository {
  constructor(private readonly db: TenantDb) {}

  async exists(cardId: string): Promise<boolean> {
    const result = await this.db.execute<{ active: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM report_cards WHERE id = ${cardId}::uuid) AS active
    `);
    return result.rows?.[0]?.active ?? false;
  }
}
