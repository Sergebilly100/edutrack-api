import { beforeAll, describe, expect, it } from 'vitest';

import { signAccessToken } from '../../src/modules/auth/auth.service.js';
import { getAuthHeaders, getSeedContext, queryTenant, request, tenantTable, TEST_SCHEMA_NAME } from './setup.js';

const suffix = String(Date.now());

type IdRow = { id: string };

describe('conduct routes (5b)', () => {
  let directorHeaders: Record<string, string>;
  let educatorStaffUserId = '';
  let educatorHeaders: Record<string, string>;
  let plainStaffHeaders: Record<string, string>;
  let teacherAHeaders: Record<string, string>;
  let teacherBHeaders: Record<string, string>;
  let teacherAUserId = '';
  let teacherCUserId = '';

  let classId = '';
  let studentId = '';
  let secondStudentId = '';
  let gradingPeriodId = '';
  let futureGradingPeriodId = '';

  const seedTeacher = async (label: string): Promise<string> => {
    const users = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('users')} (role, name, phone, password_hash, is_active)
       VALUES ('teacher', $1, $2, 'not-used', true) RETURNING id::text`,
      [`Prof ${label}`, `225078${String(Math.floor(Math.random() * 100000000)).padStart(8, '0')}`]
    );
    return users[0]!.id;
  };

  const seedScheduleLink = async (teacherUserId: string, teacherId: string): Promise<void> => {
    await queryTenant(
      `INSERT INTO ${tenantTable('schedule_periods')} (name, valid_from, valid_to, is_active)
       VALUES ($1, '2094-09-01', '2095-06-30', true)`,
      [`Conduct EDT ${teacherUserId}`]
    );
    await queryTenant(
      `INSERT INTO ${tenantTable('schedules')}
         (schedule_period_id, teacher_id, class_id, room_id, time_slot_id, day_of_week, subject)
       SELECT sp.id::uuid, $2::uuid, $3::uuid,
              (SELECT id FROM ${tenantTable('rooms')} WHERE name = 'Conduct Room ${suffix}' LIMIT 1),
              (SELECT id FROM ${tenantTable('time_slots')} ORDER BY sort_order LIMIT 1),
              1, 'SVT'
       FROM ${tenantTable('schedule_periods')} sp
       WHERE sp.name = $1
       LIMIT 1`,
      [`Conduct EDT ${teacherUserId}`, teacherId, classId]
    );
  };

  beforeAll(async () => {
    const context = getSeedContext();
    directorHeaders = await getAuthHeaders('director');

    // Année scolaire dédiée + période d'évaluation
    await queryTenant(
      `UPDATE ${tenantTable('school_years')} SET status='closed' WHERE status='active'`
    );
    const years = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('school_years')} (label, start_date, end_date, end_of_year_review_start_date, status)
       VALUES ($1, '2094-09-01', '2095-06-30', '2095-05-01', 'active') RETURNING id::text`,
      [`cy-${suffix}`]
    );
    const periods = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('grading_periods')} (school_year_id, type, order_index, label, start_date, end_date)
       VALUES ($1::uuid, 'trimester', 1, 'Trimestre 1 conduct', '2094-09-01', '2094-12-15') RETURNING id::text`,
      [years[0]!.id]
    );
    gradingPeriodId = periods[0]!.id;
    const futurePeriods = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('grading_periods')} (school_year_id, type, order_index, label, start_date, end_date)
       VALUES ($1::uuid, 'trimester', 2, 'Trimestre 2 conduct', '2095-01-01', '2095-03-31') RETURNING id::text`,
      [years[0]!.id]
    );
    futureGradingPeriodId = futurePeriods[0]!.id;

    // Niveau / classe / élève
    const levels = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('levels')} (name, order_index, is_exam_class) VALUES ($1, 99500, false) RETURNING id::text`,
      [`Conduct level ${suffix}`]
    );
    const classes = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('classes')} (name, level_id, school_year_id, is_active)
       VALUES ($1, $2::uuid, $3::uuid, true) RETURNING id::text`,
      [`Conduct class ${suffix}`, levels[0]!.id, years[0]!.id]
    );
    classId = classes[0]!.id;
    const students = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, matricule)
       VALUES ($1::uuid, 'Awa', 'Conduct', $2) RETURNING id::text`,
      [classId, `CON-${suffix}`]
    );
    studentId = students[0]!.id;
    const secondStudents = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, matricule)
       VALUES ($1::uuid, 'Yao', 'Conduct', $2) RETURNING id::text`,
      [classId, `CON-BULK-${suffix}`]
    );
    secondStudentId = secondStudents[0]!.id;

    // Salle dédiée aux EDT de test + créneau par défaut existant
    await queryTenant(
      `INSERT INTO ${tenantTable('rooms')} (name, qr_token) VALUES ($1, $2)`,
      [`Conduct Room ${suffix}`, `conduct-room-${suffix}`]
    );

    // Poste éducateur : permission exclusive conduct.finalize sur le staff seedé
    educatorStaffUserId = context.staffUserId;
    const positions = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('admin_positions')} (name, permissions, created_by)
       VALUES ($1, $2::jsonb, $3::uuid) RETURNING id::text`,
      [`Éducateur ${suffix}`, JSON.stringify(['conduct.finalize']), context.directorUserId]
    );
    await queryTenant(
      `INSERT INTO ${tenantTable('position_assignments')} (user_id, position_id, assigned_by)
       VALUES ($1::uuid, $2::uuid, $3::uuid)`,
      [educatorStaffUserId, positions[0]!.id, context.directorUserId]
    );
    const staffToken = await signAccessToken({
      sub: educatorStaffUserId,
      role: 'staff',
      schemaName: TEST_SCHEMA_NAME,
    });
    educatorHeaders = { authorization: `Bearer ${staffToken}` };

    // Staff sans aucun poste : ne doit jamais détenir conduct.finalize
    const plainStaff = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('users')} (role, name, phone, password_hash, is_active)
       VALUES ('staff', $1, $2, 'not-used', true) RETURNING id::text`,
      [`Plain Staff ${suffix}`, '2250790000011']
    );
    plainStaffHeaders = {
      authorization: `Bearer ${await signAccessToken({ sub: plainStaff[0]!.id, role: 'staff', schemaName: TEST_SCHEMA_NAME })}`,
    };

    // Profs A et B enseignent dans la classe ; C n'y enseigne pas
    const teacherAUser = await seedTeacher('A conduct');
    teacherAUserId = teacherAUser;
    const teacherBUser = await seedTeacher('B conduct');
    teacherCUserId = await seedTeacher('C conduct');

    const teachersA = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('teachers')} (user_id, username, type, subjects, hourly_rate)
       VALUES ($1::uuid, $2, 'vacataire', '{SVT}', 4500) RETURNING id::text`,
      [teacherAUser, `conduct.a.${suffix}`]
    );
    const teachersB = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('teachers')} (user_id, username, type, subjects, hourly_rate)
       VALUES ($1::uuid, $2, 'vacataire', '{SVT}', 4500) RETURNING id::text`,
      [teacherBUser, `conduct.b.${suffix}`]
    );
    await queryTenant(
      `INSERT INTO ${tenantTable('teachers')} (user_id, username, type, subjects, hourly_rate)
       VALUES ($1::uuid, $2, 'vacataire', '{SVT}', 4500)`,
      [teacherCUserId, `conduct.c.${suffix}`]
    );

    await seedScheduleLink(teacherAUser, teachersA[0]!.id);
    await seedScheduleLink(teacherBUser, teachersB[0]!.id);

    const conductSubjects = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('subjects')} (level_id, name, coefficient)
       VALUES ($1::uuid, 'SVT', 2) RETURNING id::text`,
      [levels[0]!.id]
    );
    await queryTenant(
      `INSERT INTO ${tenantTable('teacher_subject_assignments')} (teacher_id, subject_id, class_id)
       VALUES ($1::uuid, $3::uuid, $4::uuid), ($2::uuid, $3::uuid, $4::uuid)`,
      [teachersA[0]!.id, teachersB[0]!.id, conductSubjects[0]!.id, classId]
    );
    await queryTenant(
      `INSERT INTO ${tenantTable('class_subject_completion')} (class_id, subject_id, grading_period_id, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'in_progress')`,
      [classId, conductSubjects[0]!.id, gradingPeriodId]
    );

    teacherAHeaders = {
      authorization: `Bearer ${await signAccessToken({ sub: teacherAUser, role: 'teacher', schemaName: TEST_SCHEMA_NAME })}`,
    };
    teacherBHeaders = {
      authorization: `Bearer ${await signAccessToken({ sub: teacherBUser, role: 'teacher', schemaName: TEST_SCHEMA_NAME })}`,
    };
  });

  it("refuse d'assigner un utilisateur ne détenant pas conduct.finalize", async () => {
    const response = await request()
      .post('/api/v1/conduct/educator-assignments')
      .set(directorHeaders)
      .send({ user_id: teacherCUserId, class_id: classId });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('CONDUCT_FINALIZE_PERMISSION_MISSING');
  });

  it('assigne un éducateur détenant effectivement la permission', async () => {
    const response = await request()
      .post('/api/v1/conduct/educator-assignments')
      .set(directorHeaders)
      .send({ user_id: educatorStaffUserId, class_id: classId });

    expect(response.status, JSON.stringify(response.body)).toBe(201);

    const list = await request().get('/api/v1/conduct/educator-assignments').set(directorHeaders);
    expect(list.status).toBe(200);
    expect(
      list.body.assignments.some((a: { userId: string }) => a.userId === educatorStaffUserId)
    ).toBe(true);
  });

  it("refuse un doublon d'éducateur sur la même classe", async () => {
    // Un directeur détient implicitement toutes les permissions : il est un
    // candidat valide côté service, mais la classe a déjà son éducateur.
    const context = getSeedContext();
    const response = await request()
      .post('/api/v1/conduct/educator-assignments')
      .set(directorHeaders)
      .send({ user_id: context.directorUserId, class_id: classId });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('EDUCATOR_ASSIGNMENT_CONFLICT');
  });

  it('accepte les saisies de plusieurs profs puis permet au même prof de modifier la sienne', async () => {
    const first = await request()
      .post('/api/v1/conduct/inputs')
      .set(teacherAHeaders)
      .send({ student_id: studentId, grading_period_id: gradingPeriodId, note: 16, observation: 'Sérieux' });
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    const second = await request()
      .post('/api/v1/conduct/inputs')
      .set(teacherBHeaders)
      .send({ student_id: studentId, grading_period_id: gradingPeriodId, note: 12, observation: 'Bavard' });
    expect(second.status, JSON.stringify(second.body)).toBe(201);

    const update = await request()
      .post('/api/v1/conduct/inputs')
      .set(teacherAHeaders)
      .send({ student_id: studentId, grading_period_id: gradingPeriodId, note: 14 });
    expect(update.status, JSON.stringify(update.body)).toBe(201);

    const inputs = await queryTenant<{ note: string }>(
      `SELECT note FROM ${tenantTable('teacher_conduct_inputs')}
       WHERE student_id = $1::uuid AND grading_period_id = $2::uuid
       AND teacher_id = (SELECT id FROM ${tenantTable('teachers')} WHERE user_id = $3::uuid)`,
      [studentId, gradingPeriodId, teacherAUserId]
    );
    expect(inputs).toEqual([{ note: '14.00' }]);
  });

  it("refuse la saisie par un prof qui n'enseigne pas dans la classe", async () => {
    const response = await request()
      .post('/api/v1/conduct/inputs')
      .set({
        authorization: `Bearer ${await signAccessToken({ sub: teacherCUserId, role: 'teacher', schemaName: TEST_SCHEMA_NAME })}`,
      })
      .send({ student_id: studentId, grading_period_id: gradingPeriodId, note: 10 });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('STUDENT_NOT_IN_TEACHER_CLASSES');
  });

  it('refuse toute saisie de conduite dans une période future', async () => {
    const response = await request()
      .post('/api/v1/conduct/inputs')
      .set(teacherAHeaders)
      .send({ student_id: studentId, grading_period_id: futureGradingPeriodId, note: 10 });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('GRADING_PERIOD_NOT_CURRENT');
  });

  it('charge le périmètre du prof puis attribue une note de conduite en lot', async () => {
    const before = await request()
      .get('/api/v1/conduct/inputs/scope')
      .set(teacherAHeaders)
      .query({ class_id: classId, grading_period_id: gradingPeriodId });
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body.students).toEqual(expect.arrayContaining([
      expect.objectContaining({ studentId, input: expect.objectContaining({ note: 14 }) }),
      expect.objectContaining({ studentId: secondStudentId, input: null }),
    ]));

    const bulk = await request()
      .post('/api/v1/conduct/inputs/bulk')
      .set(teacherAHeaders)
      .send({
        class_id: classId,
        student_ids: [secondStudentId],
        grading_period_id: gradingPeriodId,
        note: 16,
        observation: 'Note commune de départ',
      });
    expect(bulk.status, JSON.stringify(bulk.body)).toBe(201);
    expect(bulk.body.savedCount).toBe(1);

    const after = await request()
      .get('/api/v1/conduct/inputs/scope')
      .set(teacherAHeaders)
      .query({ class_id: classId, grading_period_id: gradingPeriodId });
    expect(after.body.students).toEqual(expect.arrayContaining([
      expect.objectContaining({
        studentId: secondStudentId,
        input: expect.objectContaining({ note: 16, observation: 'Note commune de départ' }),
      }),
    ]));
  });

  it("consultation overview : deux saisies profs visibles pour l'éducateur", async () => {
    const response = await request()
      .get(`/api/v1/conduct/students/${studentId}/overview?grading_period_id=${gradingPeriodId}`)
      .set(educatorHeaders);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.student.fullName).toBe('Awa Conduct');
    expect(response.body.teacherInputs).toHaveLength(2);
    expect(response.body.finalGrade).toBeNull();
  });

  it('décision finale par l’éducateur assigné avec coefficient par défaut 1', async () => {
    const decided = await request()
      .put('/api/v1/conduct/grades')
      .set(educatorHeaders)
      .send({ student_id: studentId, grading_period_id: gradingPeriodId, note: 17 });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);

    const overview = await request()
      .get(`/api/v1/conduct/students/${studentId}/overview?grading_period_id=${gradingPeriodId}`)
      .set(educatorHeaders);
    expect(overview.body.finalGrade).toMatchObject({
      note: 17,
      coefficient: 1,
      decidedByUserId: educatorStaffUserId,
    });

    const updated = await request()
      .put('/api/v1/conduct/grades')
      .set(educatorHeaders)
      .send({ student_id: studentId, grading_period_id: gradingPeriodId, note: 16, coefficient: 2 });
    expect(updated.status).toBe(200);

    const afterUpdate = await request()
      .get(`/api/v1/conduct/students/${studentId}/overview?grading_period_id=${gradingPeriodId}`)
      .set(educatorHeaders);
    expect(afterUpdate.body.finalGrade).toMatchObject({ note: 16, coefficient: 2 });
  });

  it("refuse la décision d'un détenteur non assigné (directeur sans assignation)", async () => {
    const response = await request()
      .put('/api/v1/conduct/grades')
      .set(directorHeaders)
      .send({ student_id: studentId, grading_period_id: gradingPeriodId, note: 18 });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('NOT_ASSIGNED_EDUCATOR');
  });

  it('refuse la consultation à un staff sans conduct.finalize', async () => {
    const response = await request()
      .get(`/api/v1/conduct/students/${studentId}/overview?grading_period_id=${gradingPeriodId}`)
      .set(plainStaffHeaders);
    expect(response.status).toBe(403);
  });
});
