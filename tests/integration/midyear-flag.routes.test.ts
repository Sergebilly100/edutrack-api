import ExcelJS from 'exceljs';
import { beforeAll, describe, expect, it } from 'vitest';

import { signAccessToken } from '../../src/modules/auth/auth.service.js';
import { getSeedContext, queryPublic, queryTenant, request, TEST_SCHEMA_NAME } from './setup.js';

const suffix = String(Date.now());

type IdRow = { id: string };

describe('mid-year onboarding flag (8a)', () => {
  let tenantId = '';
  let adminHeaders: Record<string, string> = {};

  beforeAll(async () => {
    const rows = await queryPublic<IdRow>(
      `INSERT INTO public.tenants (name, subdomain, schema_name, plan, status, max_users, onboarding_completed)
       VALUES ($1, $2, $3, 'pro', 'active', 50, true)
       ON CONFLICT (schema_name) DO UPDATE SET updated_at = NOW()
       RETURNING id::text`,
      [`Midyear School ${suffix}`, `midyear-${suffix}`, TEST_SCHEMA_NAME]
    );
    tenantId = rows[0]!.id;
    const token = await signAccessToken({
      sub: getSeedContext().directorUserId,
      role: 'super_admin',
      schemaName: TEST_SCHEMA_NAME,
      tenantId,
    });
    adminHeaders = { authorization: `Bearer ${token}` };
  });

  it('active le flag puis expose midYearOnboarding dans les détails école', async () => {
    const enable = await request()
      .patch(`/api/v1/admin/schools/${tenantId}/mid-year-flag`)
      .set(adminHeaders)
      .send({ enabled: true });
    expect(enable.status, JSON.stringify(enable.body)).toBe(200);

    const details = await request()
      .get(`/api/v1/admin/schools/${tenantId}`)
      .set(adminHeaders);
    expect(details.status).toBe(200);
    expect(details.body.metadata.midYearOnboarding).toBe(true);
  });

  it('refuse un directeur d\u2019école sur cette action super admin', async () => {
    const token = await signAccessToken({
      sub: getSeedContext().directorUserId,
      role: 'director',
      schemaName: TEST_SCHEMA_NAME,
      tenantId,
    });
    const response = await request()
      .patch(`/api/v1/admin/schools/${tenantId}/mid-year-flag`)
      .set('authorization', `Bearer ${token}`)
      .send({ enabled: false });
    expect(response.status).toBe(403);
  });

  it('enregistre le flag dès la création de l’école', async () => {
    const schoolSuffix = `${suffix}-creation`;
    const response = await request()
      .post('/api/v1/admin/schools')
      .set(adminHeaders)
      .send({
        name: `École reprise ${schoolSuffix}`,
        subdomain: `reprise-${schoolSuffix}`,
        city: 'Abidjan',
        teaching_type: 'secondaire',
        director_name: 'Directrice Reprise',
        director_phone: '2250700000001',
        active_school_year: '09/2090 - 06/2091',
        plan: 'pro',
        midYearOnboarding: true,
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);

    const details = await request()
      .get(`/api/v1/admin/schools/${response.body.tenantId}`)
      .set(adminHeaders);
    expect(details.status).toBe(200);
    expect(details.body.metadata.midYearOnboarding).toBe(true);
  });

  it('enregistre un mapping de reprise puis importe le fichier associé', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Niveaux');
    sheet.addRow(['Libellé', 'Position']);
    const levelName = `Niveau reprise ${suffix}`;
    sheet.addRow([levelName, 1]);
    const file = Buffer.from(await workbook.xlsx.writeBuffer());

    const saveProfile = await request()
      .put(`/api/v1/admin/schools/${tenantId}/midyear-import/levels/profile`)
      .set(adminHeaders)
      .send({
        label: 'niveaux.xlsx',
        fields: [
          { sourceColumnLabel: 'Libellé', targetField: 'nom', translations: [] },
          { sourceColumnLabel: 'Position', targetField: 'ordre', translations: [] },
        ],
      });
    expect(saveProfile.status, JSON.stringify(saveProfile.body)).toBe(200);
    expect(saveProfile.body.profile.importType).toBe('midyear_levels');

    const analysis = await request()
      .post(`/api/v1/admin/schools/${tenantId}/midyear-import/levels/analyze`)
      .set(adminHeaders)
      .attach('file', file, 'niveaux.xlsx');
    expect(analysis.status, JSON.stringify(analysis.body)).toBe(200);
    expect(analysis.body.missingTargets).toEqual([]);

    await queryTenant('UPDATE school_years SET status = $1 WHERE status = $2', ['closed', 'active']);
    await queryTenant(
      `INSERT INTO school_years (label, start_date, end_date, end_of_year_review_start_date, status)
       VALUES ($1, '2090-09-01', '2091-06-30', '2091-05-01', 'active')`,
      [`reprise-${suffix}`]
    );

    const confirmed = await request()
      .post(`/api/v1/admin/schools/${tenantId}/midyear-import/levels/confirm`)
      .set(adminHeaders)
      .attach('file', file, 'niveaux.xlsx');
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body.createdCount).toBe(1);
    const levels = await queryTenant<{ name: string }>('SELECT name FROM levels WHERE name = $1', [levelName]);
    expect(levels).toEqual([{ name: levelName }]);
  });
});
