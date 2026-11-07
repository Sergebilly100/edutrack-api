import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createTenantSchema } from '../../src/shared/database/tenant-init.js';
import { getAuthHeaders, queryPublic, queryTenant, request, tenantTable, TEST_SCHEMA_NAME } from './setup.js';

const MIGRATION = '0099_identity_fields.sql';
const IGNORED_CODES = new Set(['42P06', '42P07', '42710', '42701', '42P16']);

const applyMigration = async (schema: string): Promise<void> => {
  const content = await readFile(path.resolve(process.cwd(), 'src/shared/database/migrations', MIGRATION), 'utf8');
  const statements = content.replace(/"tenant"/g, `"${schema}"`).split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);
  for (const statement of statements) {
    try { await queryTenant(statement); } catch (error) {
      if (!IGNORED_CODES.has((error as { code?: string }).code ?? '')) throw error;
    }
  }
};

const ensureTenantRow = async () => queryPublic(`INSERT INTO public.tenants (name, subdomain, schema_name, plan, status, max_users, onboarding_completed)
  VALUES ('Identity test', $1, $2, 'pro', 'active', 100, true)
  ON CONFLICT (schema_name) DO UPDATE SET max_users = 100`, [TEST_SCHEMA_NAME.replaceAll('_', '-'), TEST_SCHEMA_NAME]);

describe('migration 0099 identity fields', () => {
  it('est idempotente, conserve les données existantes et pose les contraintes', async () => {
    const before = await queryTenant<{ id: string }>(
      `INSERT INTO ${tenantTable('students')} (first_name, last_name, matricule) VALUES ('Avant', 'Migration', $1) RETURNING id`,
      [`MIG-${Date.now()}`]
    );
    await applyMigration(TEST_SCHEMA_NAME);
    await applyMigration(TEST_SCHEMA_NAME);
    const row = (await queryTenant<{ sex: string | null; nationality: string | null; birth_place: string | null }>(
      `SELECT sex, nationality, birth_place FROM ${tenantTable('students')} WHERE id = $1`, [before[0]!.id]))[0];
    expect(row).toEqual({ sex: null, nationality: null, birth_place: null });
    await expect(queryTenant(`UPDATE ${tenantTable('students')} SET sex = 'X' WHERE id = $1`, [before[0]!.id])).rejects.toMatchObject({ code: '23514' });
    await expect(queryTenant(`UPDATE ${tenantTable('students')} SET nationality = 'ci' WHERE id = $1`, [before[0]!.id])).rejects.toMatchObject({ code: '23514' });
    await expect(queryTenant(`UPDATE ${tenantTable('teachers')} SET sex = 'Z' WHERE false`)).resolves.toBeDefined();
    const columns = await queryTenant<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()
        AND ((table_name = 'enrollments' AND column_name = 'is_repeating')
          OR (table_name = 'teachers' AND column_name IN ('birth_date', 'sex', 'nationality', 'birth_place')))`);
    expect(columns.length).toBe(5);
  });

  it('crée les colonnes sur un schéma d’école neuf', async () => {
    await ensureTenantRow();
    const schema = `school_identity_${Date.now().toString(36)}`;
    await createTenantSchema(schema);
    const found = await queryPublic<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = $1
        AND ((table_name = 'students' AND column_name IN ('sex', 'nationality', 'birth_place'))
          OR (table_name = 'enrollments' AND column_name = 'is_repeating')
          OR (table_name = 'teachers' AND column_name IN ('birth_date', 'sex', 'nationality', 'birth_place')))`, [schema]);
    expect(found[0]!.n).toBe(8);
    // Isolation : une valeur écrite dans l'école neuve n'apparaît pas dans l'école de test.
    const marker = `Iso${Date.now().toString(36)}`;
    await queryPublic(`INSERT INTO "${schema}".students (first_name, last_name, nationality, birth_place) VALUES ($1, $1, 'GH', $1)`, [marker]);
    expect(await queryTenant(`SELECT 1 FROM ${tenantTable('students')} WHERE birth_place = $1`, [marker])).toHaveLength(0);
    expect(await queryPublic(`SELECT 1 FROM "${schema}".students WHERE birth_place = $1`, [marker])).toHaveLength(1);
    await queryPublic(`DROP SCHEMA "${schema}" CASCADE`);
  });
});

