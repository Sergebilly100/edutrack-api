import { describe, expect, it } from 'vitest';

import { getAuthHeaders, queryTenant, request, tenantTable } from './setup.js';

const suffix = String(Date.now());
type IdRow = { id: string };

const createLevel = async (name: string, order: number): Promise<string> =>
  (await queryTenant<IdRow>(
    `INSERT INTO ${tenantTable('levels')} (name, order_index, is_exam_class) VALUES ($1, $2, false) RETURNING id::text`,
    [`${name} ${suffix}`, order]
  ))[0]!.id;

describe('copie du plan de frais vers d’autres niveaux (point 6)', () => {
  it('copie vers un niveau vierge, protège l’existant, confirme les inscrits et laisse les accords élèves intacts', async () => {
    const headers = await getAuthHeaders('director');
    await queryTenant(`UPDATE ${tenantTable('school_years')} SET status='closed' WHERE status='active'`);
    const year = (await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('school_years')} (label, start_date, end_date, end_of_year_review_start_date, status)
       VALUES ($1, '2112-09-01', '2113-06-30', '2113-05-01', 'active') RETURNING id::text`,
      [`cp-${suffix.slice(-8)}`]
    ))[0]!.id;
    const source = await createLevel('Copie source', 99910);
    const blank = await createLevel('Copie vierge', 99911);
    const withPlan = await createLevel('Copie avec plan', 99912);
    const enrolledLevel = await createLevel('Copie inscrits', 99913);

    const sourcePlan = {
      schoolYearId: year, totalAmount: 300000, registrationAmount: 50000, currency: 'FCFA',
      scheduleSteps: [{ dueDate: '2112-10-01', cumulativeAmountExpected: 100000 }, { dueDate: '2113-01-10', cumulativeAmountExpected: 300000 }],
    };
    for (const [levelId, plan] of [[source, sourcePlan], [withPlan, { ...sourcePlan, totalAmount: 90000, scheduleSteps: [] }]] as const) {
      expect((await request().put(`/api/v1/tuition-plans/levels/${levelId}`).set(headers).send(plan)).status).toBe(200);
    }

    // Élève inscrit sur le niveau cible, avec une remise individuelle.
    const klass = (await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('classes')} (name, level_id, school_year_id, is_active) VALUES ($1, $2::uuid, $3::uuid, true) RETURNING id::text`,
      [`Copie classe ${suffix}`, enrolledLevel, year]
    ))[0]!.id;
    const student = (await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, matricule) VALUES ($1::uuid, 'Copie', 'Test', $2) RETURNING id::text`,
      [klass, `CP-${suffix}`]
    ))[0]!.id;
    await queryTenant(
      `INSERT INTO ${tenantTable('enrollments')} (student_id, class_id, school_year_id, type, status) VALUES ($1::uuid, $2::uuid, $3::uuid, 'new_registration', 'confirmed')`,
      [student, klass, year]
    );
    const userId = (await queryTenant<IdRow>(`SELECT id::text FROM ${tenantTable('users')} LIMIT 1`))[0]!.id;
    await queryTenant(
      `INSERT INTO ${tenantTable('student_tuition_overrides')} (student_id, school_year_id, discount_amount, reason, granted_by_user_id)
       VALUES ($1::uuid, $2::uuid, 10000, 'Remise test', $3::uuid)`,
      [student, year, userId]
    );

    const preview = await request().get(`/api/v1/tuition-plans/levels/${source}/copy-preview?school_year_id=${year}`).set(headers);
    expect(preview.status).toBe(200);
    expect(preview.body.source.plan.totalAmount).toBe(300000);
    const states = Object.fromEntries((preview.body.targets as Array<{ levelId: string }>).map((target) => [target.levelId, target]));
    expect(states[withPlan]).toMatchObject({ existingPlan: { totalAmount: 90000 } });
    expect(states[enrolledLevel]).toMatchObject({ existingPlan: null, enrolledStudents: 1, studentsWithIndividualTerms: 1 });

    // 1) Sans confirmation : seul le niveau vierge est copié.
    const first = await request().post(`/api/v1/tuition-plans/levels/${source}/copy`).set(headers).send({
      schoolYearId: year, targets: [{ levelId: blank }, { levelId: withPlan }, { levelId: enrolledLevel }],
    });
    expect(first.status).toBe(200);
    const byLevel = Object.fromEntries((first.body.results as Array<{ levelId: string; status: string; code?: string }>).map((item) => [item.levelId, item]));
    expect(byLevel[blank]).toMatchObject({ status: 'copied' });
    expect(byLevel[withPlan]).toMatchObject({ status: 'skipped', code: 'PLAN_EXISTS' });
    expect(byLevel[enrolledLevel]).toMatchObject({ status: 'skipped', code: 'ENROLLED_CONFIRMATION_REQUIRED' });
    const plans = await request().get(`/api/v1/tuition-plans?school_year_id=${year}`).set(headers);
    const planOf = (levelId: string) => (plans.body.tuitionPlans as Array<{ level_id: string; total_amount: string; schedule_steps: unknown[] }>).find((plan) => plan.level_id === levelId);
    expect(Number(planOf(blank)!.total_amount)).toBe(300000);
    expect(planOf(blank)!.schedule_steps).toHaveLength(2);
    expect(Number(planOf(withPlan)!.total_amount)).toBe(90000);
    expect(planOf(enrolledLevel)).toBeUndefined();

    // 2) Avec confirmations explicites : écrasement et niveau avec inscrits.
    const second = await request().post(`/api/v1/tuition-plans/levels/${source}/copy`).set(headers).send({
      schoolYearId: year, targets: [{ levelId: withPlan, overwrite: true }, { levelId: enrolledLevel, confirmEnrolled: true }],
    });
    expect(second.body.results.map((item: { status: string }) => item.status)).toEqual(['copied', 'copied']);

    // Les conditions individuelles de l'élève n'ont pas bougé.
    const overrides = await queryTenant<{ discount_amount: string; status: string }>(
      `SELECT discount_amount::text, status FROM ${tenantTable('student_tuition_overrides')} WHERE student_id = $1::uuid`, [student]
    );
    expect(overrides).toEqual([{ discount_amount: '10000.00', status: 'active' }]);
  });
});
