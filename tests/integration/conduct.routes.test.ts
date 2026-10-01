import { beforeAll, describe, expect, it } from 'vitest';

import { signAccessToken } from '../../src/modules/auth/auth.service.js';
import { getAuthHeaders, getSeedContext, queryPublic, queryTenant, request, tenantTable, TEST_SCHEMA_NAME } from './setup.js';

const suffix = String(Date.now());

type IdRow = { id: string };

describe('conduct routes (5b)', () => {
  let directorHeaders: Record<string, string>;
  let educatorStaffUserId = '';
  let educatorHeaders: Record<string, string>;
  let plainStaffHeaders: Record<string, string>;
  let personnelManagerHeaders: Record<string, string>;
  let teacherAHeaders: Record<string, string>;
  let teacherBHeaders: Record<string, string>;
  let teacherAUserId = '';
  let teacherCUserId = '';

  let classId = '';
  let studentId = '';
  let secondStudentId = '';
  let gradingPeriodId = '';
  let futureGradingPeriodId = '';
  let schoolYearId = '';
  let subjectId = '';

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
    schoolYearId = years[0]!.id;
    const periods = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('grading_periods')} (school_year_id, type, order_index, label, start_date, review_start_date, end_date)
       VALUES ($1::uuid, 'trimester', 1, 'Trimestre 1 conduct', CURRENT_DATE - 30, CURRENT_DATE, CURRENT_DATE + 30) RETURNING id::text`,
      [years[0]!.id]
    );
    gradingPeriodId = periods[0]!.id;
    const futurePeriods = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('grading_periods')} (school_year_id, type, order_index, label, start_date, review_start_date, end_date)
       VALUES ($1::uuid, 'trimester', 2, 'Trimestre 2 conduct', '2095-01-01', '2095-03-31', '2095-03-31') RETURNING id::text`,
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
    await queryTenant(`INSERT INTO ${tenantTable('enrollments')} (student_id, class_id, school_year_id, type, status)
      VALUES ($1::uuid, $3::uuid, $4::uuid, 'new_registration', 'confirmed'),
             ($2::uuid, $3::uuid, $4::uuid, 'new_registration', 'confirmed')`,
      [studentId, secondStudentId, classId, years[0]!.id]);

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
    const personnelManager = await queryTenant<IdRow>(`
      INSERT INTO ${tenantTable('users')} (role, name, phone, password_hash, is_active)
      VALUES ('staff', $1, $2, 'not-used', true) RETURNING id::text`,
    [`Personnel ${suffix}`, '2250790000022']);
    const personnelPosition = await queryTenant<IdRow>(`
      INSERT INTO ${tenantTable('admin_positions')} (name, permissions, created_by)
      VALUES ($1, $2::jsonb, $3::uuid) RETURNING id::text`,
    [`Personnel ${suffix}`, JSON.stringify(['settings.positions']), context.directorUserId]);
    await queryTenant(`INSERT INTO ${tenantTable('position_assignments')} (user_id, position_id, assigned_by)
      VALUES ($1::uuid, $2::uuid, $3::uuid)`,
    [personnelManager[0]!.id, personnelPosition[0]!.id, context.directorUserId]);
    personnelManagerHeaders = {
      authorization: `Bearer ${await signAccessToken({ sub: personnelManager[0]!.id, role: 'staff', schemaName: TEST_SCHEMA_NAME })}`,
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

    const conductSubjects = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('subjects')} (level_id, name, coefficient)
       VALUES ($1::uuid, 'SVT', 2) RETURNING id::text`,
      [levels[0]!.id]
    );
    subjectId = conductSubjects[0]!.id;
    await queryTenant(
      `INSERT INTO ${tenantTable('teacher_subject_assignments')} (teacher_id, subject_id, class_id)
       VALUES ($1::uuid, $3::uuid, $4::uuid), ($2::uuid, $3::uuid, $4::uuid)`,
      [teachersA[0]!.id, teachersB[0]!.id, conductSubjects[0]!.id, classId]
    );
    await queryTenant(
      `INSERT INTO ${tenantTable('class_subject_completion')} (class_id, subject_id, grading_period_id, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'completed')`,
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
    expect(response.body.code).toBe('INVALID_ASSIGNMENT_TARGET');
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
    const response = await request()
      .post('/api/v1/conduct/educator-assignments')
      .set(directorHeaders)
      .send({ user_id: educatorStaffUserId, class_id: classId });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('EDUCATOR_ASSIGNMENT_CONFLICT');
  });

  it('configure le mode délégué pour l’année', async () => {
    const response = await request().put(`/api/v1/conduct/policy/${schoolYearId}`)
      .set(directorHeaders).send({ mode: 'delegated', coefficient: 1 });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.policy).toMatchObject({ mode: 'delegated', coefficient: 1 });
  });

  it('permet au gestionnaire du personnel de consulter les portées sans modifier la politique', async () => {
    const [years, classes, levels, policy] = await Promise.all([
      request().get('/api/v1/school-years').set(personnelManagerHeaders),
      request().get('/api/v1/classes').query({ schoolYearId }).set(personnelManagerHeaders),
      request().get('/api/v1/levels').set(personnelManagerHeaders),
      request().get(`/api/v1/conduct/policy/${schoolYearId}`).set(personnelManagerHeaders),
    ]);
    for (const response of [years, classes, levels, policy]) {
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    }
    expect(classes.body.classes).toEqual(expect.arrayContaining([expect.objectContaining({ id: classId })]));
    expect(policy.body.policy.mode).toBe('delegated');
    const denied = await request().put(`/api/v1/conduct/policy/${schoolYearId}`)
      .set(personnelManagerHeaders).send({ mode: 'direction', coefficient: 2 });
    expect(denied.status).toBe(403);
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

  it('refuse une note de conduite pour un dossier non confirmé', async () => {
    const pendingId = (await queryTenant<IdRow>(`INSERT INTO ${tenantTable('students')}
      (class_id,first_name,last_name,matricule,is_active)
      VALUES ($1::uuid,'Dossier','En attente',$2,true) RETURNING id::text`, [classId, `CON-PENDING-${suffix}`]))[0]!.id;
    await queryTenant(`INSERT INTO ${tenantTable('enrollments')} (student_id,class_id,school_year_id,type,status)
      SELECT $1::uuid,c.id,c.school_year_id,'new_registration','pending_dossier'
      FROM ${tenantTable('classes')} c WHERE c.id=$2::uuid`, [pendingId, classId]);
    const response = await request().post('/api/v1/conduct/inputs').set(teacherAHeaders)
      .send({ student_id: pendingId, grading_period_id: gradingPeriodId, note: 10 });
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('STUDENT_NOT_FOUND');
  });

  it('refuse toute saisie de conduite dans une période future', async () => {
    const response = await request()
      .post('/api/v1/conduct/inputs')
      .set(teacherAHeaders)
      .send({ student_id: studentId, grading_period_id: futureGradingPeriodId, note: 10 });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('CONDUCT_REVIEW_NOT_OPEN');
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
    expect(response.body.inputSummary).toEqual({
      expectedCount: 2,
      submittedCount: 2,
      isComplete: true,
    });
    expect(response.body.finalGrade).toBeNull();
  });

  it('montre les avis manquants et accepte la décision finale', async () => {
    const incompleteOverview = await request()
      .get(`/api/v1/conduct/students/${secondStudentId}/overview?grading_period_id=${gradingPeriodId}`)
      .set(educatorHeaders);
    expect(incompleteOverview.status, JSON.stringify(incompleteOverview.body)).toBe(200);
    expect(incompleteOverview.body.inputSummary).toEqual({
      expectedCount: 2,
      submittedCount: 1,
      isComplete: false,
    });
    expect(incompleteOverview.body.teacherInputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ teacherName: 'Prof A conduct', note: 16, isSubmitted: true }),
      expect.objectContaining({ teacherName: 'Prof B conduct', note: null, isSubmitted: false }),
    ]));

    const decision = await request()
      .put('/api/v1/conduct/grades')
      .set(educatorHeaders)
      .send({ student_id: secondStudentId, grading_period_id: gradingPeriodId, note: 15 });
    expect(decision.status, JSON.stringify(decision.body)).toBe(200);

    const remainingInput = await request()
      .post('/api/v1/conduct/inputs')
      .set(teacherBHeaders)
      .send({ student_id: secondStudentId, grading_period_id: gradingPeriodId, note: 13 });
    expect(remainingInput.status).toBe(409);
    expect(remainingInput.body.code).toBe('CONDUCT_INPUT_LOCKED');

    const completeOverview = await request()
      .get(`/api/v1/conduct/students/${secondStudentId}/overview?grading_period_id=${gradingPeriodId}`)
      .set(educatorHeaders);
    expect(completeOverview.body.inputSummary).toEqual({
      expectedCount: 2,
      submittedCount: 1,
      isComplete: false,
    });
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
      .send({ student_id: studentId, grading_period_id: gradingPeriodId, note: 16 });
    expect(updated.status).toBe(200);

    const afterUpdate = await request()
      .get(`/api/v1/conduct/students/${studentId}/overview?grading_period_id=${gradingPeriodId}`)
      .set(educatorHeaders);
    expect(afterUpdate.body.finalGrade).toMatchObject({ note: 16, coefficient: 1 });
    const audit = await queryTenant<{ old_note: string; new_note: string }>(
      `SELECT old_note::text, new_note::text FROM ${tenantTable('conduct_grade_audit')}
       WHERE conduct_grade_id = (SELECT id FROM ${tenantTable('conduct_grades')} WHERE student_id = $1::uuid AND grading_period_id = $2::uuid)
       ORDER BY changed_at`, [studentId, gradingPeriodId]);
    expect(audit.map(row => [row.old_note, row.new_note])).toEqual([[null, '17.00'], ['17.00', '16.00']]);
  });

  it('permet au professeur principal de consulter les avis et d’arrêter la conduite finale', async () => {
    await request().put(`/api/v1/conduct/policy/${schoolYearId}`).set(directorHeaders)
      .send({ mode: 'homeroom', coefficient: 1 });
    await queryTenant(
      `UPDATE ${tenantTable('classes')}
       SET homeroom_teacher_id = (SELECT id FROM ${tenantTable('teachers')} WHERE user_id = $2::uuid)
       WHERE id = $1::uuid`,
      [classId, teacherAUserId]
    );

    const overview = await request()
      .get(`/api/v1/conduct/students/${studentId}/overview?grading_period_id=${gradingPeriodId}`)
      .set(teacherAHeaders);
    expect(overview.status, JSON.stringify(overview.body)).toBe(200);
    expect(overview.body.teacherInputs).toHaveLength(2);

    const decided = await request()
      .put('/api/v1/conduct/grades')
      .set(teacherAHeaders)
      .send({ student_id: studentId, grading_period_id: gradingPeriodId, note: 19 });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);

    const afterDecision = await request()
      .get(`/api/v1/conduct/students/${studentId}/overview?grading_period_id=${gradingPeriodId}`)
      .set(teacherAHeaders);
    expect(afterDecision.body.finalGrade).toMatchObject({ note: 19, coefficient: 1, decidedByUserId: teacherAUserId });
  });

  it("refuse la décision d'un détenteur non assigné (directeur sans assignation)", async () => {
    const response = await request()
      .put('/api/v1/conduct/grades')
      .set(directorHeaders)
      .send({ student_id: studentId, grading_period_id: gradingPeriodId, note: 18 });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('NOT_CONDUCT_DECIDER');
  });

  it('autorise la direction sur toutes les classes de son école dans le mode direction', async () => {
    const policy = await request().put(`/api/v1/conduct/policy/${schoolYearId}`)
      .set(directorHeaders).send({ mode: 'direction', coefficient: 2 });
    expect(policy.status, JSON.stringify(policy.body)).toBe(200);
    const decision = await request().put('/api/v1/conduct/grades').set(directorHeaders)
      .send({ student_id: studentId, grading_period_id: gradingPeriodId, note: 18 });
    expect(decision.status, JSON.stringify(decision.body)).toBe(200);
    const grade = await queryTenant<{ coefficient: string }>(
      `SELECT coefficient::text FROM ${tenantTable('conduct_grades')} WHERE student_id = $1::uuid AND grading_period_id = $2::uuid`,
      [studentId, gradingPeriodId]);
    expect(grade[0]?.coefficient).toBe('2.000');
    const denied = await request().put('/api/v1/conduct/grades').set(educatorHeaders)
      .send({ student_id: studentId, grading_period_id: gradingPeriodId, note: 12 });
    expect(denied.status).toBe(403);
    const formerHomeroomScope = await request().get('/api/v1/conduct/decision-workspace').set(teacherAHeaders);
    expect(formerHomeroomScope.status).toBe(200);
    expect(formerHomeroomScope.body.decisionScopes).toEqual([]);
    const formerHomeroomDecision = await request().put('/api/v1/conduct/grades').set(teacherAHeaders)
      .send({ student_id: studentId, grading_period_id: gradingPeriodId, note: 12 });
    expect(formerHomeroomDecision.status).toBe(403);
    expect(formerHomeroomDecision.body.code).toBe('NOT_CONDUCT_DECIDER');
  });

  it('recalcule les moyennes et les rangs après changement du coefficient annuel', async () => {
    await queryTenant(`INSERT INTO ${tenantTable('student_period_averages')}
      (student_id, subject_id, grading_period_id, average)
      VALUES ($1::uuid, $3::uuid, $4::uuid, 12), ($2::uuid, $3::uuid, $4::uuid, 14)`,
    [studentId, secondStudentId, subjectId, gradingPeriodId]);
    for (const [id, note] of [[studentId, 18], [secondStudentId, 15]] as const) {
      const response = await request().put('/api/v1/conduct/grades').set(directorHeaders)
        .send({ student_id: id, grading_period_id: gradingPeriodId, note });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    }
    const policy = await request().put(`/api/v1/conduct/policy/${schoolYearId}`).set(directorHeaders)
      .send({ mode: 'direction', coefficient: 3 });
    expect(policy.status, JSON.stringify(policy.body)).toBe(200);
    const averages = await queryTenant<{ student_id: string; average: string; rank: number }>(`
      SELECT student_id::text, average::text, rank
      FROM ${tenantTable('student_period_averages')}
      WHERE grading_period_id = $1::uuid AND subject_id IS NULL AND student_id IN ($2::uuid, $3::uuid)
      ORDER BY rank`, [gradingPeriodId, studentId, secondStudentId]);
    expect(averages).toEqual([
      { student_id: studentId, average: '15.600', rank: 1 },
      { student_id: secondStudentId, average: '14.600', rank: 2 },
    ]);
    const changed = await queryTenant<{ coefficient: string }>(`
      SELECT DISTINCT coefficient::text FROM ${tenantTable('conduct_grades')}
      WHERE grading_period_id = $1::uuid`, [gradingPeriodId]);
    expect(changed).toEqual([{ coefficient: '3.000' }]);
  });

  it('sérialise deux décisions concurrentes sans avis enseignant', async () => {
    const concurrentStudentId = (await queryTenant<IdRow>(`INSERT INTO ${tenantTable('students')}
      (class_id, first_name, last_name, matricule)
      VALUES ($1::uuid, 'Sans', 'Avis', $2) RETURNING id::text`,
    [classId, `CON-CONCURRENT-${suffix}`]))[0]!.id;
    await queryTenant(`INSERT INTO ${tenantTable('enrollments')}
      (student_id, class_id, school_year_id, type, status)
      VALUES ($1::uuid, $2::uuid, $3::uuid, 'new_registration', 'confirmed')`,
    [concurrentStudentId, classId, schoolYearId]);
    const [first, second] = await Promise.all([11, 13].map(note =>
      request().put('/api/v1/conduct/grades').set(directorHeaders)
        .send({ student_id: concurrentStudentId, grading_period_id: gradingPeriodId, note })));
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    const grades = await queryTenant<{ id: string; note: string }>(`
      SELECT id::text, note::text FROM ${tenantTable('conduct_grades')}
      WHERE student_id = $1::uuid AND grading_period_id = $2::uuid`,
    [concurrentStudentId, gradingPeriodId]);
    expect(grades).toHaveLength(1);
    expect(['11.00', '13.00']).toContain(grades[0]!.note);
    const audit = await queryTenant<{ old_note: string | null; new_note: string }>(`
      SELECT old_note::text, new_note::text FROM ${tenantTable('conduct_grade_audit')}
      WHERE conduct_grade_id = $1::uuid ORDER BY changed_at, id`, [grades[0]!.id]);
    expect(audit).toHaveLength(2);
    expect(audit[0]!.old_note).toBeNull();
    expect(audit[1]!.old_note).toBe(audit[0]!.new_note);
    expect(audit[1]!.new_note).toBe(grades[0]!.note);
  });

  it('isole les données de conduite entre deux schémas école', async () => {
    const foreignSchema = `${TEST_SCHEMA_NAME}_foreign`;
    const { createTenantSchema } = await import('../../src/shared/database/tenant-init.js');
    await createTenantSchema(foreignSchema);
    try {
      const year = (await queryPublic<IdRow>(`
        INSERT INTO "${foreignSchema}".school_years
          (label, start_date, end_date, end_of_year_review_start_date, status)
        VALUES ($1, '2094-09-01', '2095-06-30', '2095-05-01', 'active') RETURNING id::text`,
      [`F-${suffix}`]))[0]!.id;
      const level = (await queryPublic<IdRow>(`
        INSERT INTO "${foreignSchema}".levels (name, order_index, is_exam_class)
        VALUES ($1, 99700, false) RETURNING id::text`, [`Foreign level ${suffix}`]))[0]!.id;
      const foreignClass = (await queryPublic<IdRow>(`
        INSERT INTO "${foreignSchema}".classes (name, level_id, school_year_id, is_active)
        VALUES ($1, $2::uuid, $3::uuid, true) RETURNING id::text`,
      [`Foreign class ${suffix}`, level, year]))[0]!.id;
      const foreignStudent = (await queryPublic<IdRow>(`
        INSERT INTO "${foreignSchema}".students (class_id, first_name, last_name, matricule)
        VALUES ($1::uuid, 'Autre', 'École', $2) RETURNING id::text`,
      [foreignClass, `FOREIGN-${suffix}`]))[0]!.id;
      const decision = await request().put('/api/v1/conduct/grades').set(directorHeaders)
        .send({ student_id: foreignStudent, grading_period_id: gradingPeriodId, note: 12 });
      expect(decision.status).toBe(404);
      expect(decision.body.code).toBe('STUDENT_NOT_FOUND');
      const overview = await request().get(`/api/v1/conduct/students/${foreignStudent}/overview`)
        .query({ grading_period_id: gradingPeriodId }).set(directorHeaders);
      expect(overview.status).toBe(404);
      expect(overview.body.code).toBe('STUDENT_NOT_FOUND');
    } finally {
      await queryPublic(`DROP SCHEMA "${foreignSchema}" CASCADE`);
    }
  });

  it('refuse la consultation à un staff sans conduct.finalize', async () => {
    const response = await request()
      .get(`/api/v1/conduct/students/${studentId}/overview?grading_period_id=${gradingPeriodId}`)
      .set(plainStaffHeaders);
    expect(response.status).toBe(403);
  });
});
