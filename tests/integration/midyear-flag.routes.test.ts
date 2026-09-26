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
        address: 'Rue de l’école, Cocody',
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
  it('F37 : reprend matières, salles, classes, élèves, liens parents et solde initial depuis les mappings', async () => {
    const levelName = `Niveau reprise ${suffix}`;
    const className = `Classe reprise ${suffix}`;
    const matricule = `QA-MID-${suffix}`;
    const importFile = async (type: string, headers: string[], row: Array<string | number>, targets: string[]) => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Reprise');
      sheet.addRow(headers);
      sheet.addRow(row);
      const file = Buffer.from(await workbook.xlsx.writeBuffer());
      const base = `/api/v1/admin/schools/${tenantId}/midyear-import/${type}`;
      const saved = await request().put(`${base}/profile`).set(adminHeaders).send({
        label: `qa-${type}.xlsx`,
        fields: headers.map((sourceColumnLabel, index) => ({ sourceColumnLabel, targetField: targets[index], translations: [] })),
      });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      const profile = await request().get(`${base}/profile`).set(adminHeaders);
      expect(profile.status).toBe(200);
      expect(profile.body.profile.fields.map((field: { targetField: string }) => field.targetField).sort()).toEqual([...targets].sort());
      const preview = await request().post(`${base}/analyze`).set(adminHeaders).attach('file', file, `qa-${type}.xlsx`);
      expect(preview.status, JSON.stringify(preview.body)).toBe(200);
      expect(preview.body).toMatchObject({ rowCount: 1, missingTargets: [] });
      const result = await request().post(`${base}/confirm`).set(adminHeaders).attach('file', file, `qa-${type}.xlsx`);
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body).toEqual({ createdCount: 1, errors: [], totalRows: 1 });
    };

    await importFile('subjects', ['Niveau', 'Discipline', 'Coef'], [levelName, 'Mathématiques reprise QA', 4], ['niveau', 'matiere', 'coefficient']);
    await importFile('rooms', ['Salle', 'Places'], [`Salle reprise ${suffix}`, 35], ['nom', 'capacite']);
    await importFile('classes', ['Groupe', 'Niveau'], [className, levelName], ['nom', 'niveau']);
    await importFile('students', ['Code', 'Nom', 'Prénom', 'Groupe', 'Contact'], [matricule, 'Reprise', 'Aya', className, '2250700007777'], ['matricule', 'nom', 'prenom', 'classe', 'parent_phone']);
    await importFile('payments', ['Code', 'Déjà versé'], [matricule, 30_000], ['matricule', 'montant']);

    const subjects = await queryTenant<{ name: string; coefficient: string }>('SELECT name, coefficient::text FROM subjects WHERE name=$1', ['Mathématiques reprise QA']);
    expect(subjects).toEqual([{ name: 'Mathématiques reprise QA', coefficient: '4.000' }]);
    const rooms = await queryTenant<{ capacity: number; qr_token: string }>('SELECT capacity, qr_token FROM rooms WHERE name=$1', [`Salle reprise ${suffix}`]);
    expect(rooms[0]?.capacity).toBe(35);
    expect(rooms[0]?.qr_token).toBeTruthy();
    const links = await queryTenant<{ phone: string; class_name: string }>(`SELECT p.phone, c.name AS class_name
      FROM students s JOIN classes c ON c.id=s.class_id
      JOIN parent_student_links l ON l.student_id=s.id JOIN parents p ON p.id=l.parent_id
      WHERE s.matricule=$1`, [matricule]);
    expect(links).toEqual([{ phone: '2250700007777', class_name: className }]);
    const payments = await queryTenant<{ amount: string; source: string; status: string }>(`SELECT p.amount::text, p.source, p.status
      FROM payments p JOIN students s ON s.id=p.student_id WHERE s.matricule=$1`, [matricule]);
    expect(payments).toEqual([{ amount: '30000.00', source: 'migration_import', status: 'confirmed' }]);
    const grades = await queryTenant<{ count: number }>(`SELECT COUNT(*)::int AS count FROM evaluation_grades g JOIN students s ON s.id=g.student_id WHERE s.matricule=$1`, [matricule]);
    expect(grades[0]?.count).toBe(0);
  });
});
