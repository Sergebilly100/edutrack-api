import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';

import { getAuthHeaders, queryTenant, request, tenantTable } from './setup.js';

const workbookBuffer = async (headers: string[], rows: Array<Array<string | number>>): Promise<Buffer> => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Caisse');
  sheet.addRow(headers);
  rows.forEach((row) => sheet.addRow(row));
  return Buffer.from(await workbook.xlsx.writeBuffer());
};

const createImportContext = async () => {
  const suffix = String(Date.now());
  await queryTenant(`UPDATE ${tenantTable('school_years')} SET status = 'closed' WHERE status = 'active'`);
  const years = await queryTenant<{ id: string }>(`
    INSERT INTO ${tenantTable('school_years')}
      (label, start_date, end_date, end_of_year_review_start_date, status)
    VALUES ($1, '2090-09-01', '2091-06-30', '2091-05-01', 'active') RETURNING id::text
  `, [`import-${suffix}`]);
  const levels = await queryTenant<{ id: string }>(`
    INSERT INTO ${tenantTable('levels')} (name, order_index, is_exam_class)
    VALUES ($1, 99000, false) RETURNING id::text
  `, [`Import level ${suffix}`]);
  const classes = await queryTenant<{ id: string }>(`
    INSERT INTO ${tenantTable('classes')} (name, level_id, school_year_id, is_active)
    VALUES ($1, $2::uuid, $3::uuid, true) RETURNING id::text
  `, [`Import class ${suffix}`, levels[0]!.id, years[0]!.id]);
  const matricule = `PAY-${suffix}`;
  const students = await queryTenant<{ id: string }>(`
    INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, matricule)
    VALUES ($1::uuid, 'Aya', 'Import', $2) RETURNING id::text
  `, [classes[0]!.id, matricule]);
  await queryTenant(`
    INSERT INTO ${tenantTable('enrollments')} (student_id, class_id, school_year_id, type, status)
    VALUES ($1::uuid, $2::uuid, $3::uuid, 'new_registration', 'confirmed')
  `, [students[0]!.id, classes[0]!.id, years[0]!.id]);
  return { headers: await getAuthHeaders('director'), schoolYearId: years[0]!.id, studentId: students[0]!.id, matricule };
};

const mappingBody = {
  label: 'Export caisse',
  fields: [
    { sourceColumnLabel: 'Code élève', targetField: 'matricule', translations: [] },
    { sourceColumnLabel: 'Somme', targetField: 'montant', translations: [] },
    { sourceColumnLabel: 'Jour', targetField: 'date', translations: [] },
    { sourceColumnLabel: 'Réf', targetField: 'reference', translations: [] },
    { sourceColumnLabel: 'Canal', targetField: 'method', translations: [
      { sourceValue: 'Caisse', targetValue: 'cash' },
      { sourceValue: 'Orange Money', targetValue: 'mobile_money' },
    ] },
  ],
};

describe('payment mapping import integration', () => {
  it('configure le premier mapping puis importe les lignes valides', async () => {
    const context = await createImportContext();
    const file = await workbookBuffer(
      ['Code élève', 'Somme', 'Jour', 'Réf', 'Canal'],
      [[context.matricule, 25_000, '2090-10-10', 'OM-001', 'Orange Money']]
    );
    const analysis = await request().post('/api/v1/payment-import/analyze').set(context.headers).attach('file', file, 'caisse.xlsx');
    expect(analysis.status).toBe(200);
    expect(analysis.body.profile).toBeNull();
    expect(analysis.body.headers).toEqual(['Code élève', 'Somme', 'Jour', 'Réf', 'Canal']);

    const profile = await request().put('/api/v1/payment-import/profile').set(context.headers).send(mappingBody);
    expect(profile.status, JSON.stringify(profile.body)).toBe(200);
    expect(profile.body.profile.isActive).toBe(true);

    const preview = await request().post('/api/v1/payment-import/preview').set(context.headers).attach('file', file, 'caisse.xlsx');
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body).toMatchObject({ totalRows: 1, errors: [] });
    expect(preview.body.validRows[0]).toMatchObject({ matricule: context.matricule, amount: 25_000, method: 'mobile_money' });

    const confirmed = await request().post('/api/v1/payment-import/confirm').set(context.headers).attach('file', file, 'caisse.xlsx');
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);
    expect(confirmed.body.createdCount).toBe(1);
    const payments = await queryTenant<{ source: string; payment_date: string; provider_reference: string }>(`
      SELECT source::text, payment_date::text, provider_reference
      FROM ${tenantTable('payments')} WHERE student_id = $1::uuid
    `, [context.studentId]);
    expect(payments).toEqual([{ source: 'bulk_import', payment_date: '2090-10-10', provider_reference: 'OM-001' }]);
  });

  it('réassocie automatiquement les mêmes libellés dans un ordre différent', async () => {
    const context = await createImportContext();
    await request().put('/api/v1/payment-import/profile').set(context.headers).send(mappingBody);
    const file = await workbookBuffer(
      ['Canal', 'Réf', 'Jour', 'Somme', 'Code élève'],
      [['Caisse', 'CA-002', '2090-10-11', 10_000, context.matricule]]
    );
    const analysis = await request().post('/api/v1/payment-import/analyze').set(context.headers).attach('file', file, 'suivant.xlsx');
    expect(analysis.status).toBe(200);
    expect(analysis.body.matchedFields).toHaveLength(5);
    expect(analysis.body.missingRequiredTargets).toEqual([]);
  });

  it('isole une ligne dont le matricule est introuvable', async () => {
    const context = await createImportContext();
    await request().put('/api/v1/payment-import/profile').set(context.headers).send(mappingBody);
    const file = await workbookBuffer(
      ['Code élève', 'Somme', 'Jour', 'Réf', 'Canal'],
      [['INCONNU', 12_000, '2090-10-12', 'CA-003', 'Caisse']]
    );
    const preview = await request().post('/api/v1/payment-import/preview').set(context.headers).attach('file', file, 'erreur.xlsx');
    expect(preview.status).toBe(200);
    expect(preview.body.validRows).toEqual([]);
    expect(preview.body.errors[0].reason).toContain('matricule introuvable : INCONNU');
  });

  it('écarte un matricule existant sans inscription confirmée', async () => {
    const context = await createImportContext();
    await queryTenant(`UPDATE ${tenantTable('enrollments')} SET status = 'pending_cashier'
      WHERE student_id = $1::uuid AND school_year_id = $2::uuid`, [context.studentId, context.schoolYearId]);
    await request().put('/api/v1/payment-import/profile').set(context.headers).send(mappingBody);
    const file = await workbookBuffer(
      ['Code élève', 'Somme', 'Jour', 'Réf', 'Canal'],
      [[context.matricule, 25_000, '2090-10-10', 'OM-PENDING', 'Orange Money']]
    );
    const preview = await request().post('/api/v1/payment-import/preview').set(context.headers)
      .attach('file', file, 'en-attente.xlsx');
    expect(preview.status).toBe(200);
    expect(preview.body.validRows).toEqual([]);
    expect(preview.body.errors).toHaveLength(1);
    const confirm = await request().post('/api/v1/payment-import/confirm').set(context.headers)
      .attach('file', file, 'en-attente.xlsx');
    expect(confirm.status).toBe(201);
    expect(confirm.body.createdCount).toBe(0);
    const payments = await queryTenant<{ id: string }>(`
      SELECT id::text FROM ${tenantTable('payments')} WHERE student_id = $1::uuid
    `, [context.studentId]);
    expect(payments).toHaveLength(0);
  });
});
