import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../../src/shared/database/db.js';
import { BillingRepository } from '../../src/modules/billing/billing.repository.js';
import { BillingService } from '../../src/modules/billing/billing.service.js';

/**
 * Tests d'intégration pour les race conditions dans les paiements partiels de vacataires.
 * Simule des paiements concurrents pour valider la transaction SELECT FOR UPDATE.
 */

describe('Billing Race Conditions - Partial Payments', () => {
  let repository: BillingRepository;
  let service: BillingService;
  let testSchemaName: string;
  let teacherId: string;
  let salaryRecordId: string;

  beforeAll(async () => {
    // Créer un schéma de test isolé
    testSchemaName = `test_billing_race_${Date.now()}`;
    await db.execute(sql.raw(`CREATE SCHEMA ${testSchemaName}`));
    await db.execute(sql.raw(`SET search_path TO ${testSchemaName}`));

    // Créer les tables nécessaires (simplified schema for tests)
    await db.execute(sql`
      CREATE TYPE user_role AS ENUM ('director', 'staff', 'teacher', 'super_admin');
      CREATE TYPE teacher_type AS ENUM ('vacataire', 'permanent');
      CREATE TYPE salary_status AS ENUM ('pending', 'paid', 'disputed', 'nothing_to_pay');

      CREATE TABLE users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        role user_role NOT NULL,
        name VARCHAR(255) NOT NULL,
        password_hash TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE teachers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        username VARCHAR(50) NOT NULL UNIQUE,
        type teacher_type NOT NULL,
        hourly_rate INTEGER,
        monthly_salary INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE salary_records (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        teacher_id UUID NOT NULL REFERENCES teachers(id),
        period_month DATE NOT NULL,
        hours_planned NUMERIC(8,2) NOT NULL,
        hours_done NUMERIC(8,2) NOT NULL,
        hourly_rate INTEGER NOT NULL,
        total_fcfa INTEGER NOT NULL,
        status salary_status NOT NULL DEFAULT 'pending',
        paid_at TIMESTAMPTZ,
        paid_by UUID,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (teacher_id, period_month)
      );

      CREATE TABLE salary_payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        salary_record_id UUID NOT NULL REFERENCES salary_records(id),
        hours_paid NUMERIC(8,2),
        amount_fcfa INTEGER NOT NULL,
        paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        paid_by UUID NOT NULL,
        notes TEXT
      );
    `);

    // Créer un professeur vacataire de test
    const userResult = await db.execute<{ id: string }>(sql`
      INSERT INTO users (role, name, password_hash)
      VALUES ('teacher', 'Prof Test', 'dummy')
      RETURNING id
    `);
    const userId = userResult.rows[0]!.id;

    const teacherResult = await db.execute<{ id: string }>(sql`
      INSERT INTO teachers (user_id, username, type, hourly_rate)
      VALUES (${userId}, 'test.prof', 'vacataire', 5000)
      RETURNING id
    `);
    teacherId = teacherResult.rows[0]!.id;

    // Créer un salary_record avec 20h faites
    const recordResult = await db.execute<{ id: string }>(sql`
      INSERT INTO salary_records (
        teacher_id, period_month, hours_planned, hours_done, hourly_rate, total_fcfa, status
      )
      VALUES (
        ${teacherId}, '2026-05-01'::date, 20, 20, 5000, 100000, 'pending'
      )
      RETURNING id
    `);
    salaryRecordId = recordResult.rows[0]!.id;

    repository = new BillingRepository(db);
    service = new BillingService(repository);
  });

  afterAll(async () => {
    // Nettoyer le schéma de test
    await db.execute(sql.raw(`DROP SCHEMA ${testSchemaName} CASCADE`));
  });

  beforeEach(async () => {
    // Réinitialiser l'état : supprimer tous les paiements
    await db.execute(sql`DELETE FROM salary_payments WHERE salary_record_id = ${salaryRecordId}`);
    await db.execute(sql`
      UPDATE salary_records
      SET status = 'pending', paid_at = NULL, paid_by = NULL
      WHERE id = ${salaryRecordId}
    `);
  });

  it('should prevent overpayment when two payments occur simultaneously', async () => {
    // Scénario : 2 directeurs paient chacun 15h en même temps (total = 30h > 20h disponibles)
    // Avec SELECT FOR UPDATE, le second doit échouer

    const directorId1 = 'aaaa0000-0000-0000-0000-000000000001';
    const directorId2 = 'bbbb0000-0000-0000-0000-000000000002';

    const payment1Promise = service.updateSalaryRecordStatus({
      recordId: salaryRecordId,
      status: 'paid',
      hoursToPay: 15,
      actor: { userId: directorId1, role: 'director' },
    });

    const payment2Promise = service.updateSalaryRecordStatus({
      recordId: salaryRecordId,
      status: 'paid',
      hoursToPay: 15,
      actor: { userId: directorId2, role: 'director' },
    });

    const results = await Promise.allSettled([payment1Promise, payment2Promise]);

    // Un seul paiement doit réussir, l'autre doit échouer
    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);

    // Vérifier que le total payé est exactement 15h (pas 30h)
    const paymentsResult = await db.execute<{ total_hours: string }>(sql`
      SELECT COALESCE(SUM(hours_paid), 0)::numeric AS total_hours
      FROM salary_payments
      WHERE salary_record_id = ${salaryRecordId}
    `);

    expect(Number(paymentsResult.rows[0]!.total_hours)).toBe(15);
  });

  it('should allow two partial payments that do not exceed total hours', async () => {
    // Scénario : 2 paiements de 8h chacun (total = 16h < 20h disponibles)
    // Les deux doivent réussir

    const directorId = 'cccc0000-0000-0000-0000-000000000003';

    // Premier paiement : 8h
    await service.updateSalaryRecordStatus({
      recordId: salaryRecordId,
      status: 'paid',
      hoursToPay: 8,
      actor: { userId: directorId, role: 'director' },
    });

    // Second paiement : 8h
    await service.updateSalaryRecordStatus({
      recordId: salaryRecordId,
      status: 'paid',
      hoursToPay: 8,
      actor: { userId: directorId, role: 'director' },
    });

    // Vérifier que le total payé est 16h
    const paymentsResult = await db.execute<{ total_hours: string }>(sql`
      SELECT COALESCE(SUM(hours_paid), 0)::numeric AS total_hours
      FROM salary_payments
      WHERE salary_record_id = ${salaryRecordId}
    `);

    expect(Number(paymentsResult.rows[0]!.total_hours)).toBe(16);

    // Le statut doit être 'pending' (pas encore totalement payé)
    const recordResult = await db.execute<{ status: string }>(sql`
      SELECT status::text
      FROM salary_records
      WHERE id = ${salaryRecordId}
    `);

    expect(recordResult.rows[0]!.status).toBe('pending');
  });

  it('should mark salary as paid when final partial payment completes the total', async () => {
    // Scénario : 3 paiements partiels (8h + 7h + 5h = 20h)
    // Le dernier paiement doit marquer le statut = 'paid'

    const directorId = 'dddd0000-0000-0000-0000-000000000004';

    await service.updateSalaryRecordStatus({
      recordId: salaryRecordId,
      status: 'paid',
      hoursToPay: 8,
      actor: { userId: directorId, role: 'director' },
    });

    await service.updateSalaryRecordStatus({
      recordId: salaryRecordId,
      status: 'paid',
      hoursToPay: 7,
      actor: { userId: directorId, role: 'director' },
    });

    // Dernier paiement : 5h (complète les 20h)
    await service.updateSalaryRecordStatus({
      recordId: salaryRecordId,
      status: 'paid',
      hoursToPay: 5,
      actor: { userId: directorId, role: 'director' },
    });

    // Vérifier le statut
    const recordResult = await db.execute<{ status: string; paid_at: string | null }>(sql`
      SELECT status::text, paid_at::text
      FROM salary_records
      WHERE id = ${salaryRecordId}
    `);

    expect(recordResult.rows[0]!.status).toBe('paid');
    expect(recordResult.rows[0]!.paid_at).not.toBeNull();
  });

  it('should reject payment exceeding remaining hours by a tiny margin (EPSILON test)', async () => {
    // Scénario : après un paiement de 19.9999h, essayer de payer 0.001h
    // Doit échouer car total = 20.0009h > 20h

    const directorId = 'eeee0000-0000-0000-0000-000000000005';

    await service.updateSalaryRecordStatus({
      recordId: salaryRecordId,
      status: 'paid',
      hoursToPay: 19.9999,
      actor: { userId: directorId, role: 'director' },
    });

    await expect(
      service.updateSalaryRecordStatus({
        recordId: salaryRecordId,
        status: 'paid',
        hoursToPay: 0.001,
        actor: { userId: directorId, role: 'director' },
      })
    ).rejects.toThrow('hoursToPay exceeds remaining unpaid hours');
  });
});
