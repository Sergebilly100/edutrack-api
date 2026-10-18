import { describe, expect, it } from 'vitest';

import { getAuthHeaders, getSeedContext, queryTenant, request, tenantTable, TEST_SCHEMA_NAME } from './setup.js';
import { withTenantSchema } from '../../src/shared/database/db.js';
import { buildFinancialCacheService } from '../../src/modules/finance/financial-cache.service.js';

const suffix = String(Date.now());

type IdRow = { id: string };

const isoDate = (offsetDays: number): string => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
};

describe('financial cache integration (6a)', () => {
  it('recalcule le cache immédiatement après un paiement confirmé', async () => {
    const headers = await getAuthHeaders('director');

    // Année active + niveau + plan d'échéancier + classe + élève
    await queryTenant(`UPDATE ${tenantTable('school_years')} SET status='closed' WHERE status='active'`);
    const years = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('school_years')} (label, start_date, end_date, end_of_year_review_start_date, status)
       VALUES ($1, $2, $3, $4, 'active') RETURNING id::text`,
      [`fc-${suffix}`, isoDate(-90), isoDate(270), isoDate(180)]
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
    await queryTenant(`INSERT INTO ${tenantTable('enrollments')} (student_id, class_id, school_year_id, type, status)
      VALUES ($1, $2, $3, 'new_registration', 'confirmed')`, [studentId, classes[0]!.id, yearId]);

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
    expect(summary.body.school).toMatchObject({
      annual_total_due: '300000.00',
      annual_remaining: '240000.00',
      upcoming_due: '200000.00',
    });
    expect(summary.body.upcomingInstallments.reduce(
      (sum: number, installment: { expected_amount: string }) => sum + Number(installment.expected_amount),
      0
    )).toBe(200_000);
    expect(summary.body.aging).toEqual(expect.arrayContaining([
      expect.objectContaining({ bucket: '0-30', total_amount: '40000.00', student_count: 1 }),
      expect.objectContaining({ bucket: '31-60', total_amount: '0.00', student_count: 0 }),
      expect.objectContaining({ bucket: '>60', total_amount: '0.00', student_count: 0 }),
    ]));

    const classRow = summary.body.classes.find((c: { class_id: string }) => c.class_id === classes[0]!.id);
    expect(classRow).toBeDefined();
    expect(classRow.students_late_count).toBeGreaterThanOrEqual(1);
    expect(Number(classRow.annual_total_due)).toBe(Number(summary.body.school.annual_total_due));
    expect(Number(classRow.annual_remaining)).toBe(Number(summary.body.school.annual_remaining));
    expect(Number(classRow.upcoming_due)).toBe(Number(summary.body.school.upcoming_due));

    const levelRow = summary.body.levels.find((row: { level_id: string }) => row.level_id === levelId);
    expect(levelRow).toBeDefined();
    expect(Number(levelRow.annual_total_due)).toBe(Number(summary.body.school.annual_total_due));
    expect(Number(levelRow.annual_remaining)).toBe(Number(summary.body.school.annual_remaining));
    expect(Number(levelRow.upcoming_due)).toBe(Number(summary.body.school.upcoming_due));
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

    const recalculate = await request()
      .post(`/api/v1/finance/recalculate?school_year_id=${yearId}`)
      .set(headers);
    expect(recalculate.status, JSON.stringify(recalculate.body)).toBe(200);
    expect(recalculate.body.result.studentCount).toBeGreaterThanOrEqual(1);

    const summary = await request()
      .get(`/api/v1/finance/financial-summary?school_year_id=${yearId}`)
      .set(headers);
    expect(summary.status).toBe(200);
    expect(summary.body.school).toMatchObject({
      annual_total_due: '300000.00',
      annual_remaining: '200000.00',
      upcoming_due: '200000.00',
      remaining_to_collect: '0.00',
    });
  });

  it('resynchronise le cache dès qu’un échéancier de niveau est modifié', async () => {
    const headers = await getAuthHeaders('director');
    const years = await queryTenant<IdRow>(
      `SELECT id::text FROM ${tenantTable('school_years')} WHERE label = $1 LIMIT 1`,
      [`fc-${suffix}`]
    );
    const yearId = years[0]!.id;
    const levels = await queryTenant<IdRow>(
      `SELECT id::text FROM ${tenantTable('levels')} WHERE name = $1 LIMIT 1`,
      [`FC level ${suffix}`]
    );
    const levelId = levels[0]!.id;
    const students = await queryTenant<IdRow>(
      `SELECT s.id::text FROM ${tenantTable('students')} s
       INNER JOIN ${tenantTable('classes')} c ON c.id = s.class_id
       WHERE c.name = $1 LIMIT 1`,
      [`FC class ${suffix}`]
    );
    const studentId = students[0]!.id;

    const updatedPlan = await request()
      .put(`/api/v1/tuition-plans/levels/${levelId}`)
      .set(headers)
      .send({
        schoolYearId: yearId,
        totalAmount: 300_000,
        currency: 'XOF',
        scheduleSteps: [
          { dueDate: isoDate(-30), cumulativeAmountExpected: 50_000 },
          { dueDate: isoDate(120), cumulativeAmountExpected: 300_000 },
        ],
      });
    expect(updatedPlan.status, JSON.stringify(updatedPlan.body)).toBe(200);

    const [cached, live] = await Promise.all([
      request().get(`/api/v1/students/${studentId}/financial-cache?school_year_id=${yearId}`).set(headers),
      request().get(`/api/v1/students/${studentId}/financial-status?school_year_id=${yearId}`).set(headers),
    ]);
    expect(cached.status).toBe(200);
    expect(live.status).toBe(200);
    expect(cached.body.cached).toMatchObject({
      total_expected_to_date: '50000.00',
      status: 'up_to_date',
    });
    expect(live.body.financialStatus).toMatchObject({
      cumulativeExpectedAtDate: 50_000,
      standing: 'up_to_date',
    });

    // Les scénarios suivants utilisent l'échéancier initial partagé.
    const restoredPlan = await request()
      .put(`/api/v1/tuition-plans/levels/${levelId}`)
      .set(headers)
      .send({
        schoolYearId: yearId,
        totalAmount: 300_000,
        currency: 'XOF',
        scheduleSteps: [
          { dueDate: isoDate(-30), cumulativeAmountExpected: 100_000 },
          { dueDate: isoDate(120), cumulativeAmountExpected: 300_000 },
        ],
      });
    expect(restoredPlan.status, JSON.stringify(restoredPlan.body)).toBe(200);
  });

  it('applique une remise au montant dû sans la compter comme encaissement', async () => {
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
      [classes[0]!.id, `FC-DISCOUNT-${suffix}`]
    );
    const studentId = students[0]!.id;
    await queryTenant(`INSERT INTO ${tenantTable('enrollments')} (student_id, class_id, school_year_id, type, status)
      VALUES ($1, $2, $3, 'new_registration', 'confirmed')`, [studentId, classes[0]!.id, yearId]);

    await queryTenant(
      `INSERT INTO ${tenantTable('student_tuition_overrides')}
        (student_id, school_year_id, discount_amount, reason, granted_by_user_id)
       VALUES ($1::uuid, $2::uuid, 300000, 'Remise sociale documentée', $3::uuid)`,
      [studentId, yearId, getSeedContext().directorUserId]
    );
    await withTenantSchema(TEST_SCHEMA_NAME, async (db) =>
      buildFinancialCacheService(db).recalcStudent(studentId, yearId));

    const financialStatus = await request()
      .get(`/api/v1/students/${studentId}/financial-status?school_year_id=${yearId}`)
      .set(headers);
    expect(financialStatus.status, JSON.stringify(financialStatus.body)).toBe(200);
    expect(financialStatus.body.financialStatus).toMatchObject({
      confirmedPaid: 0,
      discountAmount: 300_000,
      remainingDue: 0,
      standing: 'up_to_date',
    });

    const cached = await request()
      .get(`/api/v1/students/${studentId}/financial-cache?school_year_id=${yearId}`)
      .set(headers);
    expect(cached.status).toBe(200);
    expect(cached.body.cached).toMatchObject({
      total_paid: '0.00',
      total_due_year: '0.00',
      status: 'up_to_date',
    });

    const summary = await request()
      .get(`/api/v1/finance/financial-summary?school_year_id=${yearId}`)
      .set(headers);
    expect(summary.status).toBe(200);
    expect(Number(summary.body.school.total_paid)).toBe(100_000);
    // La remise ramène bien le dû de cette élève à zéro : elle ne gonfle ni
    // l'attendu école ni le taux de recouvrement.
    expect(Number(summary.body.school.total_expected_to_date)).toBe(100_000);
    expect(Number(summary.body.school.recovery_rate)).toBe(1);
    expect(Number(summary.body.school.students_late_count)).toBe(0);
    expect(Number(summary.body.school.annual_total_due)).toBe(300_000);
    expect(Number(summary.body.school.annual_remaining)).toBe(200_000);
    expect(Number(summary.body.school.upcoming_due)).toBe(200_000);
    expect(summary.body.installmentScheduleComplete).toBe(true);
    expect(summary.body.aging).toEqual([
      expect.objectContaining({ bucket: '0-30' }),
      expect.objectContaining({ bucket: '31-60' }),
      expect.objectContaining({ bucket: '>60' }),
    ]);
    // La remise totale annule aussi les échéances restantes de cette élève.
    expect(summary.body.upcomingInstallments.reduce(
      (sum: number, installment: { expected_amount: string }) => sum + Number(installment.expected_amount),
      0
    )).toBe(200_000);
  });

  it('conserve dans la population confirmée un élève sans plan avec un dû annuel nul', async () => {
    const headers = await getAuthHeaders('director');
    const [year] = await queryTenant<IdRow>('SELECT id FROM school_years WHERE label=$1', [`fc-${suffix}`]);
    const levels = await queryTenant<IdRow>(
      'INSERT INTO levels (name, order_index, is_exam_class) VALUES ($1, 99991, false) RETURNING id::text',
      [`FC no-plan level ${suffix}`]
    );
    const classes = await queryTenant<IdRow>(
      'INSERT INTO classes (name, level_id, school_year_id, is_active) VALUES ($1, $2, $3, true) RETURNING id::text',
      [`FC no-plan class ${suffix}`, levels[0]!.id, year!.id]
    );
    const students = await queryTenant<IdRow>(
      "INSERT INTO students (class_id, first_name, last_name) VALUES ($1, 'Sans', 'Plan') RETURNING id::text",
      [classes[0]!.id]
    );
    await queryTenant(
      "INSERT INTO enrollments (student_id, class_id, school_year_id, type, status) VALUES ($1, $2, $3, 'new_registration', 'confirmed')",
      [students[0]!.id, classes[0]!.id, year!.id]
    );
    await withTenantSchema(TEST_SCHEMA_NAME, (db) => buildFinancialCacheService(db).recalcAll(year!.id));

    const summary = await request()
      .get(`/api/v1/finance/financial-summary?school_year_id=${year!.id}`)
      .set(headers);
    expect(summary.status).toBe(200);
    const noPlanClass = summary.body.classes.find(
      (row: { class_id: string }) => row.class_id === classes[0]!.id
    );
    expect(noPlanClass).toMatchObject({
      annual_total_due: '0.00',
      annual_remaining: '0.00',
      upcoming_due: '0.00',
    });
    expect(Number(summary.body.school.annual_total_due)).toBe(300_000);
    expect(summary.body.classes.reduce(
      (sum: number, row: { annual_total_due: string }) => sum + Number(row.annual_total_due),
      0
    )).toBe(Number(summary.body.school.annual_total_due));
    expect(summary.body.levels.reduce(
      (sum: number, row: { annual_total_due: string }) => sum + Number(row.annual_total_due),
      0
    )).toBe(Number(summary.body.school.annual_total_due));
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
    await queryTenant("INSERT INTO enrollments (student_id, class_id, school_year_id, type, status) VALUES ($1,$2,$3,'new_registration','confirmed')", [student!.id, schoolClass!.id, year!.id]);
    await queryTenant('INSERT INTO student_tuition_overrides (student_id, school_year_id, discount_amount, override_total_amount, reason, granted_by_user_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [student!.id, year!.id, discount, override, 'Revue du cache', getSeedContext().directorUserId]);
    if (step !== null) {
      const [agreement] = await queryTenant<IdRow>(
        "INSERT INTO student_tuition_schedule_agreements(student_id,school_year_id,reason) VALUES ($1,$2,'Fixture de cache') RETURNING id",
        [student!.id, year!.id]
      );
      await queryTenant('INSERT INTO student_tuition_schedule_steps (agreement_id,due_date,cumulative_amount_expected) VALUES ($1,CURRENT_DATE-5,$2)', [agreement!.id, step]);
    }
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

    const summary = await request()
      .get(`/api/v1/finance/financial-summary?school_year_id=${year!.id}`)
      .set(await getAuthHeaders('director'));
    expect(summary.status).toBe(200);
    const cachedTotal = await queryTenant<{ total: string }>(
      'SELECT COALESCE(SUM(total_due_year), 0)::text AS total FROM student_financial_status WHERE school_year_id=$1',
      [year!.id]
    );
    expect(Number(summary.body.school.annual_total_due)).toBe(Number(cachedTotal[0]!.total));
    expect(Number(summary.body.school.annual_remaining)).toBe(
      Number(summary.body.school.annual_total_due) - Number(summary.body.school.total_paid)
    );
    expect(Number(summary.body.school.annual_remaining)).toBe(
      Number(summary.body.school.remaining_to_collect) + Number(summary.body.school.upcoming_due)
    );
    expect(summary.body.levels.reduce(
      (sum: number, row: { annual_total_due: string }) => sum + Number(row.annual_total_due),
      0
    )).toBe(Number(summary.body.school.annual_total_due));
  });
});
