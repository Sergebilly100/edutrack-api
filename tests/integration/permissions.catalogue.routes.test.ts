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
