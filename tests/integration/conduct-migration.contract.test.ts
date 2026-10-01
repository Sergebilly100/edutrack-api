import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import type { TenantDb } from '../../src/shared/database/db.js';
import { loadDemoMigrations } from '../../src/shared/database/demo/demo-migrations.js';
import { DemoRepository } from '../../src/shared/database/demo/demo.repository.js';
import { assertConductMigrationContract } from '../../src/shared/database/conduct-migration-contract.js';

describe('conduct migration 0082', () => {
  it('upgrades a pre-0082 disposable tenant with defaults and audit constraints', async () => {
    const name = `demo_c29_${randomBytes(4).toString('hex')}`;
    const schema = `school_${name}`;
    const statements = await loadDemoMigrations(schema);
    const first0082 = statements.findIndex((statement) => statement.includes('"conduct_grade_audit"'));
    expect(first0082).toBeGreaterThan(0);
    const pool = new Pool({ connectionString: process.env.DATABASE_URL_TEST, max: 1 });
    try {
      await expect(drizzle(pool).transaction(async (tx) => {
        const repo = new DemoRepository(tx as unknown as TenantDb);
        await repo.reserve({ name, type: 'empty' });
        await repo.migrate(schema, statements.slice(0, first0082));
        await expect(repo.verifyConductMigration()).rejects.toThrow('DEMO_CONDUCT_MIGRATION_CONTRACT_FAILED');
        await expect(assertConductMigrationContract(tx as unknown as TenantDb))
          .rejects.toMatchObject({ code: 'CONDUCT_MIGRATION_REQUIRED', statusCode: 503 });
        await repo.migrate(schema, statements.slice(first0082));
        await expect(repo.verifyConductMigration()).resolves.toBeUndefined();
        await expect(assertConductMigrationContract(tx as unknown as TenantDb)).resolves.toBeUndefined();
        const inserted = await tx.execute<{ conduct_decision_mode: string; conduct_coefficient: string }>(sql`
          INSERT INTO school_years (label, start_date, end_date, end_of_year_review_start_date, status)
          VALUES ('C29 test', CURRENT_DATE, CURRENT_DATE + INTERVAL '1 year', CURRENT_DATE + INTERVAL '11 months', 'draft')
          RETURNING conduct_decision_mode, conduct_coefficient::text
        `);
        expect(inserted.rows[0]).toMatchObject({ conduct_decision_mode: 'homeroom', conduct_coefficient: '1.000' });
        throw new Error('ROLLBACK_C29_MIGRATION_TEST');
      })).rejects.toThrow('ROLLBACK_C29_MIGRATION_TEST');
    } finally {
      await pool.end();
    }
  }, 120_000);
});
