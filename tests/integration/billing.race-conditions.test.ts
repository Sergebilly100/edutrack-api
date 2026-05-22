import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withTenantSchema } from '../../src/shared/database/db.js';
import { BillingRepository } from '../../src/modules/billing/billing.repository.js';
import { BillingService } from '../../src/modules/billing/billing.service.js';

/**
 * Tests d'intégration pour les race conditions dans les paiements partiels de vacataires.
 * Simule des paiements concurrents pour valider la transaction SELECT FOR UPDATE.
 */

describe('Billing Race Conditions - Partial Payments', () => {
  let testSchemaName: string;
  let teacherId: string;
  let salaryRecordId: string;

  const makeService = async <T>(fn: (service: BillingService) => Promise<T>): Promise<T> => {
    return withTenantSchema(testSchemaName, async (tenantDb) => {
      const repository = new BillingRepository(tenantDb);
      const service = new BillingService(repository);
      return fn(service);
    });
  };

  const queryTenant = async <T extends Record<string, unknown>>(query: string): Promise<T[]> => {
    return withTenantSchema(testSchemaName, async (tenantDb) => {
      const result = await tenantDb.execute<T>(sql.raw(query));
      return result.rows;
    });
  };

  beforeAll(async () => {
    testSchemaName = `test_billing_race_${Date.now()}`;

    // Créer le schéma et les tables avec noms qualifiés
    await db.execute(sql.raw(`CREATE SCHEMA "${testSchemaName}"`));
    await db.execute(sql.raw(`
      CREATE TYPE "${testSchemaName}".user_role AS ENUM ('director', 'staff', 'teacher', 'super_admin');
      CREATE TYPE "${testSchemaName}".teacher_type AS ENUM ('vacataire', 'permanent');
      CREATE TYPE "${testSchemaName}".salary_status AS ENUM ('pending', 'paid', 'disputed', 'nothing_to_pay');

      CREATE TABLE "${testSchemaName}".users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        role "${testSchemaName}".user_role NOT NULL,
        name VARCHAR(255) NOT NULL,
        password_hash TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE "${testSchemaName}".teachers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES "${testSchemaName}".users(id) ON DELETE CASCADE,
        username VARCHAR(50) NOT NULL UNIQUE,
        type "${testSchemaName}".teacher_type NOT NULL,
        hourly_rate INTEGER,
        monthly_salary INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE "${testSchemaName}".salary_records (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        teacher_id UUID NOT NULL REFERENCES "${testSchemaName}".teachers(id),
        period_month DATE NOT NULL,
        hours_planned NUMERIC(8,2) NOT NULL,
        hours_done NUMERIC(8,2) NOT NULL,
        hourly_rate INTEGER NOT NULL,
        total_fcfa INTEGER NOT NULL,
        status "${testSchemaName}".salary_status NOT NULL DEFAULT 'pending',
        paid_at TIMESTAMPTZ,
        paid_by UUID,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (teacher_id, period_month)
      );

      CREATE TABLE "${testSchemaName}".salary_payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        salary_record_id UUID NOT NULL REFERENCES "${testSchemaName}".salary_records(id),
        hours_paid NUMERIC(8,2),
        amount_fcfa INTEGER NOT NULL,
        paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        paid_by UUID NOT NULL,
        notes TEXT
      );

      CREATE TABLE "${testSchemaName}".admin_positions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL
      );

      CREATE TABLE "${testSchemaName}".position_assignments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES "${testSchemaName}".users(id),
        position_id UUID NOT NULL REFERENCES "${testSchemaName}".admin_positions(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `));

    // Créer les données de test via withTenantSchema
    const ids = await withTenantSchema(testSchemaName, async (tenantDb) => {
      const userResult = await tenantDb.execute<{ id: string }>(sql`
        INSERT INTO users (role, name, password_hash)
        VALUES ('teacher', 'Prof Test', 'dummy')
        RETURNING id
      `);
      const userId = userResult.rows[0]!.id;

      const teacherResult = await tenantDb.execute<{ id: string }>(sql`
        INSERT INTO teachers (user_id, username, type, hourly_rate)
        VALUES (${userId}, 'test.prof', 'vacataire', 5000)
        RETURNING id
      `);
      const tId = teacherResult.rows[0]!.id;

      const recordResult = await tenantDb.execute<{ id: string }>(sql`
        INSERT INTO salary_records (
          teacher_id, period_month, hours_planned, hours_done, hourly_rate, total_fcfa, status
        )
        VALUES (
          ${tId}, '2026-05-01'::date, 20, 20, 5000, 100000, 'pending'
        )
        RETURNING id
      `);
      return { teacherId: tId, salaryRecordId: recordResult.rows[0]!.id };
    });

    teacherId = ids.teacherId;
    salaryRecordId = ids.salaryRecordId;
  });

  afterAll(async () => {
    await db.execute(sql.raw(`DROP SCHEMA "${testSchemaName}" CASCADE`));
  });

  beforeEach(async () => {
    await db.execute(sql.raw(`DELETE FROM "${testSchemaName}".salary_payments WHERE salary_record_id = '${salaryRecordId}'`));
    await db.execute(sql.raw(`UPDATE "${testSchemaName}".salary_records SET status = 'pending', paid_at = NULL, paid_by = NULL WHERE id = '${salaryRecordId}'`));
  });

  it('should prevent overpayment when two payments occur simultaneously', async () => {
    const directorId1 = 'aaaa0000-0000-0000-0000-000000000001';
    const directorId2 = 'bbbb0000-0000-0000-0000-000000000002';

    const results = await Promise.allSettled([
      makeService((svc) => svc.updateSalaryRecordStatus({
        recordId: salaryRecordId,
        status: 'paid',
        hoursToPay: 15,
        actor: { userId: directorId1, role: 'director', schemaName: testSchemaName },
      })),
      makeService((svc) => svc.updateSalaryRecordStatus({
        recordId: salaryRecordId,
        status: 'paid',
        hoursToPay: 15,
        actor: { userId: directorId2, role: 'director', schemaName: testSchemaName },
      })),
    ]);

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);

    const rows = await queryTenant<{ total_hours: string }>(
      `SELECT COALESCE(SUM(hours_paid), 0)::numeric AS total_hours FROM salary_payments WHERE salary_record_id = '${salaryRecordId}'`
    );
    expect(Number(rows[0]!.total_hours)).toBe(15);
  });

  it('should allow two partial payments that do not exceed total hours', async () => {
    const directorId = 'cccc0000-0000-0000-0000-000000000003';

    await makeService((svc) => svc.updateSalaryRecordStatus({
      recordId: salaryRecordId,
      status: 'paid',
      hoursToPay: 8,
      actor: { userId: directorId, role: 'director', schemaName: testSchemaName },
    }));

    await makeService((svc) => svc.updateSalaryRecordStatus({
      recordId: salaryRecordId,
      status: 'paid',
      hoursToPay: 8,
      actor: { userId: directorId, role: 'director', schemaName: testSchemaName },
    }));

    const payRows = await queryTenant<{ total_hours: string }>(
      `SELECT COALESCE(SUM(hours_paid), 0)::numeric AS total_hours FROM salary_payments WHERE salary_record_id = '${salaryRecordId}'`
    );
    expect(Number(payRows[0]!.total_hours)).toBe(16);

    const recRows = await queryTenant<{ status: string }>(
      `SELECT status::text FROM salary_records WHERE id = '${salaryRecordId}'`
    );
    expect(recRows[0]!.status).toBe('pending');
  });

  it('should mark salary as paid when final partial payment completes the total', async () => {
    const directorId = 'dddd0000-0000-0000-0000-000000000004';

    for (const hours of [8, 7, 5]) {
      await makeService((svc) => svc.updateSalaryRecordStatus({
        recordId: salaryRecordId,
        status: 'paid',
        hoursToPay: hours,
        actor: { userId: directorId, role: 'director', schemaName: testSchemaName },
      }));
    }

    const rows = await queryTenant<{ status: string; paid_at: string | null }>(
      `SELECT status::text, paid_at::text FROM salary_records WHERE id = '${salaryRecordId}'`
    );
    expect(rows[0]!.status).toBe('paid');
    expect(rows[0]!.paid_at).not.toBeNull();
  });

  it('should reject payment exceeding remaining hours by a small margin', async () => {
    const directorId = 'eeee0000-0000-0000-0000-000000000005';

    // Payer 19h (roundHours(19) = 19), laisse 1h restante
    await makeService((svc) => svc.updateSalaryRecordStatus({
      recordId: salaryRecordId,
      status: 'paid',
      hoursToPay: 19,
      actor: { userId: directorId, role: 'director', schemaName: testSchemaName },
    }));

    // Essayer de payer 2h (dépasse le 1h restant)
    await expect(
      makeService((svc) => svc.updateSalaryRecordStatus({
        recordId: salaryRecordId,
        status: 'paid',
        hoursToPay: 2,
        actor: { userId: directorId, role: 'director', schemaName: testSchemaName },
      }))
    ).rejects.toThrow('hoursToPay exceeds remaining unpaid hours');
  });
});
