import { beforeEach, describe, expect, it } from 'vitest';
import { PERMISSION_KEYS } from '../../src/modules/permissions/permissions.types.js';
import {
  getAuthHeaders, getSeedContext, queryPublic, queryTenant, request, tenantTable, TEST_SCHEMA_NAME,
} from './setup.js';

beforeEach(async () => {
  await queryTenant(`DELETE FROM ${tenantTable('position_assignments')}`);
  await queryTenant(`DELETE FROM ${tenantTable('admin_positions')}`);
  await queryPublic(`
    INSERT INTO public.tenants (name, subdomain, schema_name, plan, status, max_users, onboarding_completed, can_edit_sms_template)
    VALUES ('École C14', $1, $2, 'pro', 'active', 100, true, true)
    ON CONFLICT (schema_name) DO UPDATE SET can_edit_sms_template=true
  `, [TEST_SCHEMA_NAME.replaceAll('_', '-'), TEST_SCHEMA_NAME]);
  await setFeatures(true, true);
});

async function setFeatures(enabled: boolean, monetized: boolean) {
  await queryPublic(`
    INSERT INTO public.school_sms_features (tenant_id, is_enabled, monetize_parent_alerts)
    SELECT id, $1, $2 FROM public.tenants WHERE schema_name=$3
    ON CONFLICT (tenant_id) DO UPDATE SET is_enabled=EXCLUDED.is_enabled, monetize_parent_alerts=EXCLUDED.monetize_parent_alerts
  `, [enabled, monetized, TEST_SCHEMA_NAME]);
}

