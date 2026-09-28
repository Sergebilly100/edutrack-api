import { beforeAll, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { readFile } from 'node:fs/promises';
import { signAccessToken } from '../../src/modules/auth/auth.service.js';
import { withTenantSchema } from '../../src/shared/database/db.js';
import { buildImportService } from '../../src/modules/import-export/import.service.js';
import { defaultImportRepository } from '../../src/modules/import-export/import.repository.js';
import { getAuthHeaders, getSeedContext, queryPublic, queryTenant, request, TEST_SCHEMA_NAME } from './setup.js';

describe('configuration: adresse et contrats API', () => {
  let tenantId: string;
  beforeAll(async () => {
    const [tenant] = await queryPublic<{ id: string }>(
      `INSERT INTO public.tenants (name, subdomain, schema_name, plan, status, city)
       VALUES ('École revue', $1, $2, 'pro', 'active', 'Abidjan') RETURNING id::text`,
      [TEST_SCHEMA_NAME.replaceAll('_', '-'), TEST_SCHEMA_NAME]
    );
    tenantId = tenant!.id;
  });

  it('migration idempotente et compatibilité d’une école sans adresse', async () => {
    const migration = await readFile('src/shared/database/migrations/0073_school_address.sql', 'utf8');
    await queryPublic(migration);
    await queryPublic(migration);
    const headers = await getAuthHeaders('director');
    const [original] = await queryPublic<{ name: string; city: string; address: string | null; logo_url: string | null }>(
      'SELECT name, city, address, logo_url FROM public.tenants WHERE id=$1', [tenantId]);
    expect(original?.address).toBeNull();
    const before = await request().get('/api/v1/school/info').set(headers);
    expect(before.status).toBe(200);
    expect(before.body.address).toBe('');
    const update = await request().patch('/api/v1/permissions/config/school').set(headers)
      .send({ allowTeacherQrSkip: true });
    expect(update.status).toBe(200);
    expect(update.body.school.address).toBe('');
    expect(update.body).not.toHaveProperty('users');
    expect(update.body).not.toHaveProperty('positions');
    const logo = await request().patch('/api/v1/permissions/config/school').set(headers)
      .send({ logoUrl: 'https://example.test/c15-logo.png' });
    expect(logo.status, JSON.stringify(logo.body)).toBe(200);
    const [after] = await queryPublic<{ name: string; city: string; address: string | null; logo_url: string | null }>(
      'SELECT name, city, address, logo_url FROM public.tenants WHERE id=$1', [tenantId]);
    expect(after).toEqual({ ...original, logo_url: 'https://example.test/c15-logo.png' });
  });

  it('enregistre et relit l’adresse depuis onboarding, paramètres et super administration', async () => {
    const director = await getAuthHeaders('director');
    const admin = { authorization: `Bearer ${await signAccessToken({
      sub: getSeedContext().superAdminUserId, role: 'super_admin', schemaName: TEST_SCHEMA_NAME,
    })}` };
    for (const [route, headers, address] of [
      ['/api/v1/school/info', director, 'Rue de l’école, Cocody'],
      ['/api/v1/permissions/config/school', director, 'Boulevard des écoles, Abidjan'],
      [`/api/v1/admin/schools/${tenantId}/config`, admin, 'Avenue des écoles, Bouaké'],
    ] as const) {
      const response = await request().patch(route).set(headers).send({ address });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const info = await request().get('/api/v1/school/info').set(director);
      expect(info.body.address).toBe(address);
      const [stored] = await queryPublic<{ address: string }>('SELECT address FROM public.tenants WHERE id=$1', [tenantId]);
      expect(stored?.address).toBe(address);
    }
    const unchanged = await request().patch('/api/v1/permissions/config/school').set(director)
      .send({ allowTeacherQrSkip: false });
    expect(unchanged.status, JSON.stringify(unchanged.body)).toBe(200);
    const [storedAfterPolicy] = await queryPublic<{ address: string }>('SELECT address FROM public.tenants WHERE id=$1', [tenantId]);
    expect(storedAfterPolicy?.address).toBe('Avenue des écoles, Bouaké');
    const invalid = await request().patch('/api/v1/permissions/config/school').set(director).send({ address: 'a' });
    expect(invalid.status).toBe(400);
  });

  it('renvoie une erreur métier 400 pour un professeur sans affectation, sans créer d’affectation', async () => {
    const context = getSeedContext();
    const [slot] = await queryTenant<{ schedule_period_id: string; class_id: string; room_id: string; time_slot_id: string }>(
      'SELECT schedule_period_id, class_id, room_id, time_slot_id FROM schedules WHERE id=$1', [context.scheduleId]
    );
    const response = await request().post('/api/v1/schedule').set(await getAuthHeaders('director')).send({
      ...slot, teacher_id: context.teacherId, subject: 'Mathématiques', day_of_week: 1,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body.code).toBe('TEACHER_ASSIGNMENT_REQUIRED');
    const [count] = await queryTenant<{ count: number }>('SELECT COUNT(*)::int AS count FROM teacher_subject_assignments');
    expect(count?.count).toBe(0);
  });

  it('importe seulement une affectation explicite et annule la période entière en cas d’échec', async () => {
    const { teacherId, scheduleId } = getSeedContext();
    await queryTenant("UPDATE school_years SET status='closed' WHERE status='active'");
    const [year] = await queryTenant<{ id: string }>(`INSERT INTO school_years
      (label, start_date, end_date, end_of_year_review_start_date, status)
      VALUES ('Revue EDT', CURRENT_DATE - 60, CURRENT_DATE + 300, CURRENT_DATE + 270, 'active') RETURNING id`);
    const [level] = await queryTenant<{ id: string }>("INSERT INTO levels (name, order_index) VALUES ('Revue', 987) RETURNING id");
    const [schoolClass] = await queryTenant<{ id: string; name: string }>(`UPDATE classes SET level_id=$1, school_year_id=$2
      WHERE id=(SELECT class_id FROM schedules WHERE id=$3) RETURNING id, name`, [level!.id, year!.id, scheduleId]);
    const [subject] = await queryTenant<{ id: string }>("INSERT INTO subjects (level_id, name, coefficient) VALUES ($1, 'Mathématiques', 3) RETURNING id", [level!.id]);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('EDT');
    sheet.addRow(['Nom professeur*', 'Classe*', 'Matière*', 'Jour*', 'Créneau*', 'Salle']);
    sheet.addRow(['Integration Teacher', schoolClass!.name, 'Mathématiques', 'Lundi', '7h30 - 9h00', 'Salle A1']);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const monday = new Date();
    monday.setUTCDate(monday.getUTCDate() + ((8 - monday.getUTCDay()) % 7 || 7) + 14);
    const sunday = new Date(monday); sunday.setUTCDate(sunday.getUTCDate() + 6);
    const options = { schedulePeriod: { weekStart: monday.toISOString().slice(0, 10), weekEnd: sunday.toISOString().slice(0, 10) } };
    const service = buildImportService();
    const dryRun = () => withTenantSchema(TEST_SCHEMA_NAME, (db) => service.dryRun('schedule', buffer, db, options));
    const confirm = () => withTenantSchema(TEST_SCHEMA_NAME, (db) => service.confirm('schedule', buffer, db, options));
    expect((await dryRun()).valid).toBe(0);
    await queryTenant('INSERT INTO teacher_subject_assignments (teacher_id, subject_id, class_id) VALUES ($1,$2,$3)', [teacherId, subject!.id, schoolClass!.id]);
    expect((await dryRun()).errors).toEqual([]);
    await queryTenant('UPDATE teachers SET is_blocked=true WHERE id=$1', [teacherId]);
    try {
      expect((await dryRun()).errors).toEqual(expect.arrayContaining([expect.objectContaining({ message: 'Professeur bloqué ou inactif' })]));
      await expect(confirm()).rejects.toMatchObject({ code: 'IMPORT_VALIDATION_FAILED' });
    } finally { await queryTenant('UPDATE teachers SET is_blocked=false WHERE id=$1', [teacherId]); }

    const countPeriods = () => queryTenant<{ count: number }>('SELECT COUNT(*)::int AS count FROM schedule_periods');
    const before = await countPeriods();
    const failure = vi.spyOn(defaultImportRepository, 'upsertSchedule').mockRejectedValueOnce(new Error('injected failure'));
    try { await expect(confirm()).rejects.toThrow('injected failure'); }
    finally { failure.mockRestore(); }
    expect(await countPeriods()).toEqual(before);
    expect(await confirm()).toMatchObject({ imported: 1 });
    const [assignments] = await queryTenant<{ count: number }>('SELECT COUNT(*)::int AS count FROM teacher_subject_assignments');
    expect(assignments?.count).toBe(1);
  });

  it('met à jour un profil professeur déjà connu lors d’un réimport', async () => {
    const context = getSeedContext();
    const result = await withTenantSchema(TEST_SCHEMA_NAME, (db) => defaultImportRepository.upsertTeacher(db, {
      matricule: 'REVIEW-P001', username: context.teacherUsername, firstName: 'Integration', lastName: 'Teacher',
      phone: null, email: 'teacher.review@example.test', type: 'vacataire', subjects: ['Mathématiques'],
      hourlyRate: 6000, monthlySalary: null,
    }, { displayName: 'Integration Teacher', passwordHash: 'unused-on-update' }));
    expect(result).toBe('updated');
    const [teacher] = await queryTenant<{ hourly_rate: string; email: string }>(
      'SELECT t.hourly_rate, u.email FROM teachers t JOIN users u ON u.id=t.user_id WHERE t.id=$1', [context.teacherId]);
    expect(Number(teacher?.hourly_rate)).toBe(6000);
    expect(teacher?.email).toBe('teacher.review@example.test');
  });

  it('persiste aussi l’adresse lors de la création d’école par le super administrateur', async () => {
    const subdomain = `review-address-${TEST_SCHEMA_NAME.slice(-8)}`;
    const schemaName = `school_${subdomain.replaceAll('-', '_')}`;
    const headers = { authorization: `Bearer ${await signAccessToken({
      sub: getSeedContext().superAdminUserId, role: 'super_admin', schemaName: TEST_SCHEMA_NAME,
    })}` };
    try {
      const response = await request().post('/api/v1/admin/schools').set(headers).send({
        name: 'École revue adresse', subdomain, city: 'Abidjan', address: 'Rue des écoles, Cocody',
        teaching_type: 'secondaire', director_name: 'Direction revue', director_phone: '2250709998888',
        active_school_year: '09/2026 - 06/2027', plan: 'pro',
      });
      expect(response.status).toBe(201);
      const details = await request().get(`/api/v1/admin/schools/${response.body.tenantId}`).set(headers);
      expect(details.status).toBe(200);
      expect(details.body.metadata.address).toBe('Rue des écoles, Cocody');
      const login = await request().post('/api/v1/auth/login/teacher').set('x-tenant-schema', schemaName)
        .send({ identifier: '2250709998888', password: response.body.directorCredentials.password });
      expect(login.status, JSON.stringify(login.body)).toBe(200);
      const schoolInfo = await request().get('/api/v1/school/info').set({
        authorization: `Bearer ${login.body.accessToken}`, 'x-tenant-schema': schemaName,
      });
      expect(schoolInfo.status).toBe(200);
      expect(schoolInfo.body.address).toBe('Rue des écoles, Cocody');
    } finally {
      // Only this additional school in the disposable test database is removed.
      for (const table of ['admin_access_log', 'school_sms_features', 'subscriptions']) {
        await queryPublic(`DELETE FROM public.${table} WHERE tenant_id IN (SELECT id FROM public.tenants WHERE schema_name=$1)`, [schemaName]);
      }
      await queryPublic('DELETE FROM public.tenants WHERE schema_name=$1', [schemaName]);
      await queryPublic(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    }
  });
});
