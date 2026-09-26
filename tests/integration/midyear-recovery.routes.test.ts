import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { beforeAll, describe, expect, it } from 'vitest';
import { signAccessToken } from '../../src/modules/auth/auth.service.js';
import { ensureAdminPublicInfrastructure } from '../../src/modules/admin/admin.infrastructure.service.js';
import { db } from '../../src/shared/database/db.js';
import { getAuthHeaders, getSeedContext, queryPublic, queryTenant, request, TEST_SCHEMA_NAME } from './setup.js';

type Id = { id: string };
const suffix = Date.now().toString();
const studentHeaders = ['Code école', 'Famille', 'Prénom usuel', 'Cycle', 'Groupe'];
const paymentHeaders = ['Code école', 'Somme', 'Jour effectif', 'Reçu école', 'Canal'];
const targets: Record<string, string[]> = { students: ['matricule', 'nom', 'prenom', 'niveau', 'classe'], payments: ['matricule', 'montant', 'date', 'reference', 'method'] };
const workbook = async (headers: string[], rows: Array<Array<string | number | Date>>) => {
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('Données école');
  sheet.addRow(headers); for (const row of rows) sheet.addRow(row);
  return Buffer.from(await book.xlsx.writeBuffer());
};

describe('C8 super administrator school recovery', () => {
  let tenantId: string; let yearId: string; let levelId: string;
  let admin: Record<string, string>; let director: Record<string, string>;
  const levelName = `Niveau C8 ${suffix}`;
  const base = (type: string, target = tenantId) => `/api/v1/admin/schools/${target}/midyear-import/${type}`;
  const preview = (type: string, file: Buffer) => request().post(`${base(type)}/preview`).set(admin).query({ school_year_id: yearId }).attach('file', file, 'ecole.xlsx');
  const confirm = (type: string, file: Buffer, token: string) => request().post(`${base(type)}/confirm`).set(admin).query({ school_year_id: yearId, preview_token: token }).attach('file', file, 'ecole.xlsx');
  const save = async (type: string, target = tenantId) => {
    const headers = type === 'students' ? studentHeaders : paymentHeaders;
    const response = await request().put(`${base(type, target)}/profile`).set(admin).send({
      fields: headers.map((sourceColumnLabel, index) => ({ sourceColumnLabel, targetField: targets[type][index], translations: type === 'payments' && index === 4 ? [{ sourceValue: 'Orange Money', targetValue: 'mobile_money' }] : [] })),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  };
  const enroll = async (code: string, className = `Classe ${code}`) => {
    const file = await workbook(studentHeaders, [[code, 'Koné', 'Aya', levelName, className]]);
    const checked = await preview('students', file); expect(checked.status, JSON.stringify(checked.body)).toBe(200);
    const result = await confirm('students', file, checked.body.previewToken);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.errors).toEqual([]);
    const student = await queryTenant<Id>('SELECT id::text FROM students WHERE matricule = $1', [code]);
    return student[0].id;
  };

  beforeAll(async () => {
    await ensureAdminPublicInfrastructure(db);
    tenantId = (await queryPublic<Id>(`INSERT INTO public.tenants (name, subdomain, schema_name, plan, status, max_users, onboarding_completed) VALUES ($1, $2, $3, 'pro', 'active', 50, true) ON CONFLICT (schema_name) DO UPDATE SET updated_at = NOW() RETURNING id::text`, [`C8 école ${suffix}`, `c8-${suffix}`, TEST_SCHEMA_NAME]))[0].id;
    admin = { authorization: `Bearer ${await signAccessToken({ sub: getSeedContext().superAdminUserId, role: 'super_admin', schemaName: TEST_SCHEMA_NAME, tenantId })}` };
    director = await getAuthHeaders('director');
    await queryTenant("UPDATE school_years SET status = 'closed' WHERE status = 'active'");
    yearId = (await queryTenant<Id>(`INSERT INTO school_years (label, start_date, end_date, status) VALUES ($1, '2026-09-01', '2027-06-30', 'active') RETURNING id::text`, [`C8-${suffix}`]))[0].id;
    levelId = (await queryTenant<Id>(`INSERT INTO levels (name, order_index) VALUES ($1, 1) RETURNING id::text`, [levelName]))[0].id;
    await queryTenant(`INSERT INTO tuition_plans (level_id, school_year_id, total_amount) VALUES ($1, $2, 100000)`, [levelId, yearId]);
    await save('students'); await save('payments');
  });

  it('rejects director access to every profile/file route, including URL attempts', async () => {
    for (const type of ['levels', 'subjects', 'rooms', 'classes', 'students', 'payments']) {
      expect((await request().get(`${base(type)}/profile`).set(director)).status).toBe(403);
      expect((await request().put(`${base(type)}/profile`).set(director).send({ fields: [] })).status).toBe(403);
      for (const action of ['analyze', 'preview', 'confirm']) {
        const response = await request().post(`${base(type)}/${action}`).set(director).query({ school_year_id: yearId }).attach('file', await workbook(['x'], [['y']]), 'x.xlsx');
        expect(response.status).toBe(403);
      }
    }
  });
  it('requires an explicit active year and a signed preview before confirmation', async () => {
    const file = await workbook(studentHeaders, [['YEAR', 'Koné', 'Aya', levelName, '6e']]);
    const missing = await request().post(`${base('students')}/analyze`).set(admin).attach('file', file, 'x.xlsx');
    expect(missing.status).toBe(400);
    const wrong = await request().post(`${base('students')}/preview`).set(admin).query({ school_year_id: randomUUID() }).attach('file', file, 'x.xlsx');
    expect(wrong.status).toBe(409);
    const unsigned = await request().post(`${base('students')}/confirm`).set(admin).query({ school_year_id: yearId }).attach('file', file, 'x.xlsx');
    expect(unsigned.status).toBe(400); expect(unsigned.body.code).toBe('RECOVERY_PREVIEW_REQUIRED');
    expect((await confirm('students', file, '0'.repeat(64))).body.code).toBe('RECOVERY_PREVIEW_STALE');
  });
  it('sanitizes a failed mapping write and preserves the previously active profile', async () => {
    const previous = await request().get(`${base('students')}/profile`).set(admin);
    await queryTenant(`CREATE FUNCTION c8_reject_mapping() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.label = 'C8-FAIL' THEN RAISE EXCEPTION 'Private profile label'; END IF; RETURN NEW; END; $$`);
    await queryTenant('CREATE TRIGGER c8_mapping_failure BEFORE INSERT ON import_mapping_profiles FOR EACH ROW EXECUTE FUNCTION c8_reject_mapping()');
    try {
      const response = await request().put(`${base('students')}/profile`).set(admin).send({ label: 'C8-FAIL', fields: previous.body.profile.fields.map(({ sourceColumnLabel, targetField, translations }: { sourceColumnLabel: string; targetField: string; translations: unknown[] }) => ({ sourceColumnLabel, targetField, translations })) });
      expect(response.status).toBe(500); expect(response.body.code).toBe('RECOVERY_REQUEST_FAILED');
      expect(JSON.stringify(response.body)).not.toContain('Private');
      const after = await request().get(`${base('students')}/profile`).set(admin);
      expect(after.body.profile.id).toBe(previous.body.profile.id);
    } finally { await queryTenant('DROP TRIGGER c8_mapping_failure ON import_mapping_profiles'); await queryTenant('DROP FUNCTION c8_reject_mapping()'); }
  });
  it('announces missing classes, reuses a C7 profile, creates confirmed enrollments and never changes legacy class', async () => {
    const code = `C7-${suffix}`; const newCode = `NEW-${suffix}`; const className = `Groupe C8 ${suffix}`;
    const historical = (await queryTenant<Id>(`INSERT INTO students (matricule, first_name, last_name) VALUES ($1, 'Aya', 'Koné') RETURNING id::text`, [code]))[0].id;
    const file = await workbook(studentHeaders, [[code, 'Koné', 'Aya', levelName, className], [newCode, 'Coulibaly', 'Ali', levelName, className.replace('Groupe C8', 'Groupe   C8')], ['BAD', '', 'Autre', levelName, 'Classe invalide']]);
    const checked = await preview('students', file);
    expect(checked.body.impact).toMatchObject({ profilesCreated: 1, profilesReused: 1, classesCreated: 1, enrollmentsCreated: 2 });
    expect(checked.body.errors[0].rowNumber).toBe(4);
    expect(await queryTenant('SELECT id FROM classes WHERE name = $1', [className])).toEqual([]);
    const result = await confirm('students', file, checked.body.previewToken);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const profiles = await queryTenant<{ id: string; class_id: string | null }>('SELECT id::text, class_id::text FROM students WHERE matricule = $1', [code]);
    expect(profiles).toEqual([{ id: historical, class_id: null }]);
    const enrollments = await queryTenant<{ status: string; name: string; school_year_id: string; student_count: number }>(`SELECT e.status::text, c.name, e.school_year_id::text, c.student_count FROM enrollments e JOIN classes c ON c.id = e.class_id WHERE c.name = $1`, [className]);
    expect(enrollments).toHaveLength(2);
    expect(enrollments[0]).toMatchObject({ status: 'confirmed', name: className, school_year_id: yearId, student_count: 2 });
    expect(await queryTenant('SELECT id FROM classes WHERE name = $1', ['Classe invalide'])).toEqual([]);
    const again = await preview('students', file);
    expect(again.body.impact).toMatchObject({ classesCreated: 0, profilesCreated: 0, enrollmentsCreated: 0, enrollmentsReused: 2 });
    expect((await confirm('students', file, again.body.previewToken)).body.reusedCount).toBe(2);
  });
  it('preserves all four payment fields, updates caches, excludes migration from cash journal and audits only counts/UUIDs', async () => {
    const code = `PAY-${suffix}`; const studentId = await enroll(code);
    const reference = `  ECOLE/Orange/001-${suffix}  `;
    const file = await workbook(paymentHeaders, [[code, '15 000,50', new Date('2026-10-12T00:00:00Z'), reference, 'Orange Money']]);
    const checked = await preview('payments', file);
    expect(checked.body.errors).toEqual([]);
    const result = await confirm('payments', file, checked.body.previewToken);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const payments = await queryTenant<{ amount: string; payment_date: string; provider_reference: string; method: string; source: string; status: string }>(`SELECT amount::text, payment_date::text, provider_reference, method::text, source::text, status::text FROM payments WHERE student_id = $1`, [studentId]);
    expect(payments).toEqual([{ amount: '15000.50', payment_date: '2026-10-12', provider_reference: reference, method: 'mobile_money', source: 'migration_import', status: 'confirmed' }]);
    const caches = await queryTenant<{ total_paid: string }>('SELECT total_paid::text FROM student_financial_status WHERE student_id = $1 AND school_year_id = $2', [studentId, yearId]);
    expect(caches[0].total_paid).toBe('15000.50');
    const aggregates = await queryTenant<{ total_paid: string }>('SELECT total_paid::text FROM school_financial_summary WHERE school_year_id = $1', [yearId]);
    expect(Number(aggregates[0].total_paid)).toBeGreaterThanOrEqual(15000.50);
    const journal = await request().get('/api/v1/payments/cash-journal').set(director).query({ school_year_id: yearId, from: '2026-09-01', to: '2027-06-30' });
    expect(journal.status, JSON.stringify(journal.body)).toBe(200);
    expect(journal.body.journal.entries).toEqual([]);
    const audit = await queryPublic<{ actor_id: string; payload_after: Record<string, unknown> }>(`SELECT actor_id::text, payload_after FROM public.audit_financial_events WHERE tenant_id = $1 AND action = 'school.recovery.payments' ORDER BY created_at DESC LIMIT 1`, [tenantId]);
    expect(audit[0].actor_id).toBe(getSeedContext().superAdminUserId);
    expect(audit[0].payload_after).toMatchObject({ schoolYearId: yearId, paymentsCreated: 1 });
    expect(JSON.stringify(audit)).not.toContain(code); expect(JSON.stringify(audit)).not.toContain(reference);
    const again = await preview('payments', file);
    expect(again.body.impact.paymentsReused).toBe(1);
    expect((await confirm('payments', file, again.body.previewToken)).body.createdCount).toBe(0);
    expect((await queryTenant('SELECT id FROM payments WHERE student_id = $1', [studentId])).length).toBe(1);
    const changed = await preview('payments', await workbook(paymentHeaders, [[code, 16000, '2026-10-12', reference, 'Orange Money']]));
    expect(changed.body.validRows).toEqual([]); expect(changed.body.errors[0].reason).toMatch(/Référence déjà utilisée/);
  });
  it('reports duplicate/ambiguous rows, payments without an enrollment and missing fee plans before writing', async () => {
    const code = `DUP-${suffix}`;
    const duplicated = await preview('students', await workbook(studentHeaders, [[code, 'Koné', 'Aya', levelName, '6e'], [code, 'Koné', 'Aya', levelName, '6e']]));
    expect(duplicated.body.validRows).toEqual([]); expect(duplicated.body.errors).toHaveLength(2);
    await queryTenant(`INSERT INTO students (matricule, first_name, last_name) VALUES ($1, 'Aya', 'Koné')`, [code]);
    const invalidFile = await workbook(paymentHeaders, [[code, 5000, '2026-10-12', 'NO-ENROLLMENT', 'cash']]);
    const noEnrollment = await preview('payments', invalidFile);
    expect(noEnrollment.body.errors[0].reason).toMatch(/inscription confirmée/);
    expect((await confirm('payments', invalidFile, noEnrollment.body.previewToken)).body.createdCount).toBe(0);
    expect(await queryTenant('SELECT id FROM payments WHERE provider_reference = $1', ['NO-ENROLLMENT'])).toEqual([]);
    const enrolledId = await enroll(`NO-PLAN-${suffix}`);
    await queryTenant('DELETE FROM tuition_plans WHERE level_id = $1 AND school_year_id = $2', [levelId, yearId]);
    const noPlan = await preview('payments', await workbook(paymentHeaders, [[`NO-PLAN-${suffix}`, 5000, '2026-10-12', 'NO-PLAN', 'cash']]));
    expect(noPlan.body.errors[0].reason).toMatch(/Plan de frais manquant/);
    expect(await queryTenant('SELECT id FROM payments WHERE student_id = $1', [enrolledId])).toEqual([]);
    await queryTenant('INSERT INTO tuition_plans (level_id, school_year_id, total_amount) VALUES ($1, $2, 100000)', [levelId, yearId]);
  });
  it('rejects a stale preview when the destination class changes', async () => {
    const code = `STALE-${suffix}`; const className = `Stale ${suffix}`;
    const file = await workbook(studentHeaders, [[code, 'Koné', 'Aya', levelName, className]]);
    const checked = await preview('students', file);
    await queryTenant('INSERT INTO classes (name, level_id, school_year_id) VALUES ($1, $2, $3)', [className, levelId, yearId]);
    const response = await confirm('students', file, checked.body.previewToken);
    expect(response.status).toBe(409); expect(response.body.code).toBe('RECOVERY_PREVIEW_STALE');
    expect(await queryTenant('SELECT id FROM students WHERE matricule = $1', [code])).toEqual([]);
  });
  it('rolls back profiles, newly created classes and enrollments after a late database failure', async () => {
    const file = await workbook(studentHeaders, [[`ROLL-1-${suffix}`, 'Koné', 'Aya', levelName, 'Rollback class'], [`ROLL-2-${suffix}`, 'Koné', 'Ali', levelName, 'Rollback class']]);
    const checked = await preview('students', file);
    await queryTenant(`CREATE FUNCTION c8_reject_student() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.matricule LIKE 'ROLL-2-%' THEN RAISE EXCEPTION 'Private financial school data'; END IF; RETURN NEW; END; $$`);
    await queryTenant('CREATE TRIGGER c8_student_failure BEFORE INSERT ON students FOR EACH ROW EXECUTE FUNCTION c8_reject_student()');
    try {
      const response = await confirm('students', file, checked.body.previewToken);
      expect(response.status).toBe(409); expect(response.body.code).toBe('RECOVERY_WRITE_FAILED');
      expect(JSON.stringify(response.body)).not.toContain('Private');
      expect(await queryTenant("SELECT id FROM students WHERE matricule LIKE 'ROLL-%'")).toEqual([]);
      expect(await queryTenant("SELECT id FROM classes WHERE name = 'Rollback class'")).toEqual([]);
    } finally { await queryTenant('DROP TRIGGER c8_student_failure ON students'); await queryTenant('DROP FUNCTION c8_reject_student()'); }
  });
  it('rolls back earlier financial entries and caches on a late payment failure', async () => {
    const code = `PAY-ROLL-${suffix}`; const id = await enroll(code);
    const file = await workbook(paymentHeaders, [[code, 5000, '2026-10-12', 'ROLL-OK', 'bank_transfer'], [code, 6000, '2026-10-13', 'ROLL-FAIL', 'cash']]);
    const checked = await preview('payments', file);
    await queryTenant(`CREATE FUNCTION c8_reject_payment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.provider_reference = 'ROLL-FAIL' THEN RAISE EXCEPTION 'Private reference'; END IF; RETURN NEW; END; $$`);
    await queryTenant('CREATE TRIGGER c8_payment_failure BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION c8_reject_payment()');
    try {
      const response = await confirm('payments', file, checked.body.previewToken);
      expect(response.status).toBe(409); expect(response.body.code).toBe('RECOVERY_WRITE_FAILED');
      expect(await queryTenant('SELECT id FROM payments WHERE student_id = $1', [id])).toEqual([]);
      const cache = await queryTenant<{ total_paid: string }>('SELECT total_paid::text FROM student_financial_status WHERE student_id = $1', [id]);
      expect(Number(cache[0].total_paid)).toBe(0);
    } finally { await queryTenant('DROP TRIGGER c8_payment_failure ON payments'); await queryTenant('DROP FUNCTION c8_reject_payment()'); }
  });
  it('serializes concurrent confirmations without duplicate profiles or financial entries', async () => {
    const code = `CONCURRENT-${suffix}`;
    const students = await workbook(studentHeaders, [[code, 'Koné', 'Aya', levelName, 'Classe simultanée']]);
    const checked = await preview('students', students);
    const results = await Promise.all([confirm('students', students, checked.body.previewToken), confirm('students', students, checked.body.previewToken)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const profiles = await queryTenant<Id>('SELECT id::text FROM students WHERE matricule = $1', [code]);
    expect(profiles).toHaveLength(1);
    const payments = await workbook(paymentHeaders, [[code, 5000, '2026-10-12', 'CONCURRENT-REF', 'cash']]);
    const paymentPreview = await preview('payments', payments);
    const paid = await Promise.all([confirm('payments', payments, paymentPreview.body.previewToken), confirm('payments', payments, paymentPreview.body.previewToken)]);
    expect(paid.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await queryTenant('SELECT id FROM payments WHERE student_id = $1', [profiles[0].id])).toHaveLength(1);
  });
  it('accepts a mapping author from another school and replays the platform-author migration safely', async () => {
    const created = await request().post('/api/v1/admin/schools').set(admin).send({ name: `C8 cible ${suffix}`, subdomain: `c8-target-${suffix}`, city: 'Abidjan', address: 'Cocody', teaching_type: 'secondaire', director_name: 'Directrice cible', director_phone: '2250700009944', active_school_year: '09/2026 - 06/2027', plan: 'pro', midYearOnboarding: true });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await save('students', created.body.tenantId);
    const profile = await request().get(`${base('students', created.body.tenantId)}/profile`).set(admin);
    expect(profile.status).toBe(200); expect(profile.body.profile.fields).toHaveLength(5);
    const migration = (await readFile(new URL('../../src/shared/database/migrations/0075_midyear_mapping_platform_actor.sql', import.meta.url), 'utf8')).replaceAll('"tenant"', `"${TEST_SCHEMA_NAME}"`);
    await queryTenant(migration); await queryTenant(migration);
    expect((await request().get(`${base('students')}/profile`).set(admin)).status).toBe(200);
  });
});