describe('C14 catalogue distribué et parcours de sauvegarde', () => {
  it('expose exactement chaque clé du catalogue backend, une seule fois', async () => {
    const headers = await getAuthHeaders('director');
    const response = await request().get('/api/v1/permissions/catalogue').set(headers).expect(200);
    expect(response.body.version).toBe(1);
    const entries = response.body.permissions as Array<{ key: string; domain: string; label: string; available: boolean }>;
    expect(entries.map((entry) => entry.key)).toEqual(PERMISSION_KEYS);
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(PERMISSION_KEYS.length);
    expect(entries.every((entry) => entry.label && entry.domain && entry.available)).toBe(true);
  });

  it('crée, met à jour, relit et attribue tous les droits sans altération implicite', async () => {
    const headers = await getAuthHeaders('director');
    const created = await request().post('/api/v1/permissions/positions').set(headers)
      .send({ name: 'Poste exhaustif', permissions: [...PERMISSION_KEYS, 'attendance.view'] }).expect(201);
    expect(created.body.position.permissions).toEqual(PERMISSION_KEYS);
    const id = created.body.position.id as string;
    const updated = await request().put(`/api/v1/permissions/positions/${id}`).set(headers)
      .send({ name: 'Poste renommé', permissions: [...PERMISSION_KEYS] }).expect(200);
    expect(updated.body.position.permissions).toEqual(PERMISSION_KEYS);
    const saved = await queryTenant<{ permissions: string[] }>(`SELECT permissions FROM ${tenantTable('admin_positions')} WHERE id=$1`, [id]);
    expect(saved[0].permissions).toEqual(PERMISSION_KEYS);
    await request().post(`/api/v1/permissions/positions/${id}/assign`).set(headers)
      .send({ userId: getSeedContext().staffUserId }).expect(200);
    const staffHeaders = await getAuthHeaders('staff');
    const me = await request().get('/api/v1/permissions/me').set(staffHeaders).expect(200);
    expect(me.body.permissions).toEqual(PERMISSION_KEYS);
  });

  it.each(PERMISSION_KEYS.filter((key) => key === 'settings.sms_templates' || key.startsWith('subscriptions.')))(
    'refuse une requête forgée portant %s et conserve la ligne existante', async (key) => {
      const headers = await getAuthHeaders('director');
      const created = await request().post('/api/v1/permissions/positions').set(headers)
        .send({ name: 'Poste préservé', permissions: ['attendance.view', 'payments.cancel'] }).expect(201);
      await setFeatures(false, false);
      await queryPublic('UPDATE public.tenants SET can_edit_sms_template=false WHERE schema_name=$1', [TEST_SCHEMA_NAME]);
      const payload = { permissions: ['attendance.view', key] };
      const rejected = await request().post('/api/v1/permissions/positions').set(headers)
        .send({ name: 'Poste forgé', ...payload }).expect(403);
      expect(rejected.body.code).toBe('PERMISSION_FEATURE_UNAVAILABLE');
      await request().put(`/api/v1/permissions/positions/${created.body.position.id}`).set(headers).send(payload).expect(403);
      const saved = await queryTenant<{ permissions: string[] }>(`SELECT permissions FROM ${tenantTable('admin_positions')}`);
      expect(saved).toEqual([{ permissions: ['attendance.view', 'payments.cancel'] }]);
    });

  it.each([[false, true], [true, false]])('refuse les abonnements avec service=%s et monétisation=%s', async (enabled, monetized) => {
    const headers = await getAuthHeaders('director');
    await setFeatures(enabled, monetized);
    const catalogue = await request().get('/api/v1/permissions/catalogue').set(headers).expect(200);
    expect(catalogue.body.permissions.find((entry: { key: string }) => entry.key === 'subscriptions.view').available).toBe(false);
    await request().post('/api/v1/permissions/positions').set(headers)
      .send({ name: 'Abonnements', permissions: ['subscriptions.view'] }).expect(403);
  });

  it('préserve les attributions historiques désactivées à la lecture et au renommage', async () => {
    const headers = await getAuthHeaders('director');
    const permissions = ['settings.sms_templates', 'subscriptions.view'];
    const created = await request().post('/api/v1/permissions/positions').set(headers)
      .send({ name: 'Historique', permissions }).expect(201);
    await setFeatures(false, false);
    await queryPublic('UPDATE public.tenants SET can_edit_sms_template=false WHERE schema_name=$1', [TEST_SCHEMA_NAME]);
    const config = await request().get('/api/v1/permissions/config').set(headers).expect(200);
    expect(config.body.positions[0].permissions).toEqual(permissions);
    await request().put(`/api/v1/permissions/positions/${created.body.position.id}`).set(headers)
      .send({ name: 'Historique renommé' }).expect(200);
    const saved = await queryTenant<{ permissions: string[] }>(`SELECT permissions FROM ${tenantTable('admin_positions')}`);
    expect(saved[0].permissions).toEqual(permissions);
  });

  it('settings.school permet la lecture et l’écriture école et refuse tous les accès administratifs', async () => {
    const headers = await getAuthHeaders('director');
    const position = await request().post('/api/v1/permissions/positions').set(headers)
      .send({ name: 'Informations école', permissions: ['settings.school'] }).expect(201);
    await request().post(`/api/v1/permissions/positions/${position.body.position.id}/assign`).set(headers)
      .send({ userId: getSeedContext().staffUserId }).expect(200);
    const staffHeaders = await getAuthHeaders('staff');
    const config = await request().get('/api/v1/permissions/config/school').set(staffHeaders).expect(200);
    expect(Object.keys(config.body)).toEqual(['school']);
    const updated = await request().patch('/api/v1/permissions/config/school').set(staffHeaders)
      .send({ name: 'École modifiée par le staff', address: 'Rue des écoles' }).expect(200);
    expect(Object.keys(updated.body)).toEqual(['school']);
    expect(updated.body.school.name).toBe('École modifiée par le staff');
    for (const path of ['config', 'positions', 'catalogue']) {
      await request().get(`/api/v1/permissions/${path}`).set(staffHeaders).expect(403);
    }
    await request().post('/api/v1/permissions/positions').set(staffHeaders).send({ name: 'Interdit', permissions: [] }).expect(403);
    await request().put(`/api/v1/permissions/positions/${position.body.position.id}`).set(staffHeaders).send({ name: 'Interdit' }).expect(403);
    await request().post('/api/v1/permissions/users').set(staffHeaders).send({ name: 'Interdit', password: 'Test1234!', email: 'test@example.test' }).expect(403);
  });

  it('settings.positions n’accorde pas settings.school', async () => {
    const headers = await getAuthHeaders('director');
    const position = await request().post('/api/v1/permissions/positions').set(headers)
      .send({ name: 'Postes seuls', permissions: ['settings.positions'] }).expect(201);
    await request().post(`/api/v1/permissions/positions/${position.body.position.id}/assign`).set(headers)
      .send({ userId: getSeedContext().staffUserId }).expect(200);
    const staffHeaders = await getAuthHeaders('staff');
    await request().get('/api/v1/permissions/config').set(staffHeaders).expect(200);
    await request().patch('/api/v1/permissions/config/school').set(staffHeaders).send({ name: 'Interdit' }).expect(403);
  });

  it('délègue la correction publiée à un censeur et retire aussitôt son accès après révocation', async () => {
    const directorHeaders = await getAuthHeaders('director');
    const permissions = ['report_cards.view', 'report_cards.publish', 'report_cards.published_correction'];
    const catalogue = await request().get('/api/v1/permissions/catalogue').set(directorHeaders).expect(200);
    expect(catalogue.body.permissions.find((entry: { key: string }) => entry.key === 'report_cards.published_correction'))
      .toMatchObject({ available: true, requiredPermissions: ['report_cards.view', 'report_cards.publish'] });
    const position = await request().post('/api/v1/permissions/positions').set(directorHeaders)
      .send({ name: 'Censeur délégué', permissions: permissions.slice(0, 2) }).expect(201);
    await request().post(`/api/v1/permissions/positions/${position.body.position.id}/assign`).set(directorHeaders)
      .send({ userId: getSeedContext().staffUserId }).expect(200);

    const staffHeaders = await getAuthHeaders('staff');
    const me = await request().get('/api/v1/permissions/me').set(staffHeaders).expect(200);
    expect(me.body.permissions).not.toContain('report_cards.published_correction');
    const [year] = await queryTenant<{ id: string }>(`
      INSERT INTO school_years (label, start_date, end_date, status)
      VALUES ('Délégation bulletins', '2026-09-01', '2027-06-30', 'active') RETURNING id::text
    `);
    const [level] = await queryTenant<{ id: string }>(`
      INSERT INTO levels (name, order_index) VALUES ('Niveau délégation', 991) RETURNING id::text
    `);
    const [schoolClass] = await queryTenant<{ id: string }>(`
      UPDATE classes SET school_year_id=$1, level_id=$2 WHERE name=$3 RETURNING id::text
    `, [year.id, level.id, getSeedContext().className]);
    const [subject] = await queryTenant<{ id: string }>(`
      INSERT INTO subjects (level_id, name, coefficient)
      VALUES ($1, 'Mathématiques déléguées', 4) RETURNING id::text
    `, [level.id]);
    const [period] = await queryTenant<{ id: string }>(`
      INSERT INTO grading_periods (school_year_id, type, order_index, label, start_date, review_start_date, end_date)
      VALUES ($1, 'trimester', 1, 'Trimestre 1', '2026-09-01', '2026-11-20', '2026-12-20') RETURNING id::text
    `, [year.id]);
    await queryTenant(`INSERT INTO teacher_subject_assignments (teacher_id, subject_id, class_id)
      VALUES ($1, $2, $3)`, [getSeedContext().teacherId, subject.id, schoolClass.id]);
    await queryTenant(`INSERT INTO class_subject_completion (class_id, subject_id, grading_period_id, status, completed_at)
      VALUES ($1, $2, $3, 'completed', now())`, [schoolClass.id, subject.id, period.id]);
    const [student] = await queryTenant<{ id: string }>(`
      INSERT INTO students (class_id, first_name, last_name)
      VALUES ($1, 'Élève', 'Délégué') RETURNING id::text
    `, [schoolClass.id]);
    await queryTenant(`INSERT INTO enrollments (student_id, class_id, school_year_id, type, status)
      VALUES ($1, $2, $3, 'new_registration', 'confirmed')`, [student.id, schoolClass.id, year.id]);
    await queryTenant(`INSERT INTO report_cards (student_id, class_id, grading_period_id,
      general_average, rank, class_average, class_min_average, class_max_average, class_headcount,
      status, published_at, published_by_user_id)
      VALUES ($1, $2, $3, 12, 1, 12, 12, 12, 1, 'published', now(), $4)`,
    [student.id, schoolClass.id, period.id, getSeedContext().directorUserId]);
    const scope = `?classId=${schoolClass.id}&gradingPeriodId=${period.id}`;
    const created = await request().post('/api/v1/report-cards/claims').set(staffHeaders).send({
      classId: schoolClass.id, studentId: student.id, subjectId: subject.id,
      gradingPeriodId: period.id, reason: 'La note publiée doit être corrigée',
    }).expect(201);
    expect(created.body.claim).toMatchObject({ id: expect.any(String) });
    const decisionPath = `/api/v1/report-cards/claims/${created.body.claim.id}/decision`;
    const decision = { decision: 'approved', reason: 'Erreur confirmée après vérification' };
    const refused = await request().post(decisionPath).set(staffHeaders).send(decision).expect(403);
    expect(refused.body.code).toBe('PUBLISHED_CORRECTION_FORBIDDEN');
    await request().put(`/api/v1/permissions/positions/${position.body.position.id}`).set(directorHeaders)
      .send({ permissions }).expect(200);
    expect((await request().get('/api/v1/permissions/me').set(staffHeaders).expect(200)).body.permissions)
      .toEqual(expect.arrayContaining(permissions));
    const approved = await request().post(decisionPath).set(staffHeaders).send(decision).expect(200);
    expect(approved.body.claim).toMatchObject({ status: 'approved', phase: 'published' });
    const versions = await request().get(`/api/v1/report-cards/versions${scope}`).set(staffHeaders).expect(200);
    expect(versions.body.versions).toHaveLength(1);
    expect(versions.body.versions[0].invalidation_reason).toBe(decision.reason);
    expect(await queryTenant(`SELECT id FROM report_cards WHERE class_id=$1 AND grading_period_id=$2`,
      [schoolClass.id, period.id])).toEqual([]);
    const audit = await request().get(`/api/v1/report-cards/audit${scope}`).set(staffHeaders).expect(200);
    expect(audit.body.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ actor_user_id: getSeedContext().staffUserId, operation: 'claim_approved' }),
    ]));

    await request().put(`/api/v1/permissions/positions/${position.body.position.id}`).set(directorHeaders)
      .send({ permissions: ['report_cards.view', 'report_cards.publish'] }).expect(200);
    const afterRevocation = await request().get('/api/v1/permissions/me').set(staffHeaders).expect(200);
    expect(afterRevocation.body.permissions).not.toContain('report_cards.published_correction');
    await request().get(`/api/v1/report-cards/audit${scope}`).set(staffHeaders).expect(403);
  });

  it('refuse une clé inventée sans créer de poste', async () => {
    await request().post('/api/v1/permissions/positions').set(await getAuthHeaders('director'))
      .send({ name: 'Droit forgé', permissions: ['permissions.root'] }).expect(400);
    expect(await queryTenant(`SELECT id FROM ${tenantTable('admin_positions')}`)).toEqual([]);
  });

  it('conserve le message métier et garantit un seul poste détenteur même en concurrence', async () => {
    const headers = await getAuthHeaders('director');
    const responses = await Promise.all(['Éducateur', 'Surveillant'].map((name) =>
      request().post('/api/v1/permissions/positions').set(headers).send({ name, permissions: ['conduct.finalize'] })
    ));
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const winner = responses.find((response) => response.status === 201)!;
    const rejected = responses.find((response) => response.status === 409)!;
    expect(rejected.body.error).toBe(`Cette permission est déjà attribuée au poste ${winner.body.position.name}, retirez-la d'abord avant de l'attribuer à un autre poste`);
    expect(rejected.body.code).toBe('CONDUCT_FINALIZE_ALREADY_HELD');
    await request().put(`/api/v1/permissions/positions/${winner.body.position.id}`).set(headers)
      .send({ permissions: ['conduct.finalize', 'attendance.view'] }).expect(200);
    const second = await request().post('/api/v1/permissions/positions').set(headers).send({ name: 'Autre poste', permissions: [] }).expect(201);
    await request().put(`/api/v1/permissions/positions/${second.body.position.id}`).set(headers).send({ permissions: ['conduct.finalize'] }).expect(409);
    await request().put(`/api/v1/permissions/positions/${winner.body.position.id}`).set(headers).send({ permissions: [] }).expect(200);
    await request().put(`/api/v1/permissions/positions/${second.body.position.id}`).set(headers).send({ permissions: ['conduct.finalize'] }).expect(200);
  });
});
