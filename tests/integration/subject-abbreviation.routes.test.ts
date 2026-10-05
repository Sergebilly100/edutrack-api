import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ParentPortalRepository } from '../../src/modules/parent-portal/parent-portal.repository.js';
import { withTenantSchema } from '../../src/shared/database/db.js';
import { getAuthHeaders, getSeedContext, queryPublic, queryTenant, request, tenantTable, TEST_SCHEMA_NAME } from './setup.js';

describe('subject abbreviation integration', () => {
  it('migrates an existing tenant idempotently and keeps old rows without an abbreviation', async () => {
    const [level] = await queryTenant<{ id: string }>(`
      INSERT INTO ${tenantTable('levels')} (name, order_index, is_exam_class)
      VALUES ($1, 929, false) RETURNING id
    `, [`Niveau migration ${Date.now()}`]);
    const [subject] = await queryTenant<{ id: string }>(`
      INSERT INTO ${tenantTable('subjects')} (level_id, name, coefficient)
      VALUES ($1, 'Histoire', 2) RETURNING id
    `, [level!.id]);

    await queryTenant(`ALTER TABLE ${tenantTable('subjects')} ADD COLUMN IF NOT EXISTS abbreviation varchar(30)`);
    await queryTenant(`ALTER TABLE ${tenantTable('subjects')} ADD COLUMN IF NOT EXISTS abbreviation varchar(30)`);
    const column = await queryTenant<{ is_nullable: string }>(`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'subjects' AND column_name = 'abbreviation'
    `);
    expect(column[0]?.is_nullable).toBe('YES');
    const rows = await queryTenant<{ abbreviation: string | null }>(
      `SELECT abbreviation FROM ${tenantTable('subjects')} WHERE id = $1`, [subject!.id]
    );
    expect(rows[0]?.abbreviation).toBeNull();

    const legacySchema = `${TEST_SCHEMA_NAME}_legacy`;
    await queryPublic(`CREATE SCHEMA "${legacySchema}"`);
    try {
      await queryPublic(`CREATE TABLE "${legacySchema}".subjects (name varchar(100) NOT NULL)`);
      await queryPublic(`INSERT INTO "${legacySchema}".subjects (name) VALUES ('Histoire')`);
      const migration = await readFile(path.resolve('src/shared/database/migrations/0085_subjects_abbreviation.sql'), 'utf8');
      const sql = migration.replaceAll('"tenant"', `"${legacySchema}"`);
      await queryPublic(sql);
      await queryPublic(sql);
      const migrated = await queryPublic<{ name: string; abbreviation: string | null }>(
        `SELECT name, abbreviation FROM "${legacySchema}".subjects`
      );
      expect(migrated).toEqual([{ name: 'Histoire', abbreviation: null }]);
    } finally {
      await queryPublic(`DROP SCHEMA "${legacySchema}" CASCADE`);
    }
  });

  it('creates, edits and reads the abbreviation through simple and grouped APIs', async () => {
    const headers = await getAuthHeaders('director');
    const suffix = Date.now().toString(36);
    const levels = await queryTenant<{ id: string }>(`
      INSERT INTO ${tenantTable('levels')} (name, order_index, is_exam_class)
      VALUES ($1, 930, false), ($2, 931, false)
      RETURNING id
    `, [`Niveau abréviation A ${suffix}`, `Niveau abréviation B ${suffix}`]);
    const first = levels[0]!.id;
    const second = levels[1]!.id;

    const created = await request().post('/api/v1/subjects').set(headers).send({
      levelId: first, name: 'Mathématiques', coefficient: 4, abbreviation: ' Maths ',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.subject.abbreviation).toBe('Maths');

    const edited = await request().patch(`/api/v1/subjects/${created.body.subject.id}`).set(headers).send({ abbreviation: ' ' });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.subject.abbreviation).toBeNull();

    const grouped = await request().post('/api/v1/subjects/bulk').set(headers).send({
      name: 'Français', abbreviation: 'Fr', assignments: [
        { levelId: first, coefficient: 3 }, { levelId: second, coefficient: 2 },
      ],
    });
    expect(grouped.status, JSON.stringify(grouped.body)).toBe(201);
    expect(grouped.body.subjects).toHaveLength(2);
    expect(grouped.body.subjects.every((subject: { abbreviation: string }) => subject.abbreviation === 'Fr')).toBe(true);

    const changed = await request().patch('/api/v1/subjects/bulk').set(headers).send({
      name: 'Français', abbreviation: ' Français ',
      assignments: grouped.body.subjects.map((subject: { id: string; levelId: string; coefficient: number }) => ({
        subjectId: subject.id, levelId: subject.levelId, coefficient: subject.coefficient,
      })),
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.subjects.every((subject: { abbreviation: string }) => subject.abbreviation === 'Français')).toBe(true);

    const listed = await request().get('/api/v1/subjects').set(headers);
    expect(listed.status).toBe(200);
    expect(listed.body.subjects).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: created.body.subject.id, abbreviation: null }),
      expect.objectContaining({ id: grouped.body.subjects[0].id, abbreviation: 'Français' }),
    ]));
  });

  it('uses only the reference from the class level and leaves the stored schedule subject intact', async () => {
    const headers = await getAuthHeaders('director');
    const { scheduleId } = getSeedContext();
    const suffix = Date.now().toString(36);
    const levels = await queryTenant<{ id: string }>(`
      INSERT INTO ${tenantTable('levels')} (name, order_index, is_exam_class)
      VALUES ($1, 940, false), ($2, 941, false)
      RETURNING id
    `, [`Niveau EDT A ${suffix}`, `Niveau EDT B ${suffix}`]);
    await queryTenant(`
      UPDATE ${tenantTable('classes')} SET level_id = $1
      WHERE id = (SELECT class_id FROM ${tenantTable('schedules')} WHERE id = $2)
    `, [levels[0]!.id, scheduleId]);

    const other = await request().post('/api/v1/subjects').set(headers).send({
      levelId: levels[1]!.id, name: 'Mathématiques', coefficient: 3, abbreviation: 'Autre',
    });
    expect(other.status, JSON.stringify(other.body)).toBe(201);
    const own = await request().post('/api/v1/subjects').set(headers).send({
      levelId: levels[0]!.id, name: 'Mathématiques', coefficient: 4, abbreviation: 'Maths',
    });
    expect(own.status, JSON.stringify(own.body)).toBe(201);

    const today = new Date().toISOString().slice(0, 10);
    const weekly = await request().get('/api/v1/schedule/weekly').query({ date: today }).set(headers);
    expect(weekly.status, JSON.stringify(weekly.body)).toBe(200);
    expect(weekly.body.schedules).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: scheduleId, subject: 'Mathematiques', subjectDisplay: 'Maths' }),
    ]));
    const teacherHeaders = await getAuthHeaders('teacher');
    const teacherWeek = await request().get('/api/v1/schedule/teacher/me/week').query({ date: today }).set(teacherHeaders);
    expect(teacherWeek.status, JSON.stringify(teacherWeek.body)).toBe(200);
    expect(teacherWeek.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: scheduleId, subject: 'Mathematiques', subjectDisplay: 'Maths' }),
    ]));
    const [scheduledClass] = await queryTenant<{ class_id: string }>(
      `SELECT class_id FROM ${tenantTable('schedules')} WHERE id = $1`, [scheduleId]
    );
    const monday = new Date(`${today}T00:00:00.000Z`);
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    const [scheduledDay] = await queryTenant<{ day_of_week: number }>(
      `SELECT day_of_week FROM ${tenantTable('schedules')} WHERE id = $1`, [scheduleId]
    );
    const activeDate = new Date(monday);
    activeDate.setUTCDate(activeDate.getUTCDate() + scheduledDay!.day_of_week - 1);
    const active = await request().get('/api/v1/schedule/active').query({ date: activeDate.toISOString().slice(0, 10) }).set(headers);
    expect(active.status, JSON.stringify(active.body)).toBe(200);
    expect(active.body.schedules).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: scheduleId, subject: 'Mathematiques', subjectDisplay: 'Maths' }),
    ]));
    const sunday = new Date(monday);
    sunday.setUTCDate(sunday.getUTCDate() + 6);
    const parentRows = await withTenantSchema(TEST_SCHEMA_NAME, (db) =>
      new ParentPortalRepository(db).listWeekSchedulesForClass({
        classId: scheduledClass!.class_id,
        weekStart: monday.toISOString().slice(0, 10),
        weekEnd: sunday.toISOString().slice(0, 10),
      })
    );
    const parentSlot = parentRows.find((row) => row.schedule_id === scheduleId);
    expect(parentSlot?.level_subjects).toEqual([
      expect.objectContaining({ abbreviation: 'Maths' }),
    ]);

    const stored = await queryTenant<{ subject: string }>(`SELECT subject FROM ${tenantTable('schedules')} WHERE id = $1`, [scheduleId]);
    expect(stored[0]?.subject).toBe('Mathematiques');
    const removed = await request().patch(`/api/v1/subjects/${own.body.subject.id}`).set(headers).send({ abbreviation: '' });
    expect(removed.status).toBe(200);
    const fallback = await request().get('/api/v1/schedule/weekly').query({ date: today }).set(headers);
    expect(fallback.body.schedules).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: scheduleId, subjectDisplay: 'Mathematiques' }),
    ]));
  });
});
