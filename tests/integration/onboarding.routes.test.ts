import { beforeAll, describe, expect, it } from 'vitest';
import { signAccessToken } from '../../src/modules/auth/auth.service.js';
import { getAuthHeaders, getSeedContext, queryPublic, queryTenant, request, TEST_SCHEMA_NAME } from './setup.js';

describe('C6 configuration initiale', () => {
  let tenantId: string;
  beforeAll(async () => {
    const [tenant] = await queryPublic<{ id: string }>(
      `INSERT INTO public.tenants (name, subdomain, schema_name, plan, status, onboarding_completed)
       VALUES ('École C6', $1, $2, 'pro', 'active', false) RETURNING id::text`,
      [TEST_SCHEMA_NAME.replaceAll('_', '-'), TEST_SCHEMA_NAME]);
    tenantId = tenant!.id;
  });
  it('refuse la lecture, la modification et la finalisation sans droit de configuration', async () => {
    for (const role of ['teacher', 'staff'] as const) {
      const headers = await getAuthHeaders(role);
      expect((await request().get('/api/v1/school/onboarding-status').set(headers)).status).toBe(403);
      expect((await request().patch('/api/v1/school/onboarding-complete').set(headers)).status).toBe(403);
      expect((await request().patch('/api/v1/school/info').set(headers).send({ address: 'Forbidden' })).status).toBe(403);
    }
  });
  it('suit le parcours directeur après ouverture par le super administrateur', async () => {
    const director = await getAuthHeaders('director');
    const initial = await request().get('/api/v1/school/onboarding-status').set(director);
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ schoolId: tenantId, activeYear: false, canComplete: false });
    const blocked = await request().patch('/api/v1/school/onboarding-complete').set(director);
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ code: 'ONBOARDING_PREREQUISITES_MISSING', missing: expect.arrayContaining(['activeYear']) });
    expect(blocked.body.error).toContain('super administrateur');
    const yearInput = { label: '09/2090 - 06/2091', start_date: '2090-09-01', end_date: '2091-06-30', period_type: 'trimester' };
    expect((await request().post('/api/v1/school-years').set(director).send(yearInput)).status).toBe(404);
    expect((await request().post(`/api/v1/admin/schools/${tenantId}/school-year/open`).set(director).send(yearInput)).status).toBe(403);
    const admin = { authorization: `Bearer ${await signAccessToken({ sub: getSeedContext().superAdminUserId,
      role: 'super_admin', schemaName: TEST_SCHEMA_NAME, tenantId })}` };
    const opened = await request().post(`/api/v1/admin/schools/${tenantId}/school-year/open`).set(admin).send(yearInput);
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const saved = await request().patch('/api/v1/school/info').set(director)
      .send({ name: 'École C6 configurée', address: 'Abidjan, Cocody', phone: '2250700001111' });
    expect(saved.status).toBe(200);
    const level = await request().post('/api/v1/levels').set(director).send({ name: 'Niveau C6', orderIndex: 1 });
    expect(level.status).toBe(201);
    const subject = await request().post('/api/v1/subjects').set(director).send({ levelId: level.body.level.id, name: 'Mathématiques C6', coefficient: 1 });
    expect(subject.status).toBe(201);
    const room = await request().post('/api/v1/rooms').set(director).send({ name: 'Salle C6' });
    expect(room.status).toBe(201);
    const fees = await request().put(`/api/v1/tuition-plans/levels/${level.body.level.id}`).set(director)
      .send({ schoolYearId: opened.body.id, totalAmount: 100000, currency: 'FCFA', scheduleSteps: [] });
    expect(fees.status, JSON.stringify(fees.body)).toBe(200);
    // No teacher profiles are needed to finish.
    await queryTenant("UPDATE users SET is_active = false WHERE role = 'teacher'");
    const ready = await request().get('/api/v1/school/onboarding-status').set(director);
    expect(ready.body).toMatchObject({ schoolInfoComplete: true, activeYear: true, levels: true, subjects: true,
      rooms: true, fees: true, teachers: false, canComplete: true, missing: [] });
    expect((await request().patch('/api/v1/school/onboarding-complete').set(director)).status).toBe(200);
    expect((await request().get('/api/v1/school/info').set(director)).body.onboarding_completed).toBe(true);
    // A year closure immediately makes old fees insufficient and prevents a direct API bypass.
    await queryTenant("UPDATE school_years SET status = 'closed' WHERE status = 'active'");
    const stale = await request().get('/api/v1/school/onboarding-status').set(director);
    expect(stale.body).toMatchObject({ activeYear: false, fees: false, canComplete: false });
    expect((await request().patch('/api/v1/school/onboarding-complete').set(director)).status).toBe(409);
  });
});
