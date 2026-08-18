import ExcelJS from 'exceljs';
import path from 'node:path';
import { existsSync } from 'node:fs';
import type { Test } from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  getAuthHeaders,
  getSeedContext,
  queryTenant,
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

describe('import integration - students', () => {
  it('POST /api/v1/import/students/dry-run - 10 lignes valides → valid=10, errors=[]', async () => {
    const headers = await getAuthHeaders('director');
    const { className } = getSeedContext();
    const rows = Array.from({ length: 10 }, (_, i) => ({
      'Prénom*': `DryFirst${i + 1}`,
      'Nom*': `DryLast${i + 1}`,
      'Classe*': className,
      'Téléphone parent': `225070000${String(i + 1).padStart(4, '0')}`,
    }));

    const res = await attachStudents(
      request().post('/api/v1/import/students/dry-run').set(headers),
      rows
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ valid: 10, errors: [] });
  });

  it('POST /api/v1/import/students/dry-run - 3 lignes invalides → bons numéros de ligne', async () => {
    const headers = await getAuthHeaders('director');
    const { className } = getSeedContext();
    const rows = [
      { 'Prénom*': '', 'Nom*': 'BadOne', 'Classe*': className, 'Téléphone parent': '2250700000001' },
      { 'Prénom*': 'Bad', 'Nom*': 'Two', 'Classe*': 'Classe inconnue', 'Téléphone parent': '2250700000002' },
      { 'Prénom*': 'Bad', 'Nom*': 'Three', 'Classe*': className, 'Téléphone parent': '0700000000' },
    ];

    const res = await attachStudents(
      request().post('/api/v1/import/students/dry-run').set(headers),
      rows
    );

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(0);
    expect(res.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ row: 2, column: 'Prénom*' }),
        expect.objectContaining({ row: 3, column: 'Classe*' }),
        expect.objectContaining({ row: 4, column: 'Téléphone parent' }),
      ])
    );
  });

  it('POST /api/v1/import/students/confirm - persiste 10 élèves en DB', async () => {
    const headers = await getAuthHeaders('director');
    const { className } = getSeedContext();
    const prefix = uniquePrefix();

    const rows = Array.from({ length: 10 }, (_, i) => ({
      'Prénom*': `${prefix}_f_${i + 1}`,
      'Nom*': `${prefix}_l_${i + 1}`,
      'Classe*': className,
    }));

    const res = await attachStudents(
      request().post('/api/v1/import/students/confirm').set(headers),
      rows
    );

    expect(res.status).toBe(200);

    const [{ count }] = await queryTenant<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ${tenantTable('students')} WHERE first_name LIKE $1`,
      [`${prefix}_f_%`]
    );
    expect(Number(count)).toBe(10);
  });

  it('POST /api/v1/import/students/confirm - idempotent (rejeu → pas de doublons)', async () => {
    const headers = await getAuthHeaders('director');
    const { className } = getSeedContext();
    const prefix = uniquePrefix();

    const rows = Array.from({ length: 5 }, (_, i) => ({
      'Prénom*': `${prefix}_f_${i + 1}`,
      'Nom*': `${prefix}_l_${i + 1}`,
      'Classe*': className,
    }));

    await attachStudents(request().post('/api/v1/import/students/confirm').set(headers), rows);
    const second = await attachStudents(
      request().post('/api/v1/import/students/confirm').set(headers),
      rows
    );

    expect(second.status).toBe(200);
    const [{ count }] = await queryTenant<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ${tenantTable('students')} WHERE first_name LIKE $1`,
      [`${prefix}_f_%`]
    );
    expect(Number(count)).toBe(5);
  });

  it('POST /api/v1/import/students/confirm - crée et lie le parent sans envoyer de SMS', async () => {
    const headers = await getAuthHeaders('director');
    const { className } = getSeedContext();
    const prefix = uniquePrefix();
    const phone = `22501${Math.random().toString().slice(2, 10).padEnd(8, '0')}`;
    const rows = [
      {
        'Prénom*': `${prefix}_child`,
        'Nom*': 'ImportParent',
        'Classe*': className,
        'Nom parent': `Parent ${prefix}`,
        'Téléphone parent': phone,
        'Email parent': `${prefix}@test.ci`,
      },
    ];

    const res = await attachStudents(
      request().post('/api/v1/import/students/confirm').set(headers),
      rows
    );

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.pendingParentAccess).toEqual([
      expect.objectContaining({
        fullName: `Parent ${prefix}`,
        phone,
      }),
    ]);

    const links = await queryTenant<{
      parent_id: string;
      access_sent_at: string | null;
      must_change_password: boolean;
      subscription_id: string | null;
    }>(
      `
        SELECT
          p.id::text AS parent_id,
          p.access_sent_at::text,
          p.must_change_password,
          psl.subscription_id::text
        FROM ${tenantTable('parents')} p
        INNER JOIN ${tenantTable('parent_student_links')} psl ON psl.parent_id = p.id
        INNER JOIN ${tenantTable('students')} s ON s.id = psl.student_id
        WHERE p.phone = $1 AND s.first_name = $2
      `,
      [phone, `${prefix}_child`]
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      access_sent_at: null,
      must_change_password: true,
      subscription_id: null,
    });

    const [{ count }] = await queryTenant<{ count: number }>(
      `
        SELECT COUNT(*)::int AS count
        FROM ${tenantTable('notifications_log')}
        WHERE type = 'parent_access_credentials'
          AND related_id = $1::uuid
      `,
      [links[0]!.parent_id]
    );
    expect(count).toBe(0);
  });

  it('POST /api/v1/import/students/confirm - mode replace désactive les absents', async () => {
    const headers = await getAuthHeaders('director');
    const { className } = getSeedContext();
    const prefix = uniquePrefix();

    // Initial import: 3 students
    const initial = Array.from({ length: 3 }, (_, i) => ({
      'Prénom*': `${prefix}_f_${i + 1}`,
      'Nom*': `${prefix}_l_${i + 1}`,
      'Classe*': className,
    }));
    await attachStudents(
      request().post('/api/v1/import/students/confirm').set(headers).field('mode', 'merge'),
      initial
    );

    // Replace with only 1 student
    const replacement = [{ 'Prénom*': `${prefix}_f_1`, 'Nom*': `${prefix}_l_1`, 'Classe*': className }];
    const res = await attachStudents(
      request().post('/api/v1/import/students/confirm').set(headers).field('mode', 'replace'),
      replacement
    );

    expect(res.status).toBe(200);

    const [{ active_count }] = await queryTenant<{ active_count: number }>(
      `SELECT COUNT(*)::int AS active_count FROM ${tenantTable('students')} WHERE first_name LIKE $1 AND is_active = true`,
      [`${prefix}_f_%`]
    );
    expect(Number(active_count)).toBe(1);
  });

  it('POST /api/v1/import/students/dry-run - teacher sans permission → 403', async () => {
    const headers = await getAuthHeaders('teacher');
    const { className } = getSeedContext();

    const res = await attachStudents(
      request().post('/api/v1/import/students/dry-run').set(headers),
      [{ 'Prénom*': 'Awa', 'Nom*': 'Bah', 'Classe*': className }]
    );

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Teachers
// ---------------------------------------------------------------------------

describe('import integration - teachers', () => {
  it('POST /api/v1/import/teachers/dry-run - valide → valid=1, errors=[]', async () => {
    const headers = await getAuthHeaders('director');

    const rows = [
      { 'Nom*': 'Ouattara', 'Prénom*': 'Abou', 'Type*': 'vacataire', 'Matières*': 'Mathématiques', 'Taux horaire FCFA': '5000' },
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
    const { className } = getSeedContext();
    const prefix = uniquePrefix();

    // Perform a confirm to ensure at least one history entry
    await attachStudents(
      request().post('/api/v1/import/students/confirm').set(headers),
      [{ 'Prénom*': `${prefix}_h`, 'Nom*': 'History', 'Classe*': className }]
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
  it('GET /api/v1/import/students/template - retourne 200 ou 404 selon présence du fichier', async () => {
    const headers = await getAuthHeaders('director');

    const res = await request().get('/api/v1/import/students/template').set(headers);

    const templateExists = existsSync(path.resolve(process.cwd(), 'templates', 'students.xlsx'));
    if (templateExists) {
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toContain('students-template.xlsx');
    } else {
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('TEMPLATE_NOT_FOUND');
    }
  });

  it('GET /api/v1/import/invalid/template - type invalide → 400', async () => {
    const headers = await getAuthHeaders('director');

    const res = await request().get('/api/v1/import/invalid/template').set(headers);

    expect(res.status).toBe(400);
  });
});
