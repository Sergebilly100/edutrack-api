import { describe, expect, it, vi } from 'vitest';

import {
  getAuthHeaders,
  getSeedContext,
  queryTenant,
  request,
} from './setup.js';

describe('academic grading integration', () => {
  it('saisit plusieurs évaluations puis recalcule les moyennes matière et générale', async () => {
    const context = getSeedContext();
    const suffix = Date.now().toString(36);
    const shiftDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
    const today = shiftDays(0);
    const yearStart = shiftDays(-60);
    const yearEnd = shiftDays(300);
    const firstReview = shiftDays(1);
    const firstEnd = shiftDays(90);
    const secondReview = shiftDays(180);
    const evaluationDates = [shiftDays(-35), shiftDays(-20), shiftDays(-10)];
    const directorHeaders = await getAuthHeaders('director');
    const teacherHeaders = await getAuthHeaders('teacher');

    const years = await queryTenant<{ id: string }>(`
      INSERT INTO school_years (label, start_date, end_date, end_of_year_review_start_date, status)
      VALUES ($1, $2::date, $3::date, $4::date, 'active')
      RETURNING id
    `, [`review-${suffix}`, yearStart, yearEnd, shiftDays(270)]);
    const levels = await queryTenant<{ id: string }>(`
      INSERT INTO levels (name, order_index, is_exam_class)
      VALUES ($1, 880, false)
      RETURNING id
    `, [`Niveau notes ${suffix}`]);
    const classes = await queryTenant<{ id: string }>(`
      UPDATE classes SET level_id = $1, school_year_id = $2 WHERE name = $3 RETURNING id
    `, [levels[0]!.id, years[0]!.id, context.className]);
    const classId = classes[0]!.id;

    const students = await queryTenant<{ id: string }>(`
      INSERT INTO students (class_id, matricule, first_name, last_name, is_active)
      VALUES ($1, $2, 'Awa', 'Kouassi', true)
      RETURNING id
    `, [classId, `NOTE-${suffix}`]);
    const studentId = students[0]!.id;
    await queryTenant(`INSERT INTO enrollments (student_id, class_id, school_year_id, type, status)
      VALUES ($1, $2, $3, 'new_registration', 'confirmed')`, [studentId, classId, years[0]!.id]);
    const pendingStudentId = (await queryTenant<{ id: string }>(`INSERT INTO students
      (class_id,matricule,first_name,last_name,is_active)
      VALUES ($1,$2,'Non confirmé','Notes',true) RETURNING id`, [classId, `NOTE-PENDING-${suffix}`]))[0]!.id;
    await queryTenant(`INSERT INTO enrollments (student_id,class_id,school_year_id,type,status)
      VALUES ($1,$2,$3,'new_registration','pending_dossier')`, [pendingStudentId, classId, years[0]!.id]);

    const mathResponse = await request().post('/api/v1/subjects').set(directorHeaders).send({
      levelId: levels[0]!.id,
      name: 'Mathématiques',
      coefficient: 4,
    });
    expect(mathResponse.status).toBe(201);
    const frenchResponse = await request().post('/api/v1/subjects').set(directorHeaders).send({
      levelId: levels[0]!.id,
      name: 'Français',
      coefficient: 2,
    });
    expect(frenchResponse.status).toBe(201);

    const periodResponse = await request().post('/api/v1/grading-periods').set(directorHeaders).send({
      schoolYearId: years[0]!.id,
      type: 'trimester',
      orderIndex: 1,
      label: 'Premier trimestre',
      startDate: yearStart,
      reviewStartDate: firstReview,
      endDate: firstEnd,
    });
    expect(periodResponse.status).toBe(201);
    const gradingPeriodId = periodResponse.body.gradingPeriod.id as string;
    const nextPeriodResponse = await request().post('/api/v1/grading-periods').set(directorHeaders).send({
      schoolYearId: years[0]!.id,
      type: 'trimester',
      orderIndex: 2,
      label: 'Deuxième trimestre',
      startDate: today,
      reviewStartDate: secondReview,
      endDate: yearEnd,
    });
    expect(nextPeriodResponse.status).toBe(201);
    const nextGradingPeriodId = nextPeriodResponse.body.gradingPeriod.id as string;

    const seededSchedule = await queryTenant<{
      schedule_period_id: string; room_id: string; time_slot_id: string; day_of_week: number; start_time: string;
    }>(`
      SELECT s.schedule_period_id, s.room_id, s.time_slot_id, s.day_of_week, ts.start_time::text
      FROM schedules s
      INNER JOIN time_slots ts ON ts.id = s.time_slot_id
      WHERE s.id = $1
    `, [context.scheduleId]);
    const alternateSlot = await queryTenant<{ id: string }>(`
      SELECT id FROM time_slots WHERE id <> $1 ORDER BY sort_order LIMIT 1
    `, [seededSchedule[0]!.time_slot_id]);
    const frenchSchedules = await queryTenant<{ id: string }>(`
      INSERT INTO schedules (schedule_period_id, teacher_id, class_id, room_id, time_slot_id, day_of_week, subject, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, 'Français', true)
      RETURNING id
    `, [
      seededSchedule[0]!.schedule_period_id,
      context.teacherId,
      classId,
      seededSchedule[0]!.room_id,
      alternateSlot[0]!.id,
      seededSchedule[0]!.day_of_week,
    ]);

    const teacherContext = await request()
      .get('/api/v1/academic/teacher-context')
      .set(teacherHeaders);
    expect(teacherContext.status, JSON.stringify(teacherContext.body)).toBe(200);
    expect(teacherContext.body.classes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: classId, name: context.className }),
    ]));
    expect(teacherContext.body.gradingPeriods).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: gradingPeriodId, label: 'Premier trimestre' }),
    ]));

    const teacherScope = await request()
      .get('/api/v1/evaluations/scope')
      .set(teacherHeaders)
      .query({ classId, gradingPeriodId });
    expect(teacherScope.status, JSON.stringify(teacherScope.body)).toBe(200);
    expect(teacherScope.body.subjects).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: mathResponse.body.subject.id }),
      expect.objectContaining({ id: frenchResponse.body.subject.id }),
    ]));
    expect(teacherScope.body.completion).toEqual(expect.arrayContaining([
      expect.objectContaining({ subjectId: mathResponse.body.subject.id, calculationStarted: false }),
    ]));

    // Une classe portée uniquement par l'EDT doit ouvrir les deux lectures utilisées par Notes.
    const scheduleOnlyClass = await queryTenant<{ id: string }>(`
      INSERT INTO classes (name, level_id, school_year_id, is_active)
      VALUES ($1, $2, $3, true) RETURNING id
    `, [`Classe EDT ${suffix}`, levels[0]!.id, years[0]!.id]);
    const scheduleOnlyClassId = scheduleOnlyClass[0]!.id;
    const freeDay = await queryTenant<{ day_of_week: number }>(`
      SELECT days.day_of_week FROM generate_series(1, 6) AS days(day_of_week)
      WHERE NOT EXISTS (SELECT 1 FROM schedules sch
        WHERE sch.schedule_period_id = $1 AND sch.teacher_id = $2 AND sch.time_slot_id = $3
          AND sch.day_of_week = days.day_of_week AND sch.is_active = true AND sch.end_date IS NULL)
      ORDER BY days.day_of_week LIMIT 1
    `, [seededSchedule[0]!.schedule_period_id, context.teacherId, seededSchedule[0]!.time_slot_id]);
    await queryTenant(`
      INSERT INTO schedules (schedule_period_id, teacher_id, class_id, room_id, time_slot_id, day_of_week, subject, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, 'Mathématiques', true)
    `, [seededSchedule[0]!.schedule_period_id, context.teacherId, scheduleOnlyClassId,
      seededSchedule[0]!.room_id, seededSchedule[0]!.time_slot_id, freeDay[0]!.day_of_week]);
    const scheduleOnlyStudent = await queryTenant<{ id: string }>(`
      INSERT INTO students (class_id, matricule, first_name, last_name, is_active)
      VALUES ($1, $2, 'Élève', 'EDT', true) RETURNING id
    `, [scheduleOnlyClassId, `NOTE-EDT-${suffix}`]);
    await queryTenant(`INSERT INTO enrollments (student_id, class_id, school_year_id, type, status)
      VALUES ($1, $2, $3, 'new_registration', 'confirmed')`, [scheduleOnlyStudent[0]!.id, scheduleOnlyClassId, years[0]!.id]);
    const scheduleOnlyContext = await request().get('/api/v1/academic/teacher-context').set(teacherHeaders);
    expect(scheduleOnlyContext.body.classes).toEqual(expect.arrayContaining([expect.objectContaining({ id: scheduleOnlyClassId })]));
    const scheduleOnlyStudents = await request().get('/api/v1/students').set(teacherHeaders)
      .query({ class_id: scheduleOnlyClassId, is_active: true, page: 1, limit: 100 });
    expect(scheduleOnlyStudents.status, JSON.stringify(scheduleOnlyStudents.body)).toBe(200);
    expect(scheduleOnlyStudents.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: scheduleOnlyStudent[0]!.id })]));
    const scheduleOnlyScope = await request().get('/api/v1/evaluations/scope').set(teacherHeaders)
      .query({ classId: scheduleOnlyClassId, gradingPeriodId });
    expect(scheduleOnlyScope.status, JSON.stringify(scheduleOnlyScope.body)).toBe(200);
    expect(scheduleOnlyScope.body.subjects).toEqual(expect.arrayContaining([expect.objectContaining({ id: mathResponse.body.subject.id })]));
    await queryTenant(`UPDATE schedules SET is_active = false WHERE class_id = $1 AND teacher_id = $2`,
      [scheduleOnlyClassId, context.teacherId]);
    const inactiveScheduleContext = await request().get('/api/v1/academic/teacher-context').set(teacherHeaders);
    expect(inactiveScheduleContext.body.classes.some((item: { id: string }) => item.id === scheduleOnlyClassId)).toBe(false);
    expect((await request().get('/api/v1/students').set(teacherHeaders)
      .query({ class_id: scheduleOnlyClassId, is_active: true, page: 1, limit: 100 })).status).toBe(403);
    expect((await request().get('/api/v1/evaluations/scope').set(teacherHeaders)
      .query({ classId: scheduleOnlyClassId, gradingPeriodId })).status).toBe(403);

    const unrelatedClass = await queryTenant<{ id: string }>(`
      INSERT INTO classes (name, level_id, school_year_id, is_active)
      VALUES ($1, $2, $3, true) RETURNING id
    `, [`Classe hors portée ${suffix}`, levels[0]!.id, years[0]!.id]);
    const unrelatedClassId = unrelatedClass[0]!.id;
    expect((await request().get('/api/v1/students').set(teacherHeaders)
      .query({ class_id: unrelatedClassId, is_active: true, page: 1, limit: 100 })).status).toBe(403);
    expect((await request().get('/api/v1/evaluations/scope').set(teacherHeaders)
      .query({ classId: unrelatedClassId, gradingPeriodId })).status).toBe(403);

    const noEvaluationCalculation = await request().put('/api/v1/class-subject-completion').set(teacherHeaders).send({
      classId,
      subjectId: mathResponse.body.subject.id,
      gradingPeriodId,
      status: 'in_progress',
    });
    expect(noEvaluationCalculation.status).toBe(409);
    expect(noEvaluationCalculation.body.code).toBe('EVALUATIONS_REQUIRED');

    const createEvaluation = async (lessonSlotId: string, subjectId: string, label: string, coefficient: number, evaluationDate: string) => {
      const response = await request().post('/api/v1/evaluations').set(teacherHeaders).send({
        lessonSlotId,
        subjectId,
        classId,
        gradingPeriodId,
        type: 'scheduled',
        coefficient,
        label,
        evaluationDate,
      });
      expect(response.status).toBe(201);
      expect(response.body.evaluation).toMatchObject({ evaluationDate });
      return response.body.evaluation.id as string;
    };

    const math1 = await createEvaluation(context.scheduleId, mathResponse.body.subject.id, 'Devoir 1', 1, evaluationDates[0]!);
    const refusedGrade = await request().put(`/api/v1/evaluations/${math1}/grades`).set(teacherHeaders)
      .send({ studentId: pendingStudentId, score: 10, maxScore: 20 });
    expect(refusedGrade.status).toBe(400);
    expect(refusedGrade.body.code).toBe('STUDENT_CLASS_MISMATCH');
    const math2 = await createEvaluation(context.scheduleId, mathResponse.body.subject.id, 'Devoir 2', 3, evaluationDates[1]!);
    const french = await createEvaluation(frenchSchedules[0]!.id, frenchResponse.body.subject.id, 'Dictée', 1, evaluationDates[2]!);

    const incompleteCalculation = await request().put('/api/v1/class-subject-completion').set(teacherHeaders).send({
      classId,
      subjectId: mathResponse.body.subject.id,
      gradingPeriodId,
      status: 'in_progress',
    });
    expect(incompleteCalculation.status).toBe(409);
    expect(incompleteCalculation.body.code).toBe('GRADES_INCOMPLETE');

    const scopeWithDates = await request().get('/api/v1/evaluations/scope').set(teacherHeaders).query({ classId, gradingPeriodId });
    expect(scopeWithDates.status).toBe(200);
    expect(scopeWithDates.body.evaluations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: math1, evaluationDate: evaluationDates[0] }),
      expect.objectContaining({ id: math2, evaluationDate: evaluationDates[1] }),
      expect.objectContaining({ id: french, evaluationDate: evaluationDates[2] }),
    ]));

    const saveGrade = (evaluationId: string, score: number) =>
      request().put(`/api/v1/evaluations/${evaluationId}/grades`).set(teacherHeaders).send({
        studentId,
        score,
        maxScore: 20,
      });

    expect((await saveGrade(math1, 10)).status).toBe(200);
    expect((await saveGrade(math2, 18)).status).toBe(200);
    const finalGrade = await saveGrade(french, 12);
    expect(finalGrade.status).toBe(200);
    expect(finalGrade.body.averages.subjects).toEqual(expect.arrayContaining([
      expect.objectContaining({ subjectId: mathResponse.body.subject.id, average: 16 }),
      expect.objectContaining({ subjectId: frenchResponse.body.subject.id, average: 12 }),
    ]));
    expect(finalGrade.body.averages.generalAverage).toBe(14.667);

    const cached = await queryTenant<{ subject_id: string | null; average: string }>(`
      SELECT subject_id, average FROM student_period_averages
      WHERE student_id = $1 AND grading_period_id = $2 ORDER BY subject_id NULLS LAST
    `, [studentId, gradingPeriodId]);
    expect(cached.map((row) => [row.subject_id, Number(row.average)])).toEqual(expect.arrayContaining([
      [mathResponse.body.subject.id, 16],
      [frenchResponse.body.subject.id, 12],
      [null, 14.667],
    ]));

    const tracking = await request().get('/api/v1/report-cards/completion').set(directorHeaders).query({
      classId,
      gradingPeriodId,
    });
    expect(tracking.status).toBe(200);
    expect(tracking.body.subjects).toEqual(expect.arrayContaining([
      expect.objectContaining({ subjectId: mathResponse.body.subject.id, status: 'in_progress' }),
      expect.objectContaining({ subjectId: frenchResponse.body.subject.id, status: 'in_progress' }),
    ]));

    vi.useFakeTimers();
    const spontaneousDate = new Date(`${shiftDays(-25)}T00:00:00.000Z`);
    spontaneousDate.setUTCDate(
      spontaneousDate.getUTCDate() + ((seededSchedule[0]!.day_of_week - spontaneousDate.getUTCDay() + 7) % 7)
    );
    const spontaneousDateIso = spontaneousDate.toISOString().slice(0, 10);
    vi.setSystemTime(new Date(`${spontaneousDateIso}T${seededSchedule[0]!.start_time.slice(0, 5)}:00.000Z`));
    const spontaneousTeacherHeaders = await getAuthHeaders('teacher');
    const spontaneous = await request()
      .post('/api/v1/evaluations/spontaneous')
      .set(spontaneousTeacherHeaders)
      .send({
        lessonSlotId: context.scheduleId,
        subjectId: mathResponse.body.subject.id,
        classId,
        gradingPeriodId,
        evaluationDate: spontaneousDateIso,
        studentId,
        adjustment: -2,
        comment: 'Interrompt régulièrement le cours',
      });
    expect(spontaneous.status, JSON.stringify(spontaneous.body)).toBe(201);
    expect(spontaneous.body.grade).toMatchObject({ score: -2, maxScore: 20 });
    expect(spontaneous.body.averages.subjects).toEqual(expect.arrayContaining([
      expect.objectContaining({ subjectId: mathResponse.body.subject.id, average: 14 }),
    ]));

    const missingJustification = await request()
      .post('/api/v1/evaluations/spontaneous')
      .set(spontaneousTeacherHeaders)
      .send({
        lessonSlotId: context.scheduleId,
        subjectId: mathResponse.body.subject.id,
        classId,
        gradingPeriodId,
        evaluationDate: spontaneousDateIso,
        studentId,
        adjustment: 2,
        comment: '',
      });
    expect(missingJustification.status).toBe(400);
    vi.useRealTimers();

    const calculationStarted = await request().put('/api/v1/class-subject-completion').set(teacherHeaders).send({
      classId,
      subjectId: mathResponse.body.subject.id,
      gradingPeriodId,
      status: 'in_progress',
    });
    expect(calculationStarted.status, JSON.stringify(calculationStarted.body)).toBe(200);
    expect(calculationStarted.body.completion.status).toBe('in_progress');

    const inProgressSubjectEdit = await saveGrade(math1, 14);
    expect(inProgressSubjectEdit.status).toBe(409);
    expect(inProgressSubjectEdit.body.code).toBe('SUBJECT_CALCULATION_STARTED');

    const routedEvaluation = await request().post('/api/v1/evaluations').set(teacherHeaders).send({
      lessonSlotId: context.scheduleId,
      subjectId: mathResponse.body.subject.id,
      classId,
      gradingPeriodId,
      type: 'scheduled',
      coefficient: 1,
      label: 'Devoir 3',
      evaluationDate: shiftDays(100),
    });
    expect(routedEvaluation.status).toBe(400);
    expect(routedEvaluation.body.code).toBe('EVALUATION_DATE_OUTSIDE_PERIOD');

    const completion = await request().put('/api/v1/class-subject-completion').set(teacherHeaders).send({
      classId,
      subjectId: mathResponse.body.subject.id,
      gradingPeriodId,
      status: 'completed',
    });
    expect(completion.status).toBe(200);
    expect(completion.body.completion.status).toBe('completed');

    const validatedSubjectEdit = await saveGrade(math1, 14);
    expect(validatedSubjectEdit.status).toBe(409);
    expect(validatedSubjectEdit.body.code).toBe('SUBJECT_AVERAGES_VALIDATED');

    const beginReview = await request().patch(`/api/v1/grading-periods/${gradingPeriodId}`)
      .set(directorHeaders).send({ reviewStartDate: today });
    expect(beginReview.status, JSON.stringify(beginReview.body)).toBe(200);
    const simultaneous = await request().get('/api/v1/grading-periods').set(directorHeaders);
    expect(simultaneous.body.gradingPeriods).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: gradingPeriodId, notesEntryOpen: false, conductReviewOpen: true }),
      expect.objectContaining({ id: nextGradingPeriodId, notesEntryOpen: true }),
    ]));
    const closedT1Grade = await saveGrade(french, 13);
    expect(closedT1Grade.status).toBe(409);
    expect(closedT1Grade.body.code).toBe('GRADING_PERIOD_NOTES_CLOSED');
    const t2Evaluation = await request().post('/api/v1/evaluations').set(teacherHeaders).send({
      lessonSlotId: context.scheduleId, subjectId: mathResponse.body.subject.id,
      classId, gradingPeriodId: nextGradingPeriodId, type: 'scheduled',
      coefficient: 1, label: 'Devoir T2', evaluationDate: shiftDays(10),
    });
    expect(t2Evaluation.status, JSON.stringify(t2Evaluation.body)).toBe(201);
    expect(t2Evaluation.body.routedToPeriod).toBeNull();
    expect((await saveGrade(t2Evaluation.body.evaluation.id as string, 14)).status).toBe(200);

    await queryTenant(`
      UPDATE schedules
      SET end_date = '2000-01-01'
      WHERE teacher_id = $1 AND class_id = $2
    `, [context.teacherId, classId]);
    const contextWithoutActiveSchedules = await request()
      .get('/api/v1/academic/teacher-context')
      .set(teacherHeaders);
    expect(contextWithoutActiveSchedules.status).toBe(200);
    expect(contextWithoutActiveSchedules.body.classes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: classId }),
    ]));
    expect(contextWithoutActiveSchedules.body.gradingPeriods).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: gradingPeriodId }),
    ]));

    const studentsWithoutActiveSchedules = await request()
      .get('/api/v1/students')
      .set(teacherHeaders)
      .query({ class_id: classId, is_active: true, page: 1, limit: 100 });
    expect(studentsWithoutActiveSchedules.status, JSON.stringify(studentsWithoutActiveSchedules.body)).toBe(200);
    expect(studentsWithoutActiveSchedules.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: studentId }),
    ]));

    const scopeWithoutActiveSchedules = await request()
      .get('/api/v1/evaluations/scope')
      .set(teacherHeaders)
      .query({ classId, gradingPeriodId });
    expect(scopeWithoutActiveSchedules.status, JSON.stringify(scopeWithoutActiveSchedules.body)).toBe(200);
    expect(scopeWithoutActiveSchedules.body.lessonSlots).toEqual([]);
    expect(scopeWithoutActiveSchedules.body.subjects).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: frenchResponse.body.subject.id }),
    ]));

    const evaluationWithoutSchedule = await request()
      .post('/api/v1/evaluations')
      .set(teacherHeaders)
      .send({
        subjectId: frenchResponse.body.subject.id,
        classId,
        gradingPeriodId: nextGradingPeriodId,
        type: 'scheduled',
        coefficient: 1,
        label: 'Devoir sans EDT',
        evaluationDate: shiftDays(12),
      });
    expect(evaluationWithoutSchedule.status, JSON.stringify(evaluationWithoutSchedule.body)).toBe(201);
    expect(evaluationWithoutSchedule.body.evaluation.lessonSlotId).toBeNull();

    const gradeWithoutSchedule = await request()
      .put(`/api/v1/evaluations/${evaluationWithoutSchedule.body.evaluation.id}/grades`)
      .set(teacherHeaders)
      .send({ studentId, score: 15, maxScore: 20 });
    expect(gradeWithoutSchedule.status, JSON.stringify(gradeWithoutSchedule.body)).toBe(200);

    const calculationWithoutSchedule = await request()
      .put('/api/v1/class-subject-completion')
      .set(teacherHeaders)
      .send({
        classId,
        subjectId: frenchResponse.body.subject.id,
        gradingPeriodId: nextGradingPeriodId,
        status: 'in_progress',
      });
    expect(calculationWithoutSchedule.status, JSON.stringify(calculationWithoutSchedule.body)).toBe(200);
  });
});
