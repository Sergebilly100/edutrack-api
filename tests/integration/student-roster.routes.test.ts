import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { getAuthHeaders, queryTenant, request, TEST_SCHEMA_NAME } from './setup.js';

describe('school roster and reusable profiles', () => {
  let headers: Record<string, string>;
  let classId: string;
  let yearId: string;
  const students = new Map<string, string>();

  beforeAll(async () => {
    headers = await getAuthHeaders('director');
    await queryTenant("UPDATE school_years SET status = 'closed' WHERE status = 'active'");
    yearId = (await queryTenant<{ id: string }>(`INSERT INTO school_years (label,start_date,end_date,status)
      VALUES ('Roster active','2093-09-01','2094-06-30','active') RETURNING id`))[0]!.id;
    const levelId = (await queryTenant<{ id: string }>(`INSERT INTO levels (name,order_index,is_exam_class)
      VALUES ('Roster level', 903, false) RETURNING id`))[0]!.id;
    classId = (await queryTenant<{ id: string }>(`INSERT INTO classes (name,level_id,school_year_id)
      VALUES ('Roster class',$1,$2) RETURNING id`, [levelId, yearId]))[0]!.id;
    for (const status of ['pending_cashier', 'pending_dossier', 'blocked_unpaid', 'confirmed', 'historical', 'legacy']) {
      const id = (await queryTenant<{ id: string }>(`INSERT INTO students (class_id,first_name,last_name,matricule)
        VALUES ($1,'Synthetic','Roster',$2) RETURNING id`, [status === 'historical' ? null : classId, `ROSTER-${status}`]))[0]!.id;
      students.set(status, id);
      if (!['historical', 'legacy'].includes(status)) await queryTenant(`INSERT INTO enrollments
        (student_id,class_id,school_year_id,type,status) VALUES ($1,$2,$3,'new_registration',$4)`, [id, classId, yearId, status]);
    }
  });

  it('excludes every unconfirmed status, bare profiles and legacy class shortcuts from rows and total', async () => {
    for (const filters of ['', `&class_id=${classId}`, '&is_active=true']) {
      const result = await request().get(`/api/v1/students?search=ROSTER-&limit=1${filters}`).set(headers);
      expect(result.status).toBe(200);
      expect(result.body.data).toEqual([expect.objectContaining({ id: students.get('confirmed'), classId })]);
      expect(result.body.pagination).toMatchObject({ total: 1, totalPages: 1 });
    }
    const secondPage = await request().get('/api/v1/students?search=ROSTER-&limit=1&page=2').set(headers);
    expect(secondPage.body.data).toEqual([]);
    expect(secondPage.body.pagination.total).toBe(1);
  });

  it('keeps profiles discoverable for enrollment and pending dossiers accessible by ID', async () => {
    const result = await request().get('/api/v1/students/profiles?search=ROSTER-').set(headers);
    expect(result.status).toBe(200);
    expect(result.body.data.map((student: { id: string }) => student.id).sort()).toEqual([
      students.get('historical'), students.get('legacy'),
    ].sort());
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
    expect(reusable.body.data).toEqual([]);
    const financial = await request().get('/api/v1/students/financial-profiles?search=ROSTER-former').set(headers);
    expect(financial.body.data).toEqual([expect.objectContaining({ id: former })]);
  });

  it('denies profile search to teachers and anonymous visitors', async () => {
    const teacher = await request().get('/api/v1/students/profiles?search=ROSTER-').set(await getAuthHeaders('teacher'));
    expect(teacher.status).toBe(403);
    expect((await request().get('/api/v1/students/profiles?search=ROSTER-')).status).toBe(401);
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
