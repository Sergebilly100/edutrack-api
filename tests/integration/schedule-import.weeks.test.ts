import ExcelJS from 'exceljs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaultImportRepository } from '../../src/modules/import-export/import.repository.js';
import { getAuthHeaders, getSeedContext, queryTenant, request } from './setup.js';

let teacherName: string;
let classId: string;
let roomId: string;
let workbook: Buffer;

const bounds = (offset = 0) => {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() + ((8 - start.getUTCDay()) % 7 || 7) + offset * 7);
  const end = new Date(start); end.setUTCDate(end.getUTCDate() + 13);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
};
const importEdt = async (action: string, start?: string, end?: string, acknowledged = false) => {
  let req = request().post(`/api/v1/import/schedule/${action}`).set(await getAuthHeaders('director'));
  if (start !== undefined) req = req.field('week_start', start);
  if (end !== undefined) req = req.field('week_end', end);
  if (acknowledged) req = req.field('conflict_acknowledged', 'true');
  return req.attach('file', workbook, { filename: 'edt.xlsx' });
};
const counts = async () => (await queryTenant<{ periods: number; schedules: number; history: number; assignments: number }>(`
  SELECT (SELECT count(*)::int FROM schedule_periods) AS periods,
    (SELECT count(*)::int FROM schedules) AS schedules,
    (SELECT count(*)::int FROM import_history) AS history,
    (SELECT count(*)::int FROM teacher_subject_assignments) AS assignments`))[0];

beforeAll(async () => {
  const context = getSeedContext();
  await queryTenant('DELETE FROM schedules');
  await queryTenant('DELETE FROM schedule_periods');
  const [year] = await queryTenant<{ id: string }>("INSERT INTO school_years (label,start_date,end_date,status) VALUES ('C11','2026-01-01','2028-12-31','active') RETURNING id");
  const [level] = await queryTenant<{ id: string }>("INSERT INTO levels (name,order_index) VALUES ('C11',1) RETURNING id");
  const [subject] = await queryTenant<{ id: string }>("INSERT INTO subjects (level_id,name,coefficient) VALUES ($1,'Mathematiques',1) RETURNING id", [level!.id]);
  const [klass] = await queryTenant<{ id: string }>('UPDATE classes SET level_id=$1,school_year_id=$2 WHERE name=$3 RETURNING id', [level!.id,year!.id,context.className]);
  classId = klass!.id;
  await queryTenant('INSERT INTO teacher_subject_assignments (teacher_id,class_id,subject_id) VALUES ($1,$2,$3)', [context.teacherId,classId,subject!.id]);
  const [teacher] = await queryTenant<{ name: string }>('SELECT u.name FROM teachers t JOIN users u ON u.id=t.user_id WHERE t.id=$1', [context.teacherId]);
  teacherName = teacher!.name;
  roomId = (await queryTenant<{ id: string }>("SELECT id FROM rooms WHERE name='Salle A1'"))[0]!.id;
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('EDT');
  sheet.addRow(['Nom professeur*','Classe*','Matière*','Jour*','Créneau*','Salle']);
  sheet.addRow([teacherName,context.className,'Mathematiques','Lundi','08:00 - 09:00','Salle A1']);
  workbook = Buffer.from(await book.xlsx.writeBuffer());
});
afterEach(() => vi.restoreAllMocks());

