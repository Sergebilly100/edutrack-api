import ExcelJS from 'exceljs';
import { readFile } from 'node:fs/promises';
import { HISTORICAL_STUDENT_TARGETS } from '../../src/modules/import-export/historical-students.types.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { getAuthHeaders, getSeedContext, queryTenant, queryPublic, request, tenantTable, TEST_SCHEMA_NAME } from './setup.js';

const root = '/api/v1/import/historical-students';
const fields = ['matricule', 'nom', 'prenom', 'parent_phone'].map((targetField) => ({
  targetField, sourceColumnLabel: targetField, isRequired: targetField !== 'parent_phone', translations: [],
}));
const file = async (values: string[][]) => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Historique');
  sheet.addRows([['matricule', 'nom', 'prenom', 'parent_phone'], ...values]);
  return Buffer.from(await book.xlsx.writeBuffer());
};
const counts = async (ids: string[]) => queryTenant<{ inscriptions: number; payments: number; finance: number; documents: number; parents: number }>(`
  SELECT (SELECT count(*)::int FROM enrollments WHERE student_id = ANY($1::uuid[])) AS inscriptions,
    (SELECT count(*)::int FROM payments WHERE student_id = ANY($1::uuid[])) AS payments,
    (SELECT count(*)::int FROM student_financial_status WHERE student_id = ANY($1::uuid[])) AS finance,
    ((SELECT count(*)::int FROM student_documents WHERE student_id = ANY($1::uuid[])) +
     (SELECT count(*)::int FROM documents WHERE entity_id = ANY($1::uuid[]))) AS documents,
    (SELECT count(*)::int FROM parent_student_links WHERE student_id = ANY($1::uuid[])) AS parents
`, [ids]);

