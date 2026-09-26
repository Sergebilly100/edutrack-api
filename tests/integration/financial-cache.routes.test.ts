import { describe, expect, it } from 'vitest';

import { getAuthHeaders, getSeedContext, queryTenant, request, tenantTable, TEST_SCHEMA_NAME } from './setup.js';
import { withTenantSchema } from '../../src/shared/database/db.js';
import { buildFinancialCacheService } from '../../src/modules/finance/financial-cache.service.js';

const suffix = String(Date.now());

type IdRow = { id: string };

describe('financial cache integration (6a)', () => {
  it('recalcule le cache immédiatement après un paiement confirmé', async () => {
    const headers = await getAuthHeaders('director');

    // Année active + niveau + plan d'échéancier + classe + élève
    await queryTenant(`UPDATE ${tenantTable('school_years')} SET status='closed' WHERE status='active'`);
    const years = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('school_years')} (label, start_date, end_date, end_of_year_review_start_date, status)
       VALUES ($1, '2098-09-01', '2099-06-30', '2099-05-01', 'active') RETURNING id::text`,
      [`fc-${suffix}`]
    );
    const yearId = years[0]!.id;
    const levels = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('levels')} (name, order_index, is_exam_class) VALUES ($1, 99700, false) RETURNING id::text`,
      [`FC level ${suffix}`]
    );
    const levelId = levels[0]!.id;
    await queryTenant(
      `INSERT INTO ${tenantTable('tuition_plans')} (level_id, school_year_id, total_amount, currency)
       VALUES ($1::uuid, $2::uuid, 300000, 'XOF')`,
      [levelId, yearId]
    );
    // Échéancier : 100k dû à date (étape passée), 200k plus tard dans l'année
    await queryTenant(
      `INSERT INTO ${tenantTable('tuition_schedule_steps')} (tuition_plan_id, due_date, cumulative_amount_expected)
       SELECT id, CURRENT_DATE - 30, 100000 FROM ${tenantTable('tuition_plans')} WHERE school_year_id = $1::uuid`,
      [yearId]
    );
    await queryTenant(
      `INSERT INTO ${tenantTable('tuition_schedule_steps')} (tuition_plan_id, due_date, cumulative_amount_expected)
       SELECT id, CURRENT_DATE + 120, 300000 FROM ${tenantTable('tuition_plans')} WHERE school_year_id = $1::uuid`,
      [yearId]
    );
    const classes = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('classes')} (name, level_id, school_year_id, is_active)
       VALUES ($1, $2::uuid, $3::uuid, true) RETURNING id::text`,
      [`FC class ${suffix}`, levelId, yearId]
    );
    const students = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, matricule)
       VALUES ($1::uuid, 'Fati', 'Cache', $2) RETURNING id::text`,
      [classes[0]!.id, `FC-${suffix}`]
    );
    const studentId = students[0]!.id;

    // Avant paiement : pas de cache (ou à jour à zéro attendu ? on purge pour être déterministe)
    await queryTenant(`DELETE FROM ${tenantTable('student_financial_status')} WHERE student_id = $1::uuid`, [studentId]);

    // Paiement confirmé de 60k → recalcul ciblé déclenché par l'API
    const payment = await request()
      .post('/api/v1/payments')
      .set(headers)
      .send({ studentId, schoolYearId: yearId, amount: 60_000, method: 'cash' });
    expect(payment.status, JSON.stringify(payment.body)).toBe(201);

    const cached = await request()
      .get(`/api/v1/students/${studentId}/financial-cache`)
      .set(headers);
    expect(cached.status).toBe(200);
    expect(cached.body.cached).not.toBeNull();
    expect(Number(cached.body.cached.total_paid)).toBe(60_000);
    expect(Number(cached.body.cached.total_expected_to_date)).toBe(100_000);
    expect(cached.body.cached.status).toBe('late');
    expect(cached.body.cached.days_late).toBeGreaterThanOrEqual(0);

    // Résumés classe et école rafraîchis
    const summary = await request()
      .get('/api/v1/finance/financial-summary')
      .set(headers);
    expect(summary.status).toBe(200);
    expect(summary.body.school).not.toBeNull();
    expect(Number(summary.body.school.total_paid)).toBeGreaterThanOrEqual(60_000);
    expect(Number(summary.body.school.recovery_rate)).toBeGreaterThan(0);

    const classRow = summary.body.classes.find((c: { class_id: string }) => c.class_id === classes[0]!.id);
    expect(classRow).toBeDefined();
    expect(classRow.students_late_count).toBeGreaterThanOrEqual(1);
  });

  it("le statut passe up_to_date quand le payé couvre le dû à date", async () => {
    const headers = await getAuthHeaders('director');
    const years = await queryTenant<IdRow>(
      `SELECT id::text FROM ${tenantTable('school_years')} WHERE label = $1 LIMIT 1`,
      [`fc-${suffix}`]
    );
    const yearId = years[0]!.id;
    const students = await queryTenant<IdRow>(
      `SELECT s.id::text FROM ${tenantTable('students')} s
       INNER JOIN ${tenantTable('classes')} c ON c.id = s.class_id
       WHERE c.name LIKE 'FC class %' ORDER BY s.created_at ASC LIMIT 1`
    );
    const studentId = students[0]!.id;

    const payment = await request()
      .post('/api/v1/payments')
      .set(headers)
      .send({ studentId, schoolYearId: yearId, amount: 40_000, method: 'cash' });
    expect([201]).toContain(payment.status);

    const cached = await request()
      .get(`/api/v1/students/${studentId}/financial-cache`)
      .set(headers);
    expect(Number(cached.body.cached.total_paid)).toBe(100_000);
    expect(cached.body.cached.status).toBe('up_to_date');
    expect(cached.body.cached.days_late).toBeNull();
  });

  it('traite une remise comme couverture individuelle sans la compter au recouvrement', async () => {
    const headers = await getAuthHeaders('director');
    const years = await queryTenant<IdRow>(
      `SELECT id::text FROM ${tenantTable('school_years')} WHERE label = $1 LIMIT 1`,
      [`fc-${suffix}`]
    );
    const yearId = years[0]!.id;
    const classes = await queryTenant<IdRow>(
      `SELECT id::text FROM ${tenantTable('classes')} WHERE name LIKE 'FC class %' LIMIT 1`
    );
    const students = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, matricule)
       VALUES ($1::uuid, 'Aya', 'Remise', $2) RETURNING id::text`,
      [classes[0]!.id, `FC-WAIVED-${suffix}`]
    );
    const studentId = students[0]!.id;

    await queryTenant(
      `INSERT INTO ${tenantTable('payments')}
        (student_id, school_year_id, amount, method, source, status, payment_date, receipt_number)
       VALUES ($1::uuid, $2::uuid, 300000, 'cash', 'cashier_manual', 'waived_by_school', CURRENT_DATE, $3)`,
      [studentId, yearId, `WAIVER-${suffix}`]
    );
    await withTenantSchema(TEST_SCHEMA_NAME, async (db) =>
      buildFinancialCacheService(db).recalcStudent(studentId, yearId));

    const financialStatus = await request()
      .get(`/api/v1/students/${studentId}/financial-status?school_year_id=${yearId}`)
      .set(headers);
    expect(financialStatus.status, JSON.stringify(financialStatus.body)).toBe(200);
    expect(financialStatus.body.financialStatus).toMatchObject({
      confirmedPaid: 0,
      waivedAmount: 300_000,
      remainingDue: 0,
      standing: 'up_to_date',
    });

    const cached = await request()
      .get(`/api/v1/students/${studentId}/financial-cache?school_year_id=${yearId}`)
      .set(headers);
    expect(cached.status).toBe(200);
    expect(cached.body.cached).toMatchObject({
      total_paid: '0.00',
      waived_amount: '300000.00',
      status: 'waived',
    });

    const summary = await request()
      .get(`/api/v1/finance/financial-summary?school_year_id=${yearId}`)
      .set(headers);
    expect(summary.status).toBe(200);
    expect(Number(summary.body.school.total_paid)).toBe(100_000);
    expect(Number(summary.body.school.total_expected_to_date)).toBe(200_000);
    expect(Number(summary.body.school.recovery_rate)).toBe(0.5);
    expect(Number(summary.body.school.students_late_count)).toBe(0);
  });

  it.each([
    { discount: 30000, override: null, step: null, total: 270000, expected: 100000 },
    { discount: 500000, override: null, step: null, total: 0, expected: 0 },
    { discount: null, override: 80000, step: null, total: 80000, expected: 80000 },
    { discount: null, override: 80000, step: 50000, total: 80000, expected: 50000 },
  ])('applique remise, montant et échéancier personnalisés : %j', async ({ discount, override, step, total, expected }) => {
    const [year] = await queryTenant<IdRow>('SELECT id FROM school_years WHERE label=$1', [`fc-${suffix}`]);
    const [schoolClass] = await queryTenant<IdRow>("SELECT id FROM classes WHERE name LIKE 'FC class %' LIMIT 1");
    const [student] = await queryTenant<IdRow>("INSERT INTO students (class_id, first_name, last_name) VALUES ($1,'Revue','Remise') RETURNING id", [schoolClass!.id]);
    await queryTenant('INSERT INTO student_tuition_overrides (student_id, school_year_id, discount_amount, override_total_amount, reason, granted_by_user_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [student!.id, year!.id, discount, override, 'Revue du cache', getSeedContext().directorUserId]);
    if (step !== null) await queryTenant('INSERT INTO student_tuition_schedule_steps (student_id,school_year_id,due_date,cumulative_amount_expected) VALUES ($1,$2,CURRENT_DATE-5,$3)', [student!.id, year!.id, step]);
    await withTenantSchema(TEST_SCHEMA_NAME, (db) => buildFinancialCacheService(db).recalcAll(year!.id));
    const [cached] = await queryTenant<{ total_due_year: string; total_expected_to_date: string; total_paid: string }>('SELECT total_due_year,total_expected_to_date,total_paid FROM student_financial_status WHERE student_id=$1', [student!.id]);
    expect(Number(cached?.total_due_year)).toBe(total);
    expect(Number(cached?.total_expected_to_date)).toBe(expected);
    expect(Number(cached?.total_paid)).toBe(0);
    const status = await request().get(`/api/v1/students/${student!.id}/financial-status?school_year_id=${year!.id}`)
      .set(await getAuthHeaders('director'));
    expect(status.status).toBe(200);
    expect(status.body.financialStatus.cumulativeExpectedAtDate).toBe(expected);
    expect(status.body.financialStatus.standing).toBe(expected === 0 ? 'up_to_date' : 'late');
    const [source] = await queryTenant<{ discount_amount: string }>('SELECT discount_amount FROM student_tuition_overrides WHERE student_id=$1', [student!.id]);
    expect(Number(source?.discount_amount)).toBe(Number(discount));
  });
});
