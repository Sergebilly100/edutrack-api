import { beforeAll, describe, expect, it } from 'vitest';
import { signAccessToken } from '../../src/modules/auth/auth.service.js';
import { getAuthHeaders, queryTenant, request, tenantTable, TEST_SCHEMA_NAME } from './setup.js';

type IdRow = { id: string };
const suffix = String(Date.now());

describe('actions de revue de conduite C28', () => {
  let directorHeaders: Record<string, string>;
  let teacherHeaders: Record<string, string>;
  let schoolYearId = '';
  let classId = '';
  let studentId = '';
  let teacherId = '';
  let levelId = '';
  let subjectId = '';
  let periodId = '';
  let futurePeriodId = '';

  beforeAll(async () => {
    directorHeaders = await getAuthHeaders('director');
    await queryTenant(`UPDATE ${tenantTable('school_years')} SET status = 'closed' WHERE status = 'active'`);
    const year = await queryTenant<IdRow>(`
      INSERT INTO ${tenantTable('school_years')}
        (label, start_date, end_date, end_of_year_review_start_date, status)
      VALUES ($1, CURRENT_DATE - 40, CURRENT_DATE + 100, CURRENT_DATE + 90, 'active')
      RETURNING id::text`, [`c28-${suffix}`]);
    schoolYearId = year[0]!.id;
    const periods = await queryTenant<IdRow>(`
      INSERT INTO ${tenantTable('grading_periods')}
        (school_year_id, type, order_index, label, start_date, review_start_date, end_date)
      VALUES ($1::uuid, 'trimester', 1, 'C28 T1', CURRENT_DATE - 30, CURRENT_DATE, CURRENT_DATE + 30)
      RETURNING id::text`, [schoolYearId]);
    periodId = periods[0]!.id;
    const future = await queryTenant<IdRow>(`
      INSERT INTO ${tenantTable('grading_periods')}
        (school_year_id, type, order_index, label, start_date, review_start_date, end_date)
      VALUES ($1::uuid, 'trimester', 2, 'C28 T2', CURRENT_DATE + 31, CURRENT_DATE + 50, CURRENT_DATE + 80)
      RETURNING id::text`, [schoolYearId]);
    futurePeriodId = future[0]!.id;
    const level = await queryTenant<IdRow>(`
      INSERT INTO ${tenantTable('levels')} (name, order_index, is_exam_class)
      VALUES ($1, 89999, false) RETURNING id::text`, [`C28 niveau ${suffix}`]);
    levelId = level[0]!.id;
    const user = await queryTenant<IdRow>(`
      INSERT INTO ${tenantTable('users')} (role, name, phone, password_hash, is_active)
      VALUES ('teacher', 'Prof C28', $1, 'not-used', true) RETURNING id::text`, [`22507${suffix.slice(-8)}`]);
    const teacher = await queryTenant<IdRow>(`
      INSERT INTO ${tenantTable('teachers')} (user_id, username, type, subjects, hourly_rate)
      VALUES ($1::uuid, $2, 'vacataire', '{SVT}', 4500) RETURNING id::text`, [user[0]!.id, `c28.${suffix}`]);
    teacherId = teacher[0]!.id;
    teacherHeaders = {
      authorization: `Bearer ${await signAccessToken({ sub: user[0]!.id, role: 'teacher', schemaName: TEST_SCHEMA_NAME })}`,
    };
    const classes = await queryTenant<IdRow>(`
      INSERT INTO ${tenantTable('classes')} (name, level_id, school_year_id, homeroom_teacher_id, is_active)
      VALUES ($1, $2::uuid, $3::uuid, $4::uuid, true) RETURNING id::text`,
    [`C28 classe ${suffix}`, level[0]!.id, schoolYearId, teacher[0]!.id]);
    classId = classes[0]!.id;
    const subject = await queryTenant<IdRow>(`
      INSERT INTO ${tenantTable('subjects')} (level_id, name, coefficient)
      VALUES ($1::uuid, 'SVT C28', 2) RETURNING id::text`, [level[0]!.id]);
    subjectId = subject[0]!.id;
    await queryTenant(`
      INSERT INTO ${tenantTable('teacher_subject_assignments')} (teacher_id, subject_id, class_id)
      VALUES ($1::uuid, $2::uuid, $3::uuid)`, [teacher[0]!.id, subject[0]!.id, classId]);
    const student = await queryTenant<IdRow>(`
      INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, matricule)
      VALUES ($1::uuid, 'Aya', 'C28', $2) RETURNING id::text`, [classId, `C28-${suffix}`]);
    studentId = student[0]!.id;
    await queryTenant(`
      INSERT INTO ${tenantTable('enrollments')} (student_id, class_id, school_year_id, type, status)
      VALUES ($1::uuid, $2::uuid, $3::uuid, 'new_registration', 'confirmed')`, [studentId, classId, schoolYearId]);
    const pending = await queryTenant<IdRow>(`
      INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, matricule)
      VALUES ($1::uuid, 'Dossier', 'En attente', $2) RETURNING id::text`, [classId, `C28-P-${suffix}`]);
    await queryTenant(`
      INSERT INTO ${tenantTable('enrollments')} (student_id, class_id, school_year_id, type, status)
      VALUES ($1::uuid, $2::uuid, $3::uuid, 'new_registration', 'pending_dossier')`, [pending[0]!.id, classId, schoolYearId]);
  });

  it('déduit une seule action pour la revue ouverte et ignore la période future et le dossier non confirmé', async () => {
    const first = await request().get('/api/v1/conduct/teacher-actions').set(teacherHeaders);
    const second = await request().get('/api/v1/conduct/teacher-actions').set(teacherHeaders);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.teacherActions).toEqual([expect.objectContaining({
      classId, gradingPeriodId: periodId, pendingCount: 1,
    })]);
    expect(first.body.teacherOpenScopes).toEqual([expect.objectContaining({
      classId, gradingPeriodId: periodId, pendingCount: 1,
    })]);
    expect(second.body.teacherActions).toEqual(first.body.teacherActions);
    expect(first.body.teacherActions.some((action: { gradingPeriodId: string }) => action.gradingPeriodId === futurePeriodId)).toBe(false);

    const secondClass = await queryTenant<IdRow>(`
      INSERT INTO ${tenantTable('classes')} (name, level_id, school_year_id, is_active)
      VALUES ($1, $2::uuid, $3::uuid, true) RETURNING id::text`, [`C28 autre classe ${suffix}`, levelId, schoolYearId]);
    const secondClassId = secondClass[0]!.id;
    await queryTenant(`
      INSERT INTO ${tenantTable('teacher_subject_assignments')} (teacher_id, subject_id, class_id)
      VALUES ($1::uuid, $2::uuid, $3::uuid)`, [teacherId, subjectId, secondClassId]);
    const secondStudent = await queryTenant<IdRow>(`
      INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, matricule)
      VALUES ($1::uuid, 'Deuxième', 'Classe', $2) RETURNING id::text`,
    [secondClassId, `C28-B-${suffix}`]);
    await queryTenant(`
      INSERT INTO ${tenantTable('enrollments')} (student_id, class_id, school_year_id, type, status)
      VALUES ($1::uuid, $2::uuid, $3::uuid, 'new_registration', 'confirmed')`,
    [secondStudent[0]!.id, secondClassId, schoolYearId]);
    const separated = await request().get('/api/v1/conduct/teacher-actions').set(teacherHeaders);
    expect(separated.body.teacherActions).toHaveLength(2);
    expect(separated.body.teacherActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ classId, gradingPeriodId: periodId, pendingCount: 1 }),
      expect.objectContaining({ classId: secondClassId, gradingPeriodId: periodId, pendingCount: 1 }),
    ]));
    await queryTenant(`
      INSERT INTO ${tenantTable('grading_period_class_closures')} (class_id, grading_period_id)
      VALUES ($1::uuid, $2::uuid)`, [secondClassId, periodId]);
    const closed = await request().get('/api/v1/conduct/teacher-actions').set(teacherHeaders);
    expect(closed.body.teacherActions).toEqual(first.body.teacherActions);
    await queryTenant(`
      DELETE FROM ${tenantTable('grading_period_class_closures')}
      WHERE class_id = $1::uuid AND grading_period_id = $2::uuid`, [secondClassId, periodId]);
    await queryTenant(`
      INSERT INTO ${tenantTable('report_cards')}
        (student_id, class_id, grading_period_id, general_average, rank,
         class_average, class_min_average, class_max_average, class_headcount, status)
      VALUES ($1::uuid, $2::uuid, $3::uuid, 12, 1, 12, 12, 12, 1, 'generated')`,
    [secondStudent[0]!.id, secondClassId, periodId]);
    const generated = await request().get('/api/v1/conduct/teacher-actions').set(teacherHeaders);
    expect(generated.body.teacherActions).toEqual(first.body.teacherActions);
  });

  it('reflète exactement le mode Direction et retire les actions après avis et décision', async () => {
    const before = await request().get('/api/v1/conduct/decision-workspace').set(directorHeaders);
    expect(before.body.decisionScopes).toEqual([]);
    const configured = await request().put(`/api/v1/conduct/policy/${schoolYearId}`).set(directorHeaders)
      .send({ mode: 'direction', coefficient: 1 });
    expect(configured.status, JSON.stringify(configured.body)).toBe(200);
    const opened = await request().get('/api/v1/conduct/decision-workspace').set(directorHeaders);
    expect(opened.body.decisionActions).toEqual(expect.arrayContaining([expect.objectContaining({
      classId, gradingPeriodId: periodId, pendingCount: 1, studentCount: 1, schoolYearStatus: 'active',
    })]));
    expect(opened.body.decisionActions.filter((action: { classId: string; gradingPeriodId: string }) =>
      action.classId === classId && action.gradingPeriodId === periodId)).toHaveLength(1);
    const teacherAfterPolicy = await request().get('/api/v1/conduct/decision-workspace').set(teacherHeaders);
    expect(teacherAfterPolicy.body.decisionScopes).toEqual([]);
    const roster = await request().get('/api/v1/conduct/decision-students').set(directorHeaders)
      .query({ class_id: classId, grading_period_id: periodId });
    expect(roster.body.students).toEqual([expect.objectContaining({ id: studentId })]);

    const opinion = await request().post('/api/v1/conduct/inputs').set(teacherHeaders)
      .send({ student_id: studentId, grading_period_id: periodId, note: 15 });
    expect(opinion.status, JSON.stringify(opinion.body)).toBe(201);
    const teacherResolved = await request().get('/api/v1/conduct/teacher-actions').set(teacherHeaders);
    expect(teacherResolved.body.teacherActions).toEqual([]);
    expect(teacherResolved.body.teacherOpenScopes).toEqual([expect.objectContaining({
      classId, gradingPeriodId: periodId, pendingCount: 0,
    })]);
    const decision = await request().put('/api/v1/conduct/grades').set(directorHeaders)
      .send({ student_id: studentId, grading_period_id: periodId, note: 16 });
    expect(decision.status, JSON.stringify(decision.body)).toBe(200);
    const decisionResolved = await request().get('/api/v1/conduct/decision-workspace').set(directorHeaders);
    expect(decisionResolved.body.decisionActions).toEqual([]);
  });

  it('garde exactement l’union des affectations et créneaux actifs, sans doublon', async () => {
    const user = await queryTenant<IdRow>(`
      INSERT INTO ${tenantTable('users')} (role, name, phone, password_hash, is_active)
      VALUES ('teacher', 'Scope C29', $1, 'not-used', true) RETURNING id::text`, [`22506${suffix.slice(-8)}`]);
    const teacher = await queryTenant<IdRow>(`
      INSERT INTO ${tenantTable('teachers')} (user_id, username, type, subjects, hourly_rate)
      VALUES ($1::uuid, $2, 'vacataire', '{SVT}', 4500) RETURNING id::text`, [user[0]!.id, `c29.${suffix}`]);
    const headers = { authorization: `Bearer ${await signAccessToken({ sub: user[0]!.id, role: 'teacher', schemaName: TEST_SCHEMA_NAME })}` };
    const unrelated = await queryTenant<IdRow>(`
      INSERT INTO ${tenantTable('users')} (role, name, phone, password_hash, is_active)
      VALUES ('teacher', 'Scope Empty C29', $1, 'not-used', true) RETURNING id::text`, [`22505${suffix.slice(-8)}`]);
    await queryTenant(`INSERT INTO ${tenantTable('teachers')} (user_id, username, type, subjects, hourly_rate)
      VALUES ($1::uuid, $2, 'vacataire', '{SVT}', 4500)`, [unrelated[0]!.id, `c29.empty.${suffix}`]);
    const unrelatedHeaders = { authorization: `Bearer ${await signAccessToken({ sub: unrelated[0]!.id, role: 'teacher', schemaName: TEST_SCHEMA_NAME })}` };

    const createClass = async (label: string): Promise<string> => {
      const result = await queryTenant<IdRow>(`
        INSERT INTO ${tenantTable('classes')} (name, level_id, school_year_id, is_active)
        VALUES ($1, $2::uuid, $3::uuid, true) RETURNING id::text`, [`C29 ${label} ${suffix}`, levelId, schoolYearId]);
      const id = result[0]!.id;
      const student = await queryTenant<IdRow>(`
        INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, matricule)
        VALUES ($1::uuid, 'Scope', 'C29', $2) RETURNING id::text`, [id, `C29-${label}-${suffix}`]);
      await queryTenant(`INSERT INTO ${tenantTable('enrollments')}
        (student_id, class_id, school_year_id, type, status)
        VALUES ($1::uuid, $2::uuid, $3::uuid, 'new_registration', 'confirmed')`,
      [student[0]!.id, id, schoolYearId]);
      return id;
    };
    const assignmentClass = await createClass('one');
    const secondClass = await createClass('two');
    const scheduleClass = await createClass('schedule');
    const classes = async () => {
      const context = await request().get('/api/v1/academic/teacher-context').set(headers);
      const actions = await request().get('/api/v1/conduct/teacher-actions').set(headers);
      expect(context.status, JSON.stringify(context.body)).toBe(200);
      expect(actions.status, JSON.stringify(actions.body)).toBe(200);
      const contextIds = context.body.classes.map((item: { id: string }) => item.id).sort();
      const actionIds = actions.body.teacherActions.map((item: { classId: string }) => item.classId).sort();
      expect(actionIds).toEqual(contextIds);
      return contextIds;
    };

    const empty = await request().get('/api/v1/academic/teacher-context').set(unrelatedHeaders);
    const emptyActions = await request().get('/api/v1/conduct/teacher-actions').set(unrelatedHeaders);
    expect(empty.body.classes).toEqual([]);
    expect(emptyActions.body.teacherActions).toEqual([]);

    await queryTenant(`INSERT INTO ${tenantTable('teacher_subject_assignments')} (teacher_id, subject_id, class_id)
      VALUES ($1::uuid, $2::uuid, $3::uuid)`, [teacher[0]!.id, subjectId, assignmentClass]);
    expect(await classes()).toEqual([assignmentClass]);

    const secondSubject = await queryTenant<IdRow>(`INSERT INTO ${tenantTable('subjects')}
      (level_id, name, coefficient) VALUES ($1::uuid, $2, 1) RETURNING id::text`, [levelId, `C29 sujet ${suffix}`]);
    await queryTenant(`INSERT INTO ${tenantTable('teacher_subject_assignments')} (teacher_id, subject_id, class_id)
      VALUES ($1::uuid, $2::uuid, $3::uuid)`, [teacher[0]!.id, secondSubject[0]!.id, assignmentClass]);
    expect(await classes()).toEqual([assignmentClass]);

    await queryTenant(`INSERT INTO ${tenantTable('teacher_subject_assignments')} (teacher_id, subject_id, class_id)
      VALUES ($1::uuid, $2::uuid, $3::uuid)`, [teacher[0]!.id, subjectId, secondClass]);
    expect(await classes()).toEqual([assignmentClass, secondClass].sort());

    await queryTenant(`INSERT INTO ${tenantTable('schedules')}
      (schedule_period_id, teacher_id, class_id, room_id, time_slot_id, day_of_week, subject, is_active)
      SELECT schedule_period_id, $1::uuid, $2::uuid, room_id, time_slot_id, day_of_week, subject, true
      FROM ${tenantTable('schedules')} WHERE id = $3::uuid`, [teacher[0]!.id, scheduleClass, (await queryTenant<IdRow>(
      `SELECT id::text FROM ${tenantTable('schedules')} LIMIT 1`))[0]!.id]);
    expect(await classes()).toEqual([assignmentClass, secondClass, scheduleClass].sort());
  });

  it('ferme les avis et décisions avant la revue et dès le lendemain de la fin', async () => {
    const businessToday = `(now() AT TIME ZONE 'Africa/Abidjan')::date`;
    const moveWindow = async (review: string, end: string) => {
      await queryTenant(`UPDATE ${tenantTable('grading_periods')}
        SET review_start_date = ${review}, end_date = ${end}
        WHERE id = $1::uuid`, [periodId]);
    };
    const opinion = () => request().post('/api/v1/conduct/inputs').set(teacherHeaders)
      .send({ student_id: studentId, grading_period_id: periodId, note: 12 });
    const bulk = () => request().post('/api/v1/conduct/inputs/bulk').set(teacherHeaders)
      .send({ class_id: classId, student_ids: [studentId], grading_period_id: periodId, note: 12 });
    const decision = () => request().put('/api/v1/conduct/grades').set(directorHeaders)
      .send({ student_id: studentId, grading_period_id: periodId, note: 12 });

    await moveWindow(`${businessToday} + 1`, `${businessToday} + 2`);
    const before = await request().get('/api/v1/conduct/teacher-actions').set(teacherHeaders);
    expect(before.body.teacherOpenScopes).toEqual([]);
    expect(before.body.teacherActions).toEqual([]);
    for (const response of [await opinion(), await bulk(), await decision()]) {
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('CONDUCT_REVIEW_NOT_OPEN');
    }

    await moveWindow(`${businessToday} - 1`, businessToday);
    const onLastDay = await request().get('/api/v1/conduct/teacher-actions').set(teacherHeaders);
    expect(onLastDay.body.teacherOpenScopes).toEqual([expect.objectContaining({ classId, gradingPeriodId: periodId })]);
    const lastDayDecision = await decision();
    expect(lastDayDecision.status, JSON.stringify(lastDayDecision.body)).toBe(200);

    await moveWindow(`${businessToday} - 1`, `${businessToday} - 1`);
    const after = await request().get('/api/v1/conduct/teacher-actions').set(teacherHeaders);
    expect(after.body.teacherOpenScopes).toEqual([]);
    expect(after.body.teacherActions).toEqual([]);
    const workspace = await request().get('/api/v1/conduct/decision-workspace').set(directorHeaders);
    expect(workspace.body.decisionActions).toEqual([]);
    expect(workspace.body.decisionScopes.find((scope: { classId: string; gradingPeriodId: string }) =>
      scope.classId === classId && scope.gradingPeriodId === periodId)?.reviewOpen).toBe(false);
    const beforeInput = await queryTenant<{ note: string }>(`SELECT note::text FROM ${tenantTable('teacher_conduct_inputs')}
      WHERE student_id = $1::uuid AND grading_period_id = $2::uuid`, [studentId, periodId]);
    const beforeGrade = await queryTenant<{ note: string }>(`SELECT note::text FROM ${tenantTable('conduct_grades')}
      WHERE student_id = $1::uuid AND grading_period_id = $2::uuid`, [studentId, periodId]);
    for (const response of [await opinion(), await bulk(), await decision()]) {
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('CONDUCT_REVIEW_CLOSED');
    }
    expect(await queryTenant<{ note: string }>(`SELECT note::text FROM ${tenantTable('teacher_conduct_inputs')}
      WHERE student_id = $1::uuid AND grading_period_id = $2::uuid`, [studentId, periodId])).toEqual(beforeInput);
    expect(await queryTenant<{ note: string }>(`SELECT note::text FROM ${tenantTable('conduct_grades')}
      WHERE student_id = $1::uuid AND grading_period_id = $2::uuid`, [studentId, periodId])).toEqual(beforeGrade);
  });
});