describe('director historical import C7', () => {
  let headers: Record<string, string>;
  beforeAll(async () => {
    headers = await getAuthHeaders('director');
    await queryPublic(`INSERT INTO public.tenants (name, subdomain, schema_name, plan, status, onboarding_completed)
      VALUES ('C7 initial', $1, $2, 'pro', 'active', false)
      ON CONFLICT (schema_name) DO UPDATE SET onboarding_completed = false`, [TEST_SCHEMA_NAME, TEST_SCHEMA_NAME]);
  });

  it('maps and imports valid lines without class, retains errors, replays, then enrolls an imported profile', async () => {
    const mapping = await request().put(`${root}/profile`).set(headers).send({ fields });
    expect(mapping.status, JSON.stringify(mapping.body)).toBe(200);
    expect(mapping.body.profile.importType).toBe('historical_students');
    const buffer = await file([['C7-H1', 'Kone', 'Aya', '2250700000000'], ['C7-H2', 'Yao', 'Jean', ''], ['C7-BAD', '', 'Ali', 'invalid']]);
    const analysis = await request().post(`${root}/analyze`).set(headers).field('schoolYearLabel', '2024-2025').attach('file', buffer, 'historical.xlsx');
    expect(analysis.status).toBe(200);
    expect(analysis.body).toMatchObject({ validCount: 2, rowCount: 3, missingTargets: [] });
    expect(analysis.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ rowNumber: 4, field: 'nom' }), expect.objectContaining({ rowNumber: 4, field: 'parent_phone' })]));
    const confirm = await request().post(`${root}/confirm`).set(headers).field('schoolYearLabel', '2024-2025').attach('file', buffer, 'historical.xlsx');
    expect(confirm.status, JSON.stringify(confirm.body)).toBe(200);
    expect(confirm.body).toMatchObject({ createdCount: 2, reusedCount: 0, totalRows: 3 });
    const students = await queryTenant<{ id: string; class_id: string | null }>('SELECT id::text, class_id FROM students WHERE matricule IN ($1, $2) ORDER BY matricule', ['C7-H1', 'C7-H2']);
    expect(students).toHaveLength(2);
    expect(students.every((student) => student.class_id === null)).toBe(true);
    expect((await counts(students.map((student) => student.id)))[0]).toEqual({ inscriptions: 0, payments: 0, finance: 0, documents: 0, parents: 0 });
    const list = await request().get('/api/v1/students?search=C7-H1').set(headers);
    expect(list.body.data).toEqual([]);
    expect(list.body.pagination.total).toBe(0);
    const profiles = await request().get('/api/v1/students/profiles?search=C7-H1').set(headers);
    expect(profiles.status).not.toBe(200);
    const studentId = students[0]!.id;
    const detail = await request().get(`/api/v1/students/${studentId}`).set(headers);
    expect(detail.status).toBe(200);
    expect(detail.body.data.classId).toBeNull();
    const replay = await request().post(`${root}/confirm`).set(headers).field('schoolYearLabel', '2024-2025').attach('file', buffer, 'historical.xlsx');
    expect(replay.body).toMatchObject({ createdCount: 0, reusedCount: 2 });
    expect((await counts(students.map((student) => student.id)))[0]?.inscriptions).toBe(0);

    await queryTenant("UPDATE school_years SET status = 'closed' WHERE status = 'active'");
    const year = (await queryTenant<{ id: string }>("INSERT INTO school_years (label,start_date,end_date,status) VALUES ('C7 future','2091-09-01','2092-06-30','active') RETURNING id::text"))[0]!;
    const level = (await queryTenant<{ id: string }>("INSERT INTO levels (name, order_index, is_exam_class) VALUES ('C7 niveau', 707, false) RETURNING id::text"))[0]!;
    const klass = (await queryTenant<{ id: string }>('INSERT INTO classes (name, level_id, school_year_id) VALUES ($1,$2::uuid,$3::uuid) RETURNING id::text', ['C7 classe', level.id, year.id]))[0]!;
    const tuition = await request().put(`/api/v1/tuition-plans/levels/${level.id}`).set(headers).send({ schoolYearId: year.id, totalAmount: 50000, currency: 'FCFA', scheduleSteps: [] });
    expect(tuition.status).toBe(200);
    const enrollment = await request().post('/api/v1/enrollments').set(headers).send({ studentId, classId: klass.id, schoolYearId: year.id, type: 'new_registration' });
    expect(enrollment.status, JSON.stringify(enrollment.body)).toBe(201);
    expect(enrollment.body.enrollment.status).toBe('pending_cashier');
    const beforePayment = await request().get(`/api/v1/students?class_id=${klass.id}`).set(headers);
    expect(beforePayment.body.data).toEqual([]);
    const pendingRoster = await request().get('/api/v1/students?search=C7-H1').set(headers);
    expect(pendingRoster.body.data).toEqual([]);
    expect(pendingRoster.body.pagination.total).toBe(0);
    const pendingProfiles = await request().get('/api/v1/students/profiles?search=C7-H1').set(headers);
    expect(pendingProfiles.status).not.toBe(200);
    const payment = await request().post(`/api/v1/enrollments/${enrollment.body.enrollment.id}/confirm-payment`).set(headers)
      .send({ amount: 50000, method: 'cash', schoolReceiptReference: 'C7-RC-1' });
    expect(payment.status, JSON.stringify(payment.body)).toBe(200);
    const afterPayment = await request().get(`/api/v1/students/${studentId}`).set(headers);
    expect(afterPayment.body.data.classId).toBe(klass.id);
    const confirmedRoster = await request().get('/api/v1/students?search=C7-H1').set(headers);
    expect(confirmedRoster.body.data).toEqual([expect.objectContaining({ id: studentId, classId: klass.id })]);
    expect(confirmedRoster.body.pagination.total).toBe(1);
    expect((await queryTenant('SELECT class_id FROM students WHERE id = $1', [studentId]))[0]?.class_id).toBeNull();
    const persisted = await counts([studentId]);
    expect(persisted[0]).toMatchObject({ inscriptions: 1, payments: 1 });
    const safeReplay = await request().post(`${root}/confirm`).set(headers).field('schoolYearLabel', '2024-2025').attach('file', buffer, 'historical.xlsx');
    expect(safeReplay.body).toMatchObject({ createdCount: 0, reusedCount: 2 });
    expect(await counts([studentId])).toEqual(persisted);
  });

  it('preserves an enrolled profile on identity conflicts and reports the row/field', async () => {
    const response = await request().post(`${root}/confirm`).set(headers).field('schoolYearLabel', '2024-2025')
      .attach('file', await file([['C7-H1', 'Different', 'Identity', '']]), 'conflict.xlsx');
    expect(response.body.createdCount).toBe(0);
    expect(response.body.errors).toEqual([{ rowNumber: 2, sheetName: 'Historique', field: 'matricule', reason: 'Matricule déjà utilisé par un autre profil', code: 'MATRICULE_ALREADY_EXISTS' }]);
    expect((await queryTenant('SELECT last_name FROM students WHERE matricule = $1', ['C7-H1']))[0]?.last_name).toBe('Kone');
  });

  it('uses the enrollment class despite a stale legacy class and protects profile edits', async () => {
    const student = (await queryTenant<{ id: string; class_id: string }>(`SELECT s.id, e.class_id FROM students s
      JOIN enrollments e ON e.student_id = s.id WHERE s.matricule = 'C7-H1'`))[0]!;
    const legacyClass = (await queryTenant<{ class_id: string }>('SELECT class_id FROM schedules WHERE id = $1', [getSeedContext().scheduleId]))[0]!.class_id;
    await queryTenant('UPDATE students SET class_id = $1 WHERE id = $2', [legacyClass, student.id]);
    const detail = await request().get(`/api/v1/students/${student.id}`).set(headers);
    expect(detail.body.data.classId).toBe(student.class_id);
    const roster = await request().get(`/api/v1/students?class_id=${student.class_id}`).set(headers);
    expect(roster.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: student.id })]));
    const rejected = await request().put(`/api/v1/students/${student.id}`).set(headers).send({ class_id: legacyClass });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(409);
    expect(rejected.body.code).toBe('ENROLLMENT_CLASS_MANAGED');
    const inactive = await request().put(`/api/v1/students/${student.id}`).set(headers).send({ is_active: false });
    expect(inactive.status, JSON.stringify(inactive.body)).toBe(200);
    expect((await queryTenant('SELECT student_count FROM classes WHERE id = $1', [student.class_id]))[0]?.student_count).toBe(0);
    await request().put(`/api/v1/students/${student.id}`).set(headers).send({ is_active: true });
    const removed = await request().delete(`/api/v1/students/${student.id}`).set(headers);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body.data.classId).toBe(student.class_id);
    expect((await queryTenant('SELECT student_count FROM classes WHERE id = $1', [student.class_id]))[0]?.student_count).toBe(0);
    await request().put(`/api/v1/students/${student.id}`).set(headers).send({ is_active: true });
  });

  it('rolls back a failed line and commits its valid neighbors without database details', async () => {
    await queryTenant(`CREATE FUNCTION c7_reject_line() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.matricule = 'C7-FAIL' THEN RAISE EXCEPTION 'private synthetic payload'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER c7_reject_line BEFORE INSERT ON students FOR EACH ROW EXECUTE FUNCTION c7_reject_line();`);
    try {
      const response = await request().post(`${root}/confirm`).set(headers).field('schoolYearLabel', '2024-2025').attach('file',
        await file([['C7-BEFORE', 'Test', 'Before', ''], ['C7-FAIL', 'Test', 'Fail', ''], ['C7-AFTER', 'Test', 'After', '']]), 'transaction.xlsx');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ createdCount: 2, reusedCount: 0 });
      expect(response.body.errors).toEqual([expect.objectContaining({ rowNumber: 3, field: 'profil' })]);
      expect(JSON.stringify(response.body)).not.toContain('private synthetic payload');
      const rows = await queryTenant<{ id: string; matricule: string }>("SELECT id, matricule FROM students WHERE matricule IN ('C7-BEFORE','C7-FAIL','C7-AFTER') ORDER BY matricule");
      expect(rows.map((row) => row.matricule)).toEqual(['C7-AFTER', 'C7-BEFORE']);
      expect((await counts(rows.map((row) => row.id)))[0]).toEqual({ inscriptions: 0, payments: 0, finance: 0, documents: 0, parents: 0 });
    } finally {
      await queryTenant('DROP TRIGGER c7_reject_line ON students; DROP FUNCTION c7_reject_line();');
    }
  });

  it('forbids legacy class import during onboarding and takeover mapping/routes for director', async () => {
    const legacy = await request().post('/api/v1/import/students/confirm').set(headers).field('schoolYearLabel', '2024-2025').attach('file', await file([['OLD', 'Kone', 'Aya', '']]), 'legacy.xlsx');
    expect(legacy.status).toBe(403);
    expect(legacy.body.code).toBe('HISTORICAL_IMPORT_REQUIRED');
    const mapping = await request().put(`${root}/profile`).set(headers).send({ fields: [...fields.slice(0, 3), { ...fields[3]!, targetField: 'classe' }] });
    expect(mapping.status).toBe(400);
    const tenants = await queryPublic<{ id: string }>('SELECT id::text FROM public.tenants WHERE schema_name = $1', [TEST_SCHEMA_NAME]);
    const takeover = await request().post(`/api/v1/admin/schools/${tenants[0]!.id}/midyear-import/students/confirm`).set(headers).field('schoolYearLabel', '2024-2025').attach('file', await file([]), 'takeover.xlsx');
    expect(takeover.status).toBe(403);
    const teacher = await request().get(`${root}/profile`).set(await getAuthHeaders('teacher'));
    expect(teacher.status).toBe(403);
  });

  it('provides exactly the existing student workbook, including all parent columns and sheets', async () => {
    const response = await request().get(`${root}/template`).set(headers).buffer(true).parse((res, callback) => {
      const chunks: Buffer[] = []; res.on('data', (chunk: Buffer) => chunks.push(chunk)); res.on('end', () => callback(null, Buffer.concat(chunks)));
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(await readFile('templates/students.xlsx'));
  });

  it('reapplies migration twice without changing legacy classes, enrollment statuses or payments', async () => {
    const legacyClass = (await queryTenant<{ class_id: string }>('SELECT class_id::text FROM schedules WHERE id = $1', [getSeedContext().scheduleId]))[0]!.class_id;
    const legacy = (await queryTenant<{ id: string }>('INSERT INTO students (class_id,first_name,last_name,matricule) VALUES ($1,$2,$3,$4) RETURNING id', [legacyClass, 'Legacy', 'C7', 'C7-LEGACY']))[0]!;
    const before = await queryTenant('SELECT id, class_id, status, school_year_id FROM enrollments ORDER BY id');
    const payments = await queryTenant('SELECT id, amount, status FROM payments ORDER BY id');
    const source = (await readFile('src/shared/database/migrations/0074_historical_student_profiles.sql', 'utf8')).replaceAll('"tenant"', `"${TEST_SCHEMA_NAME}"`);
    for (let attempt = 0; attempt < 2; attempt++) for (const statement of source.split('--> statement-breakpoint')) await queryTenant(statement);
    expect(await queryTenant('SELECT id, class_id, status, school_year_id FROM enrollments ORDER BY id')).toEqual(before);
    expect(await queryTenant('SELECT id, amount, status FROM payments ORDER BY id')).toEqual(payments);
    expect((await queryTenant('SELECT class_id FROM students_with_class WHERE id = $1', [legacy.id]))[0]?.class_id).toBe(legacyClass);
  });

  it('upgrades a NOT NULL schema with legacy and enrolled profiles before accepting unclassified profiles', async () => {
    const schemaName = `${TEST_SCHEMA_NAME}_upgrade`;
    const target = `"${schemaName}"`;
    await queryPublic(`CREATE SCHEMA ${target}`);
    try {
      for (const table of ['school_years', 'classes', 'students', 'enrollments']) {
        await queryPublic(`CREATE TABLE ${target}.${table} (LIKE ${tenantTable(table)} INCLUDING ALL)`);
      }
      await queryPublic(`INSERT INTO ${target}.school_years SELECT * FROM ${tenantTable('school_years')}`);
      await queryPublic(`INSERT INTO ${target}.classes SELECT * FROM ${tenantTable('classes')}`);
      await queryPublic(`ALTER TABLE ${target}.students ALTER COLUMN class_id SET NOT NULL`);
      const legacyClass = (await queryTenant<{ class_id: string }>('SELECT class_id FROM schedules WHERE id = $1', [getSeedContext().scheduleId]))[0]!.class_id;
      const student = (await queryTenant<{ class_id: string; school_year_id: string }>(`SELECT e.class_id, e.school_year_id
        FROM enrollments e JOIN students s ON s.id = e.student_id WHERE s.matricule = 'C7-H1'`))[0]!;
      const profiles = await queryPublic<{ id: string }>(`INSERT INTO ${target}.students (class_id,first_name,last_name,matricule)
        VALUES ($1,'Existing','Enrolled','UPGRADE-ENROLLED'),($1,'Existing','Legacy','UPGRADE-LEGACY') RETURNING id`, [legacyClass]);
      await queryPublic(`INSERT INTO ${target}.enrollments (student_id,class_id,school_year_id,type,status)
        VALUES ($1,$2,$3,'new_registration','confirmed')`, [profiles[0]!.id, student.class_id, student.school_year_id]);
      const before = await queryPublic(`SELECT id, class_id, status, school_year_id FROM ${target}.enrollments`);
      const source = (await readFile('src/shared/database/migrations/0074_historical_student_profiles.sql', 'utf8')).replaceAll('"tenant"', target);
      for (const statement of source.split('--> statement-breakpoint')) await queryPublic(statement);
      const historical = await queryPublic(`INSERT INTO ${target}.students (first_name,last_name,matricule)
        VALUES ('Historical','Profile','UPGRADE-HISTORY') RETURNING class_id`);
      expect(historical[0]?.class_id).toBeNull();
      const classes = await queryPublic(`SELECT matricule,class_id FROM ${target}.students_with_class ORDER BY matricule`);
      expect(classes).toEqual([
        { matricule: 'UPGRADE-ENROLLED', class_id: student.class_id },
        { matricule: 'UPGRADE-HISTORY', class_id: null },
        { matricule: 'UPGRADE-LEGACY', class_id: legacyClass },
      ]);
      for (const statement of source.split('--> statement-breakpoint')) await queryPublic(statement);
      expect(await queryPublic(`SELECT id, class_id, status, school_year_id FROM ${target}.enrollments`)).toEqual(before);
      expect((await queryPublic(`SELECT class_id FROM ${target}.students WHERE id = $1`, [profiles[0]!.id]))[0]?.class_id).toBe(legacyClass);
    } finally {
      await queryPublic(`DROP SCHEMA ${target} CASCADE`);
    }
  });

  it('imports the original multi-sheet model with both parents, dates and per-student historical classes', async () => {
    const model = new ExcelJS.Workbook();
    await model.xlsx.readFile('templates/students.xlsx');
    const dataSheets = model.worksheets.filter((sheet) => sheet.name !== 'README');
    const headersRow = dataSheets[0]!.getRow(1).values as string[];
    const labels = headersRow.slice(1);
    const mapping = HISTORICAL_STUDENT_TARGETS.map((target) => ({
      targetField: target.key, sourceColumnLabel: target.key === 'historical_class' ? 'Classe*' : target.required ? `${target.label}*` : target.label, isRequired: target.required, translations: [],
    }));
    // The standard workbook columns are identity, class, DOB and all supported parents.
    expect(labels).toEqual(['Matricule', 'Prénom*', 'Nom*', 'Classe*', 'Date de naissance', 'Nom parent', 'Téléphone parent', 'Email parent', 'Nom parent 2', 'Téléphone parent 2']);
    for (const sheet of dataSheets) sheet.spliceRows(2, sheet.rowCount);
    dataSheets[0]!.addRow(['C7-PARENTS', 'Test', 'Parents', 'Ancienne 4e A', new Date('2010-03-04T00:00:00Z'), 'Parent A', '2250700000000', 'parent@example.ci', 'Parent B', '2250100000000']);
    dataSheets[1]!.addRow(['C7-SHEET', 'Test', 'Feuille', '', '', 'Parent C', '', '', '', '']);
    const buffer = Buffer.from(await model.xlsx.writeBuffer());
    const checked = await request().post(`${root}/analyze`).set(headers).field('schoolYearLabel', '2023/2024').attach('file', buffer, 'students.xlsx');
    expect(checked.status, JSON.stringify(checked.body)).toBe(200);
    expect(checked.body).toMatchObject({ schoolYearLabel: '2023-2024', validCount: 2, rowCount: 2, missingTargets: [] });
    expect(checked.body.matchedFields).toEqual(expect.arrayContaining(mapping.map((field) => expect.objectContaining(field))));
    expect(checked.body.matchedFields).toHaveLength(10);
    expect((await request().put(`${root}/profile`).set(headers).send({ fields: mapping })).status).toBe(200);
    const confirmed = await request().post(`${root}/confirm`).set(headers).field('schoolYearLabel', '2023-2024').attach('file', buffer, 'students.xlsx');
    expect(confirmed.body).toMatchObject({ createdCount: 2, reusedCount: 0, errors: [] });
    const profiles = await queryTenant<{ id: string; matricule: string }>("SELECT id,matricule,class_id,birth_date::text,parent_name,parent_phone,parent_email,parent_name_2,parent_phone_2 FROM students WHERE matricule IN ('C7-PARENTS','C7-SHEET') ORDER BY matricule");
    expect(profiles[0]).toMatchObject({ class_id: null, birth_date: '2010-03-04', parent_name: 'Parent A', parent_phone: '2250700000000', parent_email: 'parent@example.ci', parent_name_2: 'Parent B', parent_phone_2: '2250100000000' });
    expect((await counts(profiles.map((profile) => profile.id)))[0]).toEqual({ inscriptions: 0, payments: 0, finance: 0, documents: 0, parents: 0 });
    for (const [index, profile] of profiles.entries()) {
      const detail = await request().get(`/api/v1/students/${profile.id}`).set(headers);
      expect(detail.body.data.historicalSources).toEqual([expect.objectContaining({ schoolYearLabel: '2023-2024', oldClassName: index === 0 ? 'Ancienne 4e A' : dataSheets[1]!.name })]);
    }
    expect(await queryTenant("SELECT id FROM school_years WHERE label='2023-2024'")).toEqual([]);
    const replay = await request().post(`${root}/confirm`).set(headers).field('schoolYearLabel', '2023-2024').attach('file', buffer, 'students.xlsx');
    expect(replay.body).toMatchObject({ createdCount: 0, reusedCount: 2, errors: [] });
    const history = await request().get('/api/v1/import/history?type=students').set(headers);
    expect(history.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ historical_school_year_label: '2023-2024' })]));
  });

  it('allows multiple class-free and matricule-free lots, replays safely and rejects invalid years', async () => {
    const mapping = fields.slice(1, 3);
    expect((await request().put(`${root}/profile`).set(headers).send({ fields: mapping })).status).toBe(200);
    for (const year of [undefined, '', '2024-2026']) {
      const pending = request().post(`${root}/confirm`).set(headers);
      if (year !== undefined) pending.field('schoolYearLabel', year);
      const invalid = await pending.attach('file', await file([['', 'Year', 'Invalid', '']]), 'students.xlsx');
      expect(invalid.status).toBe(400);
    }
    for (const givenName of ['LotOne', 'LotTwo']) {
      const buffer = await file([['', 'C7SansMatricule', givenName, '']]);
      const confirm = await request().post(`${root}/confirm`).set(headers).field('schoolYearLabel', '2024-2025').attach('file', buffer, 'students.xlsx');
      expect(confirm.body).toMatchObject({ createdCount: 1, reusedCount: 0, errors: [] });
      const replay = await request().post(`${root}/confirm`).set(headers).field('schoolYearLabel', '2024-2025').attach('file', buffer, 'students.xlsx');
      expect(replay.body).toMatchObject({ createdCount: 0, reusedCount: 1, errors: [] });
    }
    const rows = await queryTenant<{ id: string }>("SELECT id FROM students WHERE last_name='C7SansMatricule'");
    expect(rows).toHaveLength(2);
    expect((await counts(rows.map((row) => row.id)))[0]).toEqual({ inscriptions: 0, payments: 0, finance: 0, documents: 0, parents: 0 });
  });

  it('rolls back the profile itself when writing its historical reference fails', async () => {
    await request().put(`${root}/profile`).set(headers).send({ fields });
    await queryTenant(`CREATE FUNCTION c7_reject_source() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF EXISTS(SELECT 1 FROM students WHERE id=NEW.student_id AND matricule='C7-SOURCEFAIL')
      THEN RAISE EXCEPTION 'synthetic private reference'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER c7_reject_source BEFORE INSERT ON student_historical_sources FOR EACH ROW EXECUTE FUNCTION c7_reject_source();`);
    try {
      const response = await request().post(`${root}/confirm`).set(headers).field('schoolYearLabel', '2024-2025').attach('file',
        await file([['C7-SOURCEFAIL', 'Test', 'SourceFail', ''], ['C7-SOURCEOK', 'Test', 'SourceOk', '']]), 'students.xlsx');
      expect(response.body).toMatchObject({ createdCount: 1, reusedCount: 0, errors: [expect.objectContaining({ rowNumber: 2, field: 'profil' })] });
      expect(JSON.stringify(response.body)).not.toContain('synthetic private reference');
      expect(await queryTenant("SELECT id FROM students WHERE matricule='C7-SOURCEFAIL'")).toEqual([]);
      expect(await queryTenant("SELECT h.id FROM student_historical_sources h JOIN students s ON s.id=h.student_id WHERE s.matricule='C7-SOURCEOK'")).toHaveLength(1);
    } finally {
      await queryTenant('DROP TRIGGER c7_reject_source ON student_historical_sources; DROP FUNCTION c7_reject_source();');
    }
  });

  it('reapplies historical source migration without changing references or any existing business data', async () => {
    const tables = ['students', 'enrollments', 'payments', 'student_financial_status', 'documents', 'student_historical_sources', 'import_history'];
    const snapshots = await Promise.all(tables.map((table) => queryTenant(`SELECT * FROM ${table} ORDER BY id`)));
    const source = (await readFile('src/shared/database/migrations/0076_historical_student_sources.sql', 'utf8')).replaceAll('"tenant"', `"${TEST_SCHEMA_NAME}"`);
    for (let attempt = 0; attempt < 2; attempt++) for (const statement of source.split('--> statement-breakpoint')) await queryTenant(statement);
    expect(await Promise.all(tables.map((table) => queryTenant(`SELECT * FROM ${table} ORDER BY id`)))).toEqual(snapshots);
  });

  it('closes student and teacher imports after finalization, including saved mappings and direct URLs', async () => {
    expect((await request().get('/api/v1/import/context').set(headers)).body).toEqual({ initialConfiguration: true, canImportProfiles: true });
    await queryPublic('UPDATE public.tenants SET onboarding_completed=true WHERE schema_name=$1', [TEST_SCHEMA_NAME]);
    try {
      expect((await request().get('/api/v1/import/context').set(headers)).body).toEqual({ initialConfiguration: false, canImportProfiles: false });
      for (const path of [`${root}/profile`, `${root}/template`, '/api/v1/import/teachers/template', '/api/v1/import/students/template']) {
        const response = await request().get(path).set(headers);
        expect(response.status).toBe(403);
        expect(response.body.code).toBe('INITIAL_IMPORT_CLOSED');
      }
      expect((await request().put(`${root}/profile`).set(headers).send({ fields })).status).toBe(403);
      for (const path of [`${root}/analyze`, `${root}/confirm`, '/api/v1/import/teachers/dry-run', '/api/v1/import/teachers/confirm', '/api/v1/import/students/confirm']) {
        const response = await request().post(path).set(headers).field('schoolYearLabel', '2024-2025').attach('file', await file([]), 'students.xlsx');
        expect(response.status).toBe(403);
        expect(response.body.code).toBe('INITIAL_IMPORT_CLOSED');
      }
      expect((await request().get('/api/v1/import/schedule/template').set(headers)).status).toBe(200);
      expect((await request().get('/api/v1/import/history').set(headers)).status).toBe(200);
    } finally {
      await queryPublic('UPDATE public.tenants SET onboarding_completed=false WHERE schema_name=$1', [TEST_SCHEMA_NAME]);
    }
  });

});
