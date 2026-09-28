import { describe, expect, it } from 'vitest';
import { withTenantSchema } from '../../src/shared/database/db.js';
import { buildFinancialCacheService } from '../../src/modules/finance/financial-cache.service.js';
import { getAuthHeaders, getSeedContext, queryTenant, request, TEST_SCHEMA_NAME } from './setup.js';

describe('confirmed enrollment recovery journey', () => {
  it('excludes pending dossiers, separates waivers, validates scope and protects both endpoints', async () => {
    const suffix = Date.now().toString(36);
    const director = await getAuthHeaders('director');
    const teacher = await getAuthHeaders('teacher');
    const [year] = await queryTenant<{ id: string }>(`
      INSERT INTO school_years (label, start_date, end_date, status)
      VALUES ($1, '2090-09-01', '2091-06-30', 'draft') RETURNING id::text`, [`recovery-${suffix}`]);
    const [level] = await queryTenant<{ id: string }>(`
      INSERT INTO levels (name, order_index, is_exam_class) VALUES ($1, 9001, false) RETURNING id::text`, [`Recovery ${suffix}`]);
    const [otherLevel] = await queryTenant<{ id: string }>(`
      INSERT INTO levels (name, order_index, is_exam_class) VALUES ($1, 9002, false) RETURNING id::text`, [`Other ${suffix}`]);
    const [schoolClass] = await queryTenant<{ id: string }>(`
      INSERT INTO classes (name, level_id, school_year_id, is_active)
      VALUES ($1, $2, $3, true) RETURNING id::text`, [`Recovery A ${suffix}`, level!.id, year!.id]);
    const [foreignClass] = await queryTenant<{ id: string }>(`
      INSERT INTO classes (name, level_id, school_year_id, is_active)
      VALUES ($1, $2, $3, true) RETURNING id::text`, [`Recovery B ${suffix}`, otherLevel!.id, year!.id]);
    const [plan] = await queryTenant<{ id: string }>(`
      INSERT INTO tuition_plans (level_id, school_year_id, total_amount, currency)
      VALUES ($1, $2, 100000, 'FCFA') RETURNING id::text`, [level!.id, year!.id]);
    await queryTenant(`INSERT INTO tuition_schedule_steps (tuition_plan_id, due_date, cumulative_amount_expected)
      VALUES ($1, CURRENT_DATE - 1, 100000)`, [plan!.id]);

    const studentIds: Record<string, string> = {};
    for (const status of ['confirmed', 'pending_cashier', 'pending_dossier', 'blocked_unpaid']) {
      const [student] = await queryTenant<{ id: string }>(`
        INSERT INTO students (class_id, first_name, last_name, matricule)
        VALUES ($1, 'Recovery', $2, $3) RETURNING id::text`, [schoolClass!.id, status, `${suffix}-${status}`]);
      studentIds[status] = student!.id;
      await queryTenant(`INSERT INTO enrollments (student_id, class_id, school_year_id, type, status)
        VALUES ($1, $2, $3, 'new_registration', $4)`, [student!.id, schoolClass!.id, year!.id, status]);
    }
    await queryTenant(`INSERT INTO payments (student_id, school_year_id, amount, method, source, status, payment_date, receipt_number)
      VALUES ($1, $2, 30000, 'cash', 'cashier_manual', 'confirmed', CURRENT_DATE, $3),
             ($1, $2, 20000, 'cash', 'cashier_manual', 'waived_by_school', CURRENT_DATE, $4),
             ($5, $2, 90000, 'cash', 'cashier_manual', 'confirmed', CURRENT_DATE, $6)`,
      [studentIds.confirmed, year!.id, `RC-${suffix}-1`, `RC-${suffix}-2`, studentIds.pending_cashier, `RC-${suffix}-3`]);
    await queryTenant(`INSERT INTO student_financial_status (student_id, school_year_id, total_expected_to_date, total_paid, status)
      VALUES ($1, $2, 100000, 90000, 'late')`, [studentIds.pending_cashier, year!.id]);
    await withTenantSchema(TEST_SCHEMA_NAME, (db) => buildFinancialCacheService(db).recalcAll(year!.id));
    const stale = await queryTenant<{ id: string }>(`SELECT id FROM student_financial_status WHERE student_id = $1`, [studentIds.pending_cashier]);
    expect(stale).toHaveLength(0);

    const path = `/api/v1/finance/recovery?school_year_id=${year!.id}`;
    const summary = await request().get(path).set(director);
    expect(summary.status, JSON.stringify(summary.body)).toBe(200);
    expect(summary.body.school).toMatchObject({ studentCount: 1, expected: 100000, paid: 30000, waived: 20000, remaining: 50000, recoveryRate: 0.3, studentsToFollow: 1 });
    expect(summary.body.levels).toHaveLength(1);
    expect(summary.body.classes).toHaveLength(1);
    const scoped = await request().get(`${path}&level_id=${level!.id}&class_id=${schoolClass!.id}`).set(director);
    expect(scoped.status, JSON.stringify(scoped.body)).toBe(200);
    expect(scoped.body.selection).toEqual(summary.body.school);

    const detailPath = `/api/v1/finance/recovery/class-students?school_year_id=${year!.id}&level_id=${level!.id}&class_id=${schoolClass!.id}&page=1&limit=1`;
    const detail = await request().get(detailPath).set(director);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.pagination).toMatchObject({ total: 1, page: 1, limit: 1 });
    expect(detail.body.students).toEqual([expect.objectContaining({ studentId: studentIds.confirmed, paid: 30000, waived: 20000, remaining: 50000 })]);
    expect((await request().get(`${path}&level_id=${level!.id}&class_id=${foreignClass!.id}`).set(director)).body.code).toBe('RECOVERY_CLASS_OUT_OF_SCOPE');
    expect((await request().get(path).set(teacher)).status).toBe(403);
    expect((await request().get(detailPath).set(teacher)).status).toBe(403);
    expect((await request().get('/api/v1/finance/recovery/years').set(teacher)).status).toBe(403);

    const seed = getSeedContext();
    const [position] = await queryTenant<{ id: string }>(`
      INSERT INTO admin_positions (name, permissions, created_by)
      VALUES ($1, '["payments.view"]'::jsonb, $2) RETURNING id::text
    `, [`Finance recovery ${suffix}`, seed.directorUserId]);
    await queryTenant(`
      INSERT INTO position_assignments (user_id, position_id, assigned_by)
      VALUES ($1, $2, $3)
    `, [seed.staffUserId, position!.id, seed.directorUserId]);
    const financeStaff = await getAuthHeaders('staff');
    expect((await request().get('/api/v1/school-years').set(financeStaff)).status).toBe(403);
    const years = await request().get('/api/v1/finance/recovery/years').set(financeStaff);
    expect(years.status, JSON.stringify(years.body)).toBe(200);
    expect(years.body.years).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: year!.id, label: `recovery-${suffix}` }),
    ]));
    expect((await request().get(path).set(financeStaff)).status).toBe(200);
    expect((await request().get(detailPath).set(financeStaff)).status).toBe(200);
    const ordinaryPayment = await request().post('/api/v1/payments').set(director)
      .send({ studentId: studentIds.pending_cashier, schoolYearId: year!.id, amount: 1000, method: 'cash' });
    expect(ordinaryPayment.status).toBe(409);
    expect(ordinaryPayment.body.code).toBe('CONFIRMED_ENROLLMENT_REQUIRED');

    await queryTenant(`UPDATE enrollments SET status = 'pending_cashier'
      WHERE student_id = $1::uuid AND school_year_id = $2::uuid`, [studentIds.confirmed, year!.id]);
    await withTenantSchema(TEST_SCHEMA_NAME, (db) => buildFinancialCacheService(db).recalcAll(year!.id));
    for (const table of ['student_financial_status', 'class_financial_summary', 'school_financial_summary']) {
      const remaining = await queryTenant<{ count: number }>(`
        SELECT COUNT(*)::int AS count FROM ${table} WHERE school_year_id = $1::uuid
      `, [year!.id]);
      expect(remaining[0]!.count).toBe(0);
    }
  });
});
