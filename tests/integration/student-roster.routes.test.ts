import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { getAuthHeaders, getSeedContext, queryTenant, request, TEST_SCHEMA_NAME } from './setup.js';

describe('school roster and reusable profiles', () => {
  let headers: Record<string, string>;
  let classId: string;
  let levelId: string;
  let otherLevelId: string;
  let otherClassId: string;
  let otherStudentId: string;
  let yearId: string;
  const students = new Map<string, string>();

  beforeAll(async () => {
    headers = await getAuthHeaders('director');
    await queryTenant("UPDATE school_years SET status = 'closed' WHERE status = 'active'");
    yearId = (await queryTenant<{ id: string }>(`INSERT INTO school_years (label,start_date,end_date,status)
      VALUES ('Roster active','2093-09-01','2094-06-30','active') RETURNING id`))[0]!.id;
    levelId = (await queryTenant<{ id: string }>(`INSERT INTO levels (name,order_index,is_exam_class)
      VALUES ('Roster level', 903, false) RETURNING id`))[0]!.id;
    classId = (await queryTenant<{ id: string }>(`INSERT INTO classes (name,level_id,school_year_id)
      VALUES ('Roster class',$1,$2) RETURNING id`, [levelId, yearId]))[0]!.id;
    otherLevelId = (await queryTenant<{ id: string }>(`INSERT INTO levels (name,order_index,is_exam_class)
      VALUES ('Roster other level', 904, false) RETURNING id`))[0]!.id;
    otherClassId = (await queryTenant<{ id: string }>(`INSERT INTO classes (name,level_id,school_year_id)
      VALUES ('Roster other class',$1,$2) RETURNING id`, [otherLevelId, yearId]))[0]!.id;
    otherStudentId = (await queryTenant<{ id: string }>(`INSERT INTO students (class_id,first_name,last_name,matricule)
      VALUES ($1,'Synthetic','Other','ROSTER-OTHER') RETURNING id`, [otherClassId]))[0]!.id;
    await queryTenant(`INSERT INTO enrollments (student_id,class_id,school_year_id,type,status)
      VALUES ($1,$2,$3,'new_registration','confirmed')`, [otherStudentId, otherClassId, yearId]);
    for (const status of ['pending_cashier', 'pending_dossier', 'blocked_unpaid', 'confirmed', 'historical', 'legacy']) {
      const id = (await queryTenant<{ id: string }>(`INSERT INTO students (class_id,first_name,last_name,matricule)
        VALUES ($1,'Synthetic','Roster',$2) RETURNING id`, [status === 'historical' ? null : classId, `ROSTER-${status}`]))[0]!.id;
      students.set(status, id);
      if (!['historical', 'legacy'].includes(status)) await queryTenant(`INSERT INTO enrollments
        (student_id,class_id,school_year_id,type,status) VALUES ($1,$2,$3,'new_registration',$4)`, [id, classId, yearId, status]);
    }
  });

  it('excludes every unconfirmed status, bare profiles and legacy class shortcuts from rows and total', async () => {
    for (const filters of [`&class_id=${classId}`, `&level_id=${levelId}&class_id=${classId}`]) {
      const result = await request().get(`/api/v1/students?search=ROSTER-&limit=1${filters}`).set(headers);
      expect(result.status).toBe(200);
      expect(result.body.data).toEqual([expect.objectContaining({ id: students.get('confirmed'), classId })]);
      expect(result.body.pagination).toMatchObject({ total: 1, totalPages: 1 });
    }
    const secondPage = await request().get(`/api/v1/students?search=ROSTER-&level_id=${levelId}&limit=1&page=2`).set(headers);
    expect(secondPage.body.data).toEqual([]);
    expect(secondPage.body.pagination.total).toBe(1);
  });

  it('limite liste et total au niveau, et refuse le couple niveau/classe incompatible', async () => {
    const listed = await request().get(`/api/v1/students?level_id=${levelId}&search=ROSTER-&limit=100`).set(headers);
    expect(listed.status).toBe(200);
    expect(listed.body.data.map((row: { id: string }) => row.id)).toContain(students.get('confirmed'));
    expect(listed.body.data.map((row: { id: string }) => row.id)).not.toContain(otherStudentId);
    expect(listed.body.pagination.total).toBe(1);
    const incompatible = await request().get(`/api/v1/students?level_id=${levelId}&class_id=${otherClassId}&search=ROSTER-`).set(headers);
    expect(incompatible.body.data).toEqual([]);
    expect(incompatible.body.pagination.total).toBe(0);
    const forged = await request().get(`/api/v1/students?level_id=${otherLevelId}&class_id=${classId}&search=ROSTER-`).set(headers);
    expect(forged.body.data).toEqual([]);
  });

  it('filtre statistiques et détail au niveau de la classe résolue', async () => {
    const date = '2093-09-05';
    const seedSchedule = (await queryTenant<{ teacher_id: string; room_id: string; time_slot_id: string }>(
      'SELECT teacher_id, room_id, time_slot_id FROM schedules WHERE id=$1', [getSeedContext().scheduleId]
    ))[0]!;
    const secondSlotId = (await queryTenant<{ id: string }>(`INSERT INTO time_slots
      (label,start_time,end_time,sort_order) VALUES ('Roster second slot','18:00','19:00',903) RETURNING id`))[0]!.id;
    const periodId = (await queryTenant<{ id: string }>(`INSERT INTO schedule_periods (name,valid_from,valid_to,is_active)
      VALUES ('Roster attendance',$1::date,$1::date,true) RETURNING id`, [date]))[0]!.id;
    const scheduleIds: string[] = [];
    for (const [index, currentClassId] of [classId, otherClassId].entries()) {
      const scheduleId = (await queryTenant<{ id: string }>(`INSERT INTO schedules
        (schedule_period_id,teacher_id,class_id,room_id,time_slot_id,day_of_week,subject,is_active)
        VALUES ($1,$2,$3,$4,$5,EXTRACT(ISODOW FROM $6::date)::int,'Math',true) RETURNING id`,
        [periodId, seedSchedule.teacher_id, currentClassId, seedSchedule.room_id,
          index === 0 ? seedSchedule.time_slot_id : secondSlotId, date]))[0]!.id;
      scheduleIds.push(scheduleId);
    }
    await queryTenant(`INSERT INTO attendances_student (student_id,schedule_id,date,status)
      VALUES ($1,$2,$3::date,'absent'),($4,$5,$3::date,'absent'),($6,$2,$3::date,'absent')`,
      [students.get('confirmed'), scheduleIds[0], date, otherStudentId, scheduleIds[1], students.get('pending_cashier')]);
    const stats = await request().get(`/api/v1/students/absence-stats?from=${date}&to=${date}&level_id=${levelId}`).set(headers);
    expect(stats.status, JSON.stringify(stats.body)).toBe(200);
    expect(stats.body.map((row: { studentId: string }) => row.studentId)).toContain(students.get('confirmed'));
    expect(stats.body.map((row: { studentId: string }) => row.studentId)).not.toContain(otherStudentId);
    expect(stats.body.map((row: { studentId: string }) => row.studentId)).not.toContain(students.get('pending_cashier'));
    const incompatibleStats = await request().get(`/api/v1/students/absence-stats?from=${date}&to=${date}&level_id=${levelId}&class_id=${otherClassId}`).set(headers);
    expect(incompatibleStats.body).toEqual([]);
    const detail = await request().get(`/api/v1/students/${students.get('confirmed')}/absences?from=${date}&to=${date}&level_id=${otherLevelId}`).set(headers);
    expect(detail.body).toEqual([]);
  });

  it('closes profile reuse search and keeps pending dossiers accessible by ID', async () => {
    const result = await request().get('/api/v1/students/profiles?search=ROSTER-').set(headers);
    expect(result.status).not.toBe(200);
    for (const status of ['pending_dossier', 'confirmed', 'historical']) {
      const detail = await request().get(`/api/v1/students/${students.get(status)}`).set(headers);
      expect(detail.status, JSON.stringify(detail.body)).toBe(200);
      expect(detail.body.data.id).toBe(students.get(status));
    }
  });

  it('does not accept a previous confirmed enrollment as confirmation of a current re-enrollment', async () => {
    const previousYear = (await queryTenant<{ id: string }>(`INSERT INTO school_years (label,start_date,end_date,status)
      VALUES ('Roster previous','2092-09-01','2093-06-30','closed') RETURNING id`))[0]!.id;
    const previousClass = (await queryTenant<{ id: string }>(`INSERT INTO classes (name,school_year_id)
      VALUES ('Roster previous class',$1) RETURNING id`, [previousYear]))[0]!.id;
    const studentId = students.get('pending_cashier')!;
    await queryTenant(`INSERT INTO enrollments (student_id,class_id,school_year_id,type,status)
      VALUES ($1,$2,$3,'new_registration','confirmed')`, [studentId, previousClass, previousYear]);
    const result = await request().get('/api/v1/students?search=ROSTER-pending_cashier').set(headers);
    expect(result.body.data).toEqual([]);
    expect(result.body.pagination.total).toBe(0);
    const oldClassList = await request().get(`/api/v1/students?class_id=${previousClass}`).set(headers);
    expect(oldClassList.body.data).toEqual([]);
    const former = (await queryTenant<{ id: string }>(`INSERT INTO students (first_name,last_name,matricule)
      VALUES ('Synthetic','Former','ROSTER-former') RETURNING id`))[0]!.id;
    await queryTenant(`INSERT INTO enrollments (student_id,class_id,school_year_id,type,status)
      VALUES ($1,$2,$3,'new_registration','confirmed')`, [former, previousClass, previousYear]);
    const reusable = await request().get('/api/v1/students/profiles?search=ROSTER-former').set(headers);
    expect(reusable.status).not.toBe(200);
    const financial = await request().get('/api/v1/students/financial-profiles?search=ROSTER-former').set(headers);
    expect(financial.body.data).toEqual([expect.objectContaining({ id: former })]);
  });

  it('does not expose profile reuse search to teachers or anonymous visitors', async () => {
    const teacher = await request().get('/api/v1/students/profiles?search=ROSTER-').set(await getAuthHeaders('teacher'));
    expect(teacher.status).not.toBe(200);
    expect((await request().get('/api/v1/students/profiles?search=ROSTER-')).status).not.toBe(200);
    expect((await request().get('/api/v1/students/financial-profiles?search=ROSTER-').set(await getAuthHeaders('teacher'))).status).toBe(403);
    const financial = await request().get('/api/v1/students/financial-profiles?search=ROSTER-historical').set(headers);
    expect(financial.body.data).toEqual([]);
  });

  it('replays the missing historical-source migration without modifying students, enrollments or payments', async () => {
    const before = await queryTenant(`SELECT (SELECT count(*) FROM students) AS students,
      (SELECT count(*) FROM enrollments) AS enrollments, (SELECT count(*) FROM payments) AS payments`);
    const enrollmentState = await queryTenant('SELECT id, class_id, school_year_id, status FROM enrollments ORDER BY id');
    const source = (await readFile('src/shared/database/migrations/0076_historical_student_sources.sql', 'utf8'))
      .replaceAll('"tenant"', `"${TEST_SCHEMA_NAME}"`);
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const statement of source.split('--> statement-breakpoint')) if (statement.trim()) await queryTenant(statement);
    }
    expect(await queryTenant(`SELECT (SELECT count(*) FROM students) AS students,
      (SELECT count(*) FROM enrollments) AS enrollments, (SELECT count(*) FROM payments) AS payments`)).toEqual(before);
    expect(await queryTenant('SELECT id, class_id, school_year_id, status FROM enrollments ORDER BY id')).toEqual(enrollmentState);
    expect((await request().get(`/api/v1/students/${students.get('confirmed')}`).set(headers)).status).toBe(200);
  });
});