describe('C11 complete weekly imports, real HTTP and persistence', () => {
  it('first preview → confirmation → manual slots on every teaching day of both weeks, without assignment writes', async () => {
    const period = bounds(); const initial = await counts();
    const preview = await importEdt('dry-run', period.start, period.end);
    expect(preview.status).toBe(200); expect(preview.body.valid).toBe(1);
    expect(await counts()).toEqual(initial);
    const confirmed = await importEdt('confirm', period.start, period.end);
    expect(confirmed.status).toBe(200); expect(confirmed.body.imported).toBe(1);
    const [created] = await queryTenant<{ id: string; name: string; valid_from: string; valid_to: string }>('SELECT id,name,valid_from::text,valid_to::text FROM schedule_periods');
    expect(created).toMatchObject({ name: `Import EDT ${period.start} - ${period.end}`, valid_from: period.start, valid_to: period.end });
    const headers = await getAuthHeaders('director');
    for (const week of [0, 1]) for (const day of [1, 2, 3, 4, 5, 6]) {
      const date = new Date(`${period.start}T00:00:00.000Z`); date.setUTCDate(date.getUTCDate() + week * 7 + day - 1);
      const added = await request().post('/api/v1/schedule').set(headers).send({
        schedule_period_id: created!.id, teacher_id: getSeedContext().teacherId, class_id: classId, room_id: roomId,
        day_of_week: day, subject: 'Mathematiques', start_time: '14:00', end_time: '15:00',
        recurrence: 'one_shot', effective_from: date.toISOString().slice(0, 10),
      });
      expect(added.status, JSON.stringify(added.body)).toBe(201);
      const active = await request().get(`/api/v1/schedule/active?date=${date.toISOString().slice(0, 10)}`).set(headers);
      expect(active.status).toBe(200);
      expect(active.body.schedules.some((slot: { id: string }) => slot.id === added.body.schedule.id)).toBe(true);
    }
    expect(await counts()).toMatchObject({ periods: 1, schedules: 13, history: 1, assignments: initial!.assignments });
  });

  it.each(['dry-run','confirm'])('%s refuses missing, partial, reversed and impossible dates without writes', async (action) => {
    const before = await counts();
    for (const [start,end] of [[undefined,undefined],['2026-06-01',undefined],[undefined,'2026-06-07'],['2026-06-02','2026-06-07'],['2026-06-01','2026-06-06'],['2026-06-08','2026-06-07'],['2026-02-30','2026-03-08']]) {
      const response = await importEdt(action,start,end,true);
      expect(response.status).toBe(400); expect(response.body.code).toMatch(/^IMPORT_INVALID_PERIOD/);
    }
    expect(await counts()).toEqual(before);
  });

  it('rechecks overlap on confirmation and keeps the existing acknowledgement rule', async () => {
    const period = bounds(); const before = await counts();
    const refused = await importEdt('confirm',period.start,period.end);
    expect(refused.status).toBe(400); expect(refused.body.code).toBe('IMPORT_CONFLICT_ACK_REQUIRED');
    expect(await counts()).toEqual(before);
    const accepted = await importEdt('confirm',period.start,period.end,true);
    expect(accepted.status).toBe(200); expect(accepted.body.updated).toBe(1);
    expect((await counts())!.periods).toBe(1);
  });

  it.each(['blocked','inactive','unassigned'])('rejects %s teacher after a successful preview without implicit assignment', async (state) => {
    const period = bounds(10); const before = await counts();
    expect((await importEdt('dry-run',period.start,period.end)).body.valid).toBe(1);
    const context = getSeedContext();
    if (state === 'blocked') await queryTenant('UPDATE teachers SET is_blocked=true WHERE id=$1',[context.teacherId]);
    if (state === 'inactive') await queryTenant('UPDATE users SET is_active=false WHERE id=$1',[context.teacherUserId]);
    const savedAssignments = state === 'unassigned' ? await queryTenant<{ subject_id: string }>('DELETE FROM teacher_subject_assignments WHERE teacher_id=$1 RETURNING subject_id',[context.teacherId]) : [];
    try {
      const rejected = await importEdt('confirm',period.start,period.end);
      expect(rejected.status).toBe(400); expect(rejected.body.code).toBe('IMPORT_VALIDATION_FAILED');
      expect(await counts()).toEqual({ ...before, assignments: state === 'unassigned' ? 0 : before!.assignments });
    } finally {
      await queryTenant('UPDATE teachers SET is_blocked=false WHERE id=$1',[context.teacherId]);
      await queryTenant('UPDATE users SET is_active=true WHERE id=$1',[context.teacherUserId]);
      for (const item of savedAssignments) await queryTenant('INSERT INTO teacher_subject_assignments (teacher_id,class_id,subject_id) VALUES ($1,$2,$3)',[context.teacherId,classId,item.subject_id]);
    }
  });

  it('rechecks assignments inside the transaction after outer validation succeeds', async () => {
    const period = bounds(15); const before = await counts();
    const original = defaultImportRepository.listScheduleAssignments;
    // Preserve the real validation read, then simulate a changed dependency in the transaction.
    let reads = 0;
    vi.spyOn(defaultImportRepository, 'listScheduleAssignments').mockImplementation(async (db) => {
      reads += 1;
      return reads === 1 ? original(db) : [];
    });
    const refused = await importEdt('confirm', period.start, period.end);
    expect(refused.status).toBe(400); expect(refused.body.code).toBe('IMPORT_TEACHER_ASSIGNMENT_REQUIRED');
    expect(reads).toBe(2);
    expect(await counts()).toEqual(before);
  });

  it('rolls back the period, imported slot and already written history on a late failure', async () => {
    const period = bounds(20); const before = await counts();
    const writeHistory = defaultImportRepository.createImportHistory;
    vi.spyOn(defaultImportRepository,'createImportHistory').mockImplementation(async (...args) => {
      await writeHistory(...args);
      throw new Error('C11 injected late failure after history insert');
    });
    const failed = await importEdt('confirm',period.start,period.end);
    expect(failed.status).toBe(500);
    expect(await counts()).toEqual(before);
  });

  it('all period routes reject partial bounds, including a partial update reversing persisted dates', async () => {
    const headers = await getAuthHeaders('director');
    const [period] = await queryTenant<{ id: string }>('SELECT id FROM schedule_periods LIMIT 1');
    for (const [method,path,payload] of [
      ['post','/api/v1/schedule/periods',{ name:'invalid',valid_from:'2026-06-02',valid_to:'2026-06-07' }],
      ['put',`/api/v1/schedule/periods/${period!.id}`,{ valid_to:'2026-06-06' }],
      ['post',`/api/v1/schedule/periods/${period!.id}/duplicate`,{ new_name:'invalid',new_valid_from:'2026-06-01',new_valid_to:'2026-06-06' }],
      ['put',`/api/v1/schedule/periods/${period!.id}`,{ valid_to:'2026-01-04' }],
    ] as const) {
      const response = await request()[method](path).set(headers).send(payload);
      expect(response.status).toBe(400);
    }
    expect((await counts())!.periods).toBe(1);
  });
  it('previews and imports exact flexible minutes, then rejects partial overlap while allowing adjacency', async () => {
    const period = bounds(100);
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('EDT');
    sheet.addRow(['Nom professeur*', 'Classe*', 'Matière*', 'Jour*', 'Créneau*', 'Salle']);
    sheet.addRow([teacherName, getSeedContext().className, 'Mathematiques', 'Lundi', '07:15 - 08:05', 'Salle A1']);
    const flexibleWorkbook = Buffer.from(await book.xlsx.writeBuffer());
    const headers = await getAuthHeaders('director');
    const sendImport = (action: 'dry-run' | 'confirm') => request()
      .post(`/api/v1/import/schedule/${action}`)
      .set(headers)
      .field('week_start', period.start)
      .field('week_end', period.end)
      .attach('file', flexibleWorkbook, { filename: 'edt-flexible.xlsx' });

    const preview = await sendImport('dry-run');
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.valid).toBe(1);
    const confirmed = await sendImport('confirm');
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    const [saved] = await queryTenant<{ id: string; start_time: string; end_time: string }>(`
      SELECT ts.id, ts.start_time::text, ts.end_time::text
      FROM schedules s JOIN time_slots ts ON ts.id = s.time_slot_id
      JOIN schedule_periods sp ON sp.id = s.schedule_period_id
      WHERE sp.valid_from = $1 AND sp.valid_to = $2 AND s.teacher_id = $3
        AND ts.start_time = '07:15'::time AND ts.end_time = '08:05'::time
      LIMIT 1`, [period.start, period.end, getSeedContext().teacherId]);
    expect(saved).toMatchObject({ start_time: '07:15:00', end_time: '08:05:00' });
    const reconfirmed = await request().post('/api/v1/import/schedule/confirm').set(headers)
      .field('week_start', period.start).field('week_end', period.end)
      .field('conflict_acknowledged', 'true')
      .attach('file', flexibleWorkbook, { filename: 'edt-flexible.xlsx' });
    expect(reconfirmed.status, JSON.stringify(reconfirmed.body)).toBe(200);
    const [slotCount] = await queryTenant<{ count: number }>(
      "SELECT count(*)::int AS count FROM time_slots WHERE start_time = '07:15'::time AND end_time = '08:05'::time"
    );
    expect(slotCount?.count).toBe(1);

    const [createdPeriod] = await queryTenant<{ id: string }>(
      'SELECT id FROM schedule_periods WHERE valid_from = $1 AND valid_to = $2 LIMIT 1',
      [period.start, period.end]
    );
    const payload = {
      schedule_period_id: createdPeriod!.id, teacher_id: getSeedContext().teacherId,
      class_id: classId, room_id: roomId, day_of_week: 1, subject: 'Mathematiques',
      recurrence: 'one_shot', effective_from: period.start,
    };
    const overlapping = await request().post('/api/v1/schedule').set(headers)
      .send({ ...payload, start_time: '07:45', end_time: '08:30' });
    expect(overlapping.status, JSON.stringify(overlapping.body)).toBe(409);
    expect(overlapping.body.code).toBe('TEACHER_SCHEDULE_CONFLICT');

    const adjacent = await request().post('/api/v1/schedule').set(headers)
      .send({ ...payload, start_time: '08:05', end_time: '08:30' });
    expect(adjacent.status, JSON.stringify(adjacent.body)).toBe(201);
    const edited = await request().put(`/api/v1/schedule/${adjacent.body.schedule.id}`).set(headers)
      .send({ ...payload, start_time: '12:20', end_time: '13:10', update_scope: 'all' });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const [editedSlot] = await queryTenant<{ start_time: string; end_time: string }>(`
      SELECT ts.start_time::text, ts.end_time::text FROM schedules s
      JOIN time_slots ts ON ts.id = s.time_slot_id WHERE s.id = $1`, [adjacent.body.schedule.id]);
    expect(editedSlot).toEqual({ start_time: '12:20:00', end_time: '13:10:00' });
    const invalid = await request().post('/api/v1/schedule').set(headers)
      .send({ ...payload, start_time: '24:00', end_time: '08:30' });
    expect(invalid.status).toBe(400);
    const invalidEdit = await request().put(`/api/v1/schedule/${adjacent.body.schedule.id}`).set(headers)
      .send({ ...payload, start_time: '12:60', end_time: '13:10', update_scope: 'all' });
    expect(invalidEdit.status).toBe(400);
  });
});
