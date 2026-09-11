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
    const directorHeaders = await getAuthHeaders('director');
    const teacherHeaders = await getAuthHeaders('teacher');

    const years = await queryTenant<{ id: string }>(`
      INSERT INTO school_years (label, start_date, end_date, end_of_year_review_start_date, status)
      VALUES ('09/2088 - 06/2089', '2088-09-01', '2089-06-30', '2089-05-31', 'draft')
      RETURNING id
    `);
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
      startDate: '2088-09-01',
      endDate: '2088-12-20',
    });
    expect(periodResponse.status).toBe(201);
    const gradingPeriodId = periodResponse.body.gradingPeriod.id as string;

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

    const math1 = await createEvaluation(context.scheduleId, mathResponse.body.subject.id, 'Devoir 1', 1, '2088-10-15');
    const math2 = await createEvaluation(context.scheduleId, mathResponse.body.subject.id, 'Devoir 2', 3, '2088-11-12');
    const french = await createEvaluation(frenchSchedules[0]!.id, frenchResponse.body.subject.id, 'Dictée', 1, '2088-11-19');

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
      expect.objectContaining({ id: math1, evaluationDate: '2088-10-15' }),
      expect.objectContaining({ id: math2, evaluationDate: '2088-11-12' }),
      expect.objectContaining({ id: french, evaluationDate: '2088-11-19' }),
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
    const spontaneousDate = new Date(Date.UTC(2088, 9, 1));
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
    expect(inProgressSubjectEdit.status).toBe(200);

    const math3 = await createEvaluation(context.scheduleId, mathResponse.body.subject.id, 'Devoir 3', 1, '2088-12-01');
    const incompleteCompletion = await request().put('/api/v1/class-subject-completion').set(teacherHeaders).send({
      classId,
      subjectId: mathResponse.body.subject.id,
      gradingPeriodId,
      status: 'completed',
    });
    expect(incompleteCompletion.status).toBe(409);
    expect(incompleteCompletion.body.code).toBe('GRADES_INCOMPLETE');
    expect((await saveGrade(math3, 16)).status).toBe(200);

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

    await queryTenant(`
      UPDATE schedules
      SET end_date = '2000-01-01'
      WHERE teacher_id = $1 AND class_id = $2
    `, [context.teacherId, classId]);
    const contextWithoutExpiredSchedules = await request()
      .get('/api/v1/academic/teacher-context')
      .set(teacherHeaders);
    expect(contextWithoutExpiredSchedules.status).toBe(200);
    expect(contextWithoutExpiredSchedules.body.classes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: classId }),
    ]));
  });
});
