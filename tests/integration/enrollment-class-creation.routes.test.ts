import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getAuthHeaders, queryTenant, request, tenantTable } from './setup.js';

async function academicContext(suffix: string) {
  const headers = await getAuthHeaders('director');
  await queryTenant(`UPDATE ${tenantTable('school_years')} SET status = 'closed' WHERE status = 'active'`);
  const [year] = await queryTenant<{ id: string }>(`INSERT INTO ${tenantTable('school_years')} (label, start_date, end_date, status) VALUES ($1, '2090-09-01', '2091-06-30', 'active') RETURNING id`, [`C9 active ${suffix}`]);
  const [level] = await queryTenant<{ id: string }>(`INSERT INTO ${tenantTable('levels')} (name, order_index) VALUES ($1, 1) RETURNING id`, [`C9 CP1 ${suffix}`]);
  return { headers, yearId: year!.id, levelId: level!.id };
}

describe('C9 création explicite depuis une inscription', () => {
  it('crée explicitement la classe puis confirme l’inscription avec le niveau et l’année relus', async () => {
    const { headers, yearId, levelId } = await academicContext('nominal');
    const created = await request().post('/api/v1/classes').set(headers).send({ name: 'C9 CP1 A', levelId, expectedSchoolYearId: yearId, homeroomTeacherId: null });
    expect(created.status).toBe(201);
    const classId = created.body.class.id;
    const emptyEnrollments = await queryTenant<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${tenantTable('enrollments')}`);
    expect(emptyEnrollments[0]!.count).toBe('0');
    const reread = await request().get(`/api/v1/classes?schoolYearId=${yearId}`).set(headers);
    expect(reread.body.activeSchoolYear.id).toBe(yearId);
    expect(reread.body.classes).toContainEqual(expect.objectContaining({ id: classId, level: expect.objectContaining({ id: levelId }) }));
    const student = await request().post('/api/v1/students').set(headers).send({ first_name: 'Aya', last_name: 'Recette C9', matricule: 'C9-001' });
    expect(student.status).toBe(201);
    const studentId = student.body.data.id;
    const plan = await request().put(`/api/v1/tuition-plans/levels/${levelId}`).set(headers).send({ schoolYearId: yearId, totalAmount: 100000, currency: 'FCFA', scheduleSteps: [] });
    expect(plan.status).toBe(200);
    const enrolled = await request().post('/api/v1/enrollments').set(headers).send({ studentId, classId, schoolYearId: yearId, levelId, expectedActiveSchoolYearId: yearId, type: 'new_registration' });
    expect(enrolled.status).toBe(201);
    const confirmed = await request().post(`/api/v1/enrollments/${enrolled.body.enrollment.id}/confirm-payment`).set(headers).send({ amount: 10000, method: 'cash', schoolReceiptReference: 'C9-RC-001' });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.enrollment).toMatchObject({ status: 'confirmed', classId, schoolYearId: yearId });
    const rows = await queryTenant<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${tenantTable('classes')} WHERE name = 'C9 CP1 A'`);
    expect(rows[0]!.count).toBe('1');
  });

  it('refuse la création sans permission et les références invalides sans écrire de classe', async () => {
    const { headers, yearId, levelId } = await academicContext('permissions');
    const staff = await getAuthHeaders('staff');
    const forbidden = await request().post('/api/v1/classes').set(staff).send({ name: 'C9 interdite', levelId, expectedSchoolYearId: yearId });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe('FORBIDDEN');
    const invalidLevel = await request().post('/api/v1/classes').set(headers).send({ name: 'C9 invalide', levelId: randomUUID(), expectedSchoolYearId: yearId });
    expect(invalidLevel.status).toBe(400);
    expect(invalidLevel.body.code).toBe('CLASS_LEVEL_NOT_FOUND');
    const invalidYear = await request().post('/api/v1/classes').set(headers).send({ name: 'C9 invalide', levelId, expectedSchoolYearId: randomUUID() });
    expect(invalidYear.status).toBe(409);
    expect(invalidYear.body.code).toBe('ACTIVE_SCHOOL_YEAR_CHANGED');
    const malformed = await request().post('/api/v1/classes').set(headers).send({ name: 'C9 invalide', levelId, expectedSchoolYearId: 'invalid' });
    expect(malformed.status).toBe(400);
    const count = await queryTenant<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${tenantTable('classes')} WHERE school_year_id = $1`, [yearId]);
    expect(count[0]!.count).toBe('0');
  });

  it('refuse année changée, niveau différent et classe archivée sans inscription partielle', async () => {
    const { headers, yearId, levelId } = await academicContext('retour');
    const created = await request().post('/api/v1/classes').set(headers).send({ name: 'C9 CP1 A', levelId, expectedSchoolYearId: yearId });
    expect(created.status).toBe(201);
    const classId = created.body.class.id;
    const student = await request().post('/api/v1/students').set(headers).send({ first_name: 'Aya', last_name: 'C9 retour', matricule: 'C9-002' });
    const payload = { studentId: student.body.data.id, classId, schoolYearId: yearId, levelId, expectedActiveSchoolYearId: yearId, type: 'new_registration' };
    const forbidden = await request().post('/api/v1/enrollments').set(await getAuthHeaders('staff')).send(payload);
    expect(forbidden.status).toBe(403);
    const wrongLevel = await request().post('/api/v1/enrollments').set(headers).send({ ...payload, levelId: randomUUID() });
    expect(wrongLevel.status).toBe(400);
    expect(wrongLevel.body.code).toBe('CLASS_LEVEL_MISMATCH');
    const wrongYear = await request().post('/api/v1/enrollments').set(headers).send({ ...payload, schoolYearId: randomUUID() });
    expect(wrongYear.status).toBe(400);
    expect(wrongYear.body.code).toBe('CLASS_YEAR_MISMATCH');
    await queryTenant(`UPDATE ${tenantTable('school_years')} SET status = 'closed' WHERE id = $1`, [yearId]);
    const changedYear = await request().post('/api/v1/enrollments').set(headers).send(payload);
    expect(changedYear.status).toBe(409);
    expect(changedYear.body.code).toBe('ACTIVE_SCHOOL_YEAR_CHANGED');
    const changedCreation = await request().post('/api/v1/classes').set(headers).send({ name: 'C9 fantôme', levelId, expectedSchoolYearId: yearId });
    expect(changedCreation.status).toBe(409);
    await queryTenant(`UPDATE ${tenantTable('school_years')} SET status = 'active' WHERE id = $1`, [yearId]);
    const archived = await request().delete(`/api/v1/classes/${classId}`).set(headers);
    expect(archived.status).toBe(200);
    const inactive = await request().post('/api/v1/enrollments').set(headers).send(payload);
    expect(inactive.status).toBe(400);
    const [count] = await queryTenant<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${tenantTable('enrollments')} WHERE school_year_id = $1`, [yearId]);
    expect(count!.count).toBe('0');
    const [classCount] = await queryTenant<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${tenantTable('classes')} WHERE school_year_id = $1`, [yearId]);
    expect(classCount!.count).toBe('1');
  });
});