describe('students identity fields over HTTP', () => {
  it('crée, lit, modifie partiellement, efface avec null et valide', async () => {
    const headers = await getAuthHeaders('director');
    const suffix = Date.now().toString(36);
    const created = await request().post('/api/v1/students').set(headers)
      .send({ first_name: 'Aya', last_name: `Id${suffix}`, sex: 'F', nationality: 'ci', birth_place: '  Abidjan   Cocody ' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({ sex: 'F', nationality: 'CI', birthPlace: 'Abidjan Cocody' });
    const id = created.body.data.id as string;

    const detail = await request().get(`/api/v1/students/${id}`).set(headers);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(JSON.stringify(detail.body)).toContain('Abidjan Cocody');

    const partial = await request().put(`/api/v1/students/${id}`).set(headers).send({ notes: 'rien à voir' });
    expect(partial.status).toBe(200);
    expect(partial.body.data).toMatchObject({ sex: 'F', nationality: 'CI', birthPlace: 'Abidjan Cocody' });

    const changed = await request().put(`/api/v1/students/${id}`).set(headers).send({ nationality: 'BF' });
    expect(changed.body.data).toMatchObject({ sex: 'F', nationality: 'BF', birthPlace: 'Abidjan Cocody' });

    const cleared = await request().put(`/api/v1/students/${id}`).set(headers).send({ sex: null, nationality: null, birth_place: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data).toMatchObject({ sex: null, nationality: null, birthPlace: null });

    for (const body of [{ sex: 'X' }, { nationality: 'ZZ' }, { nationality: 'Ivoirienne' }, { birth_place: 'A' }, { birth_place: 'x'.repeat(121) }]) {
      const rejected = await request().put(`/api/v1/students/${id}`).set(headers).send(body);
      expect(rejected.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('crée sans les nouveaux champs (ancien client) et refuse sans permission', async () => {
    const headers = await getAuthHeaders('director');
    const legacy = await request().post('/api/v1/students').set(headers).send({ first_name: 'Ancien', last_name: `Client${Date.now().toString(36)}` });
    expect(legacy.status, JSON.stringify(legacy.body)).toBe(201);
    expect(legacy.body.data).toMatchObject({ sex: null, nationality: null, birthPlace: null });

    const teacherHeaders = await getAuthHeaders('teacher');
    const denied = await request().put(`/api/v1/students/${legacy.body.data.id}`).set(teacherHeaders).send({ sex: 'M' });
    expect([401, 403]).toContain(denied.status);
    const after = await queryTenant<{ sex: string | null }>(`SELECT sex FROM ${tenantTable('students')} WHERE id = $1`, [legacy.body.data.id]);
    expect(after[0]!.sex).toBeNull();
  });
});

describe('teachers identity fields over HTTP', () => {
  it('crée, modifie partiellement, efface avec null et valide', async () => {
    await ensureTenantRow();
    const headers = await getAuthHeaders('director');
    const suffix = Date.now().toString(36);
    const created = await request().post('/api/v1/teachers').set(headers).send({
      first_name: 'Ibrahim', last_name: `Id${suffix}`, email: `ibrahim.${suffix}@example.test`, type: 'vacataire', hourly_rate: 5000,
      subjects: [], sex: 'M', nationality: 'ML', birth_place: 'Bamako', birth_date: '1985-03-14',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ sex: 'M', nationality: 'ML', birth_place: 'Bamako', birth_date: '1985-03-14' });
    const id = created.body.id as string;

    const partial = await request().put(`/api/v1/teachers/${id}`).set(headers).send({ hourly_rate: 6000 });
    expect(partial.status, JSON.stringify(partial.body)).toBe(200);
    expect(partial.body).toMatchObject({ sex: 'M', nationality: 'ML', birth_place: 'Bamako', birth_date: '1985-03-14' });

    const cleared = await request().put(`/api/v1/teachers/${id}`).set(headers).send({ sex: null, nationality: null, birth_place: null, birth_date: null });
    expect(cleared.body).toMatchObject({ sex: null, nationality: null, birth_place: null, birth_date: null });

    for (const body of [{ sex: 'Q' }, { nationality: 'XX' }, { birth_date: '2999-01-01' }]) {
      expect((await request().put(`/api/v1/teachers/${id}`).set(headers).send(body)).status, JSON.stringify(body)).toBe(400);
    }
    const denied = await request().put(`/api/v1/teachers/${id}`).set(await getAuthHeaders('teacher')).send({ sex: 'F' });
    expect([401, 403]).toContain(denied.status);
  });
});

describe('enrollment is_repeating over HTTP', () => {
  it('stocke le redoublant à la création, le modifie seul, reste null sans valeur', async () => {
    await ensureTenantRow();
    const headers = await getAuthHeaders('director');
    const suffix = Date.now().toString(36);
    await queryTenant(`UPDATE ${tenantTable('school_years')} SET status = 'closed' WHERE status = 'active'`);
    const year = (await queryTenant<{ id: string }>(`INSERT INTO ${tenantTable('school_years')} (label, start_date, end_date, status)
      VALUES ($1, '2090-09-01', '2091-06-30', 'active') RETURNING id`, [`id-${suffix}`]))[0]!;
    const level = (await queryTenant<{ id: string }>(`INSERT INTO ${tenantTable('levels')} (name, order_index, is_exam_class) VALUES ($1, 90, false) RETURNING id`, [`id-lvl-${suffix}`]))[0]!;
    const klass = (await queryTenant<{ id: string }>(`INSERT INTO ${tenantTable('classes')} (name, level_id, school_year_id, is_active)
      VALUES ($1, $2::uuid, $3::uuid, true) RETURNING id`, [`id-cls-${suffix}`, level.id, year.id]))[0]!;
    const makeStudent = async (n: string) => (await queryTenant<{ id: string }>(
      `INSERT INTO ${tenantTable('students')} (first_name, last_name, matricule) VALUES ('E', $1, $2) RETURNING id`, [`Red${n}${suffix}`, `RED-${n}-${suffix}`]))[0]!.id;

    const [a, b] = [await makeStudent('A'), await makeStudent('B')];
    const withFlag = await request().post('/api/v1/enrollments').set(headers)
      .send({ studentId: a, classId: klass.id, schoolYearId: year.id, type: 'new_registration', isRepeating: true });
    expect(withFlag.status, JSON.stringify(withFlag.body)).toBe(201);
    expect(withFlag.body.enrollment.isRepeating).toBe(true);
    const legacy = await request().post('/api/v1/enrollments').set(headers)
      .send({ studentId: b, classId: klass.id, schoolYearId: year.id, type: 'new_registration' });
    expect(legacy.status, JSON.stringify(legacy.body)).toBe(201);
    expect(legacy.body.enrollment.isRepeating).toBeNull();

    const id = withFlag.body.enrollment.id as string;
    const toggled = await request().patch(`/api/v1/enrollments/${id}`).set(headers).send({ isRepeating: false });
    expect(toggled.status, JSON.stringify(toggled.body)).toBe(200);
    expect(toggled.body.enrollment.isRepeating).toBe(false);
    const cleared = await request().patch(`/api/v1/enrollments/${id}`).set(headers).send({ isRepeating: null });
    expect(cleared.body.enrollment.isRepeating).toBeNull();
    expect((await request().patch(`/api/v1/enrollments/${id}`).set(headers).send({ isRepeating: 'oui' })).status).toBe(400);
    expect((await request().patch(`/api/v1/enrollments/${id}`).set(await getAuthHeaders('teacher')).send({ isRepeating: true })).status).toBeGreaterThanOrEqual(401);
  });
});
