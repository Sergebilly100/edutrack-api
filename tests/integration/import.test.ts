import ExcelJS from 'exceljs';
import type { Test } from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  getAuthHeaders,
  getSeedContext,
  queryTenant,
  queryPublic,
  TEST_SCHEMA_NAME,
  request,
  tenantTable,
} from './setup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const toWorkbookBuffer = async (
  rows: Record<string, string>[],
  sheetName = 'Sheet1'
): Promise<Buffer> => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  if (rows.length > 0) {
    const headers = Array.from(
      rows.reduce<Set<string>>((acc, row) => {
        for (const key of Object.keys(row)) acc.add(key);
        return acc;
      }, new Set<string>())
    );
    sheet.columns = headers.map((header) => ({ header, key: header }));
    for (const row of rows) {
      sheet.addRow(row);
    }
  }
  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.from(buf);
};

const attachFile = (req: Test, buf: Buffer, filename = 'import.xlsx') =>
  req.attach('file', buf, {
    filename,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

const attachStudents = async (req: Test, rows: Record<string, string>[]) =>
  attachFile(req, await toWorkbookBuffer(rows), 'students.xlsx');

const attachTeachers = async (req: Test, rows: Record<string, string>[]) =>
  attachFile(req, await toWorkbookBuffer(rows), 'teachers.xlsx');

const attachSchedule = async (req: Test, rows: Record<string, string>[]) =>
  attachFile(req, await toWorkbookBuffer(rows), 'schedule.xlsx');

const uniquePrefix = () => `int_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

const nextFullWeek = (offsetWeeks = 0): { monday: string; sunday: string } => {
  const monday = new Date();
  monday.setUTCHours(0, 0, 0, 0);
  const daysUntilNextMonday = ((8 - monday.getUTCDay()) % 7) || 7;
  monday.setUTCDate(monday.getUTCDate() + daysUntilNextMonday + offsetWeeks * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  const toIso = (date: Date) => date.toISOString().slice(0, 10);
  return { monday: toIso(monday), sunday: toIso(sunday) };
};

// ---------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await queryPublic(`INSERT INTO public.tenants (name,subdomain,schema_name,plan,status,onboarding_completed)
    VALUES ('Import initial', $1, $1, 'pro', 'active', false)
    ON CONFLICT (schema_name) DO UPDATE SET onboarding_completed = false`, [TEST_SCHEMA_NAME]);
});

describe('legacy student import is replaced by historical profiles', () => {
  it.each(['dry-run', 'confirm'])('refuses director legacy %s during initial configuration', async (action) => {
    const response = await attachStudents(request().post(`/api/v1/import/students/${action}`).set(await getAuthHeaders('director')),
      [{ 'Prénom*': 'Test', 'Nom*': 'Historical' }]);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('HISTORICAL_IMPORT_REQUIRED');
  });
  it('refuses a teacher without import permission', async () => {
    const response = await attachStudents(request().post('/api/v1/import/students/dry-run').set(await getAuthHeaders('teacher')),
      [{ 'Prénom*': 'Test', 'Nom*': 'Historical' }]);
    expect(response.status).toBe(403);
  });
});

// Teacher profile imports remain available until onboarding is finalized.
describe('import integration - teachers', () => {
  it('POST /api/v1/import/teachers/dry-run - valide → valid=1, errors=[]', async () => {
    const headers = await getAuthHeaders('director');

    const rows = [
      { 'Nom*': 'Ouattara', 'Prénom*': 'Abou', 'Type*': 'vacataire', 'Matières*': 'Mathématiques', 'Taux horaire FCFA': '5000', 'Téléphone': '2250700000099' },
    ];

    const res = await attachTeachers(
      request().post('/api/v1/import/teachers/dry-run').set(headers),
      rows
    );

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(1);
    expect(res.body.errors).toHaveLength(0);
  });

  it('POST /api/v1/import/teachers/confirm - persiste un prof en DB', async () => {
    const headers = await getAuthHeaders('director');
    const prefix = uniquePrefix();

    const rows = [
      {
        'Nom*': prefix,
        'Prénom*': 'Integration',
        'Type*': 'vacataire',
        'Matières*': 'Physique',
        'Taux horaire FCFA': '4000',
        'Email': `${prefix.toLowerCase()}@test.ci`,
      },
    ];

    const res = await attachTeachers(
      request().post('/api/v1/import/teachers/confirm').set(headers),
      rows
    );

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);

    const [{ count }] = await queryTenant<{ count: number }>(
      `
        SELECT COUNT(*)::int AS count
        FROM ${tenantTable('teachers')} t
        INNER JOIN ${tenantTable('users')} u ON u.id = t.user_id
        WHERE u.name = $1
      `,
      [`Integration ${prefix}`]
    );
    expect(Number(count)).toBeGreaterThanOrEqual(1);
  });

  it('POST /api/v1/import/teachers/confirm - prof importé doit changer son mot de passe', async () => {
    // Sécurité : le mot de passe d'import est partagé, le prof doit donc être
    // forcé de le changer à la première connexion (must_change_password = true).
    const headers = await getAuthHeaders('director');
    const prefix = uniquePrefix();

    const rows = [
      {
        'Nom*': prefix,
        'Prénom*': 'Securite',
        'Type*': 'vacataire',
        'Matières*': 'Physique',
        'Taux horaire FCFA': '4000',
        'Email': `${prefix.toLowerCase()}-sec@test.ci`,
      },
    ];

    const res = await attachTeachers(
      request().post('/api/v1/import/teachers/confirm').set(headers),
      rows
    );

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);

    const [{ must_change_password: mustChange }] = await queryTenant<{
      must_change_password: boolean;
    }>(
      `
        SELECT u.must_change_password
        FROM ${tenantTable('teachers')} t
        INNER JOIN ${tenantTable('users')} u ON u.id = t.user_id
        WHERE u.name = $1
      `,
      [`Securite ${prefix}`]
    );
    expect(mustChange).toBe(true);
  });

  it('POST /api/v1/import/teachers/dry-run - type invalide → erreur', async () => {
    const headers = await getAuthHeaders('director');

    const rows = [
      { 'Nom*': 'Bah', 'Prénom*': 'Mamadou', 'Type*': 'contractuel', 'Matières*': 'Histoire', 'Taux horaire FCFA': '3000' },
    ];

    const res = await attachTeachers(
      request().post('/api/v1/import/teachers/dry-run').set(headers),
      rows
    );

    expect(res.status).toBe(200);
    expect(res.body.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ column: 'Type*' })])
    );
  });
});

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

describe('import integration - schedule', () => {
  beforeAll(async () => {
    // EDT import requires an active year and explicit pedagogical assignments.
    const context = getSeedContext();
    const [year] = await queryTenant<{ id: string }>(`INSERT INTO school_years (label, start_date, end_date, status)
      VALUES ('09/2026 - 06/2027', '2026-09-01', '2027-06-30', 'active') RETURNING id`);
    const [level] = await queryTenant<{ id: string }>(`INSERT INTO levels (name, order_index) VALUES ('Import EDT', 1) RETURNING id`);
    const [subject] = await queryTenant<{ id: string }>(`INSERT INTO subjects (level_id, name, coefficient)
      VALUES ($1, 'Mathématiques', 1) RETURNING id`, [level!.id]);
    const [schoolClass] = await queryTenant<{ id: string }>('UPDATE classes SET level_id=$1, school_year_id=$2 WHERE name=$3 RETURNING id', [level!.id, year!.id, context.className]);
    await queryTenant('INSERT INTO teacher_subject_assignments (teacher_id, class_id, subject_id) VALUES ($1, $2, $3)', [context.teacherId, schoolClass!.id, subject!.id]);
  });

  it('POST /api/v1/import/schedule/dry-run - valide avec période → valid=1, errors=[]', async () => {
    const headers = await getAuthHeaders('director');
    const { className } = getSeedContext();
    const context = getSeedContext();

    // We need a teacher name matching the seeded teacher
    const [{ name: teacherName }] = await queryTenant<{ name: string }>(
      `SELECT u.name FROM ${tenantTable('teachers')} t INNER JOIN ${tenantTable('users')} u ON u.id = t.user_id WHERE t.id = $1`,
      [context.teacherId]
    );
    const [{ label: slotLabel }] = await queryTenant<{ label: string }>(
      `SELECT label FROM ${tenantTable('time_slots')} LIMIT 1`,
      []
    );

    const rows = [
      {
        'Nom professeur*': teacherName,
        'Classe*': className,
        'Matière*': 'Mathématiques',
        'Jour*': 'Lundi',
        'Créneau*': slotLabel,
        Salle: 'Salle A1',
      },
    ];

    // Dates relatives à aujourd'hui : le lundi de la semaine PROCHAINE (toujours
    // futur), sinon le validateur rejette le créneau passé (test sinon fragile
    // avec des dates codées en dur qui deviennent passées avec le temps).
    const period = nextFullWeek();

    const res = await attachSchedule(
      request()
        .post('/api/v1/import/schedule/dry-run')
        .set(headers)
        .field('week_start', period.monday)
        .field('week_end', period.sunday),
      rows
    );

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(1);
    expect(res.body.errors).toHaveLength(0);
  });

  it('POST /api/v1/import/schedule/confirm - rattache le professeur, la classe et la matière importée', async () => {
    const headers = await getAuthHeaders('director');
    const context = getSeedContext();
    const suffix = Date.now().toString();
    const subjectName = `Importtest ${suffix}`;

    const classes = await queryTenant<{ class_id: string; level_id: string }>(
      `SELECT s.class_id, c.level_id FROM ${tenantTable('schedules')} s JOIN ${tenantTable('classes')} c ON c.id=s.class_id WHERE s.id = $1`,
      [context.scheduleId]
    );
    const classId = classes[0]?.class_id;
    expect(classId).toBeTruthy();

    const levels = await queryTenant<{ id: string }>(
      `
        INSERT INTO ${tenantTable('levels')} (name, order_index, is_exam_class)
        VALUES ($1, 998, false)
        RETURNING id
      `,
      [`Import assignment level ${suffix}`]
    );
    const levelId = levels[0]?.id;
    expect(levelId).toBeTruthy();
    await queryTenant(
      `UPDATE ${tenantTable('classes')} SET level_id = $1 WHERE id = $2`,
      [levelId, classId]
    );

    const subjects = await queryTenant<{ id: string }>(
      `
        INSERT INTO ${tenantTable('subjects')} (level_id, name, coefficient)
        VALUES ($1, $2, 1)
        RETURNING id
      `,
      [levelId, subjectName]
    );
    const subjectId = subjects[0]?.id;
    expect(subjectId).toBeTruthy();
    await queryTenant('INSERT INTO teacher_subject_assignments (teacher_id, class_id, subject_id) VALUES ($1, $2, $3)', [context.teacherId, classId, subjectId]);


    const [{ name: teacherName }] = await queryTenant<{ name: string }>(
      `SELECT u.name FROM ${tenantTable('teachers')} t INNER JOIN ${tenantTable('users')} u ON u.id = t.user_id WHERE t.id = $1`,
      [context.teacherId]
    );
    const [{ label: slotLabel }] = await queryTenant<{ label: string }>(
      `SELECT label FROM ${tenantTable('time_slots')} LIMIT 1`,
      []
    );
    const period = nextFullWeek(3);

    const res = await attachSchedule(
      request()
        .post('/api/v1/import/schedule/confirm')
        .set(headers)
        .field('week_start', period.monday)
        .field('week_end', period.sunday),
      [
        {
          'Nom professeur*': teacherName,
          'Classe*': context.className,
          'Matière*': subjectName,
          'Jour*': 'Lundi',
          'Créneau*': slotLabel,
          Salle: 'Salle A1',
        },
      ]
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const assignments = await queryTenant<{ count: number }>(
      `
        SELECT COUNT(*)::int AS count
        FROM ${tenantTable('teacher_subject_assignments')}
        WHERE teacher_id = $1 AND class_id = $2 AND subject_id = $3
      `,
      [context.teacherId, classId, subjectId]
    );
    expect(assignments[0]?.count).toBe(1);
    // Restore the shared class's level so later tests retain valid subject dependencies.
    await queryTenant('UPDATE classes SET level_id = $1 WHERE id = $2', [classes[0].level_id, classId]);
  });

  it('POST /api/v1/import/schedule/confirm - sans conflictAcknowledged + conflit → 400 IMPORT_CONFLICT_ACK_REQUIRED', async () => {
    const headers = await getAuthHeaders('director');
    const { className } = getSeedContext();
    const context = getSeedContext();

    const [{ name: teacherName }] = await queryTenant<{ name: string }>(
      `SELECT u.name FROM ${tenantTable('teachers')} t INNER JOIN ${tenantTable('users')} u ON u.id = t.user_id WHERE t.id = $1`,
      [context.teacherId]
    );
    const [{ label: slotLabel }] = await queryTenant<{ label: string }>(
      `SELECT label FROM ${tenantTable('time_slots')} LIMIT 1`,
      []
    );

    // First import to create a distinct future period
    const rows = [
      {
        'Nom professeur*': teacherName,
        'Classe*': className,
        'Matière*': 'Mathématiques',
        'Jour*': 'Lundi',
        'Créneau*': slotLabel,
        Salle: 'Salle A1',
      },
    ];
    const period = nextFullWeek(1);

    const firstRes = await attachSchedule(
      request()
        .post('/api/v1/import/schedule/confirm')
        .set(headers)
        .field('week_start', period.monday)
        .field('week_end', period.sunday),
      rows
    );
    expect(firstRes.status).toBe(200);

    // Second import on same period - conflict, no ack
    const conflictRes = await attachSchedule(
      request()
        .post('/api/v1/import/schedule/confirm')
        .set(headers)
        .field('week_start', period.monday)
        .field('week_end', period.sunday)
        .field('conflict_acknowledged', 'false'),
      rows
    );

    expect(conflictRes.status).toBe(400);
    expect(conflictRes.body.code).toBe('IMPORT_CONFLICT_ACK_REQUIRED');
  });
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

describe('import integration - history', () => {
  it('GET /api/v1/import/history - retourne les imports confirmés', async () => {
    const headers = await getAuthHeaders('director');
    const prefix = uniquePrefix();

    // Perform a confirm to ensure at least one history entry
    await attachTeachers(
      request().post('/api/v1/import/teachers/confirm').set(headers),
      [{ 'Prénom*': `${prefix}_h`, 'Nom*': 'History', 'Type*': 'vacataire', 'Taux horaire FCFA': '3000' }]
    );

    const res = await request().get('/api/v1/import/history').set(headers);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('items');
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThanOrEqual(1);
    expect(res.body.items[0]).toMatchObject({
      type: expect.stringMatching(/students|teachers|schedule/),
      imported_count: expect.any(Number),
      updated_count: expect.any(Number),
    });
  });

  it('GET /api/v1/import/history - teacher sans permission → 403', async () => {
    const headers = await getAuthHeaders('teacher');

    const res = await request().get('/api/v1/import/history').set(headers);

    expect(res.status).toBe(403);
  });

  it('GET /api/v1/import/history - limit=5 respecté', async () => {
    const headers = await getAuthHeaders('director');

    const res = await request().get('/api/v1/import/history?limit=5').set(headers);

    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// Template download
// ---------------------------------------------------------------------------

describe('import integration - template', () => {
  it('refuses the legacy student template during onboarding', async () => {
    const res = await request().get('/api/v1/import/students/template').set(await getAuthHeaders('director'));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('HISTORICAL_IMPORT_REQUIRED');
  });

  it('GET /api/v1/import/invalid/template - type invalide → 400', async () => {
    const headers = await getAuthHeaders('director');

    const res = await request().get('/api/v1/import/invalid/template').set(headers);

    expect(res.status).toBe(400);
  });
});
