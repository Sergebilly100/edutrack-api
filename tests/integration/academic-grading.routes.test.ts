import { describe, expect, it } from 'vitest';

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
      schedule_period_id: string; room_id: string; time_slot_id: string; day_of_week: number;
    }>(`
      SELECT schedule_period_id, room_id, time_slot_id, day_of_week FROM schedules WHERE id = $1
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

    const completion = await request().put('/api/v1/class-subject-completion').set(teacherHeaders).send({
      classId,
      subjectId: mathResponse.body.subject.id,
      gradingPeriodId,
      status: 'completed',
    });
    expect(completion.status).toBe(200);
    expect(completion.body.completion.status).toBe('completed');

    const reopenedCompletion = await request().put('/api/v1/class-subject-completion').set(teacherHeaders).send({
      classId,
      subjectId: mathResponse.body.subject.id,
      gradingPeriodId,
      status: 'in_progress',
    });
    expect(reopenedCompletion.status).toBe(200);
    expect(reopenedCompletion.body.completion).toMatchObject({
      status: 'in_progress',
      completed_at: null,
    });

    expect((await request().put('/api/v1/class-subject-completion').set(teacherHeaders).send({
      classId,
      subjectId: mathResponse.body.subject.id,
      gradingPeriodId,
      status: 'completed',
    })).status).toBe(200);

    const createEvaluation = async (lessonSlotId: string, subjectId: string, label: string, coefficient: number) => {
      const response = await request().post('/api/v1/evaluations').set(teacherHeaders).send({
        lessonSlotId,
        subjectId,
        classId,
        gradingPeriodId,
        type: 'scheduled',
        coefficient,
        label,
      });
      expect(response.status).toBe(201);
      return response.body.evaluation.id as string;
    };

    const math1 = await createEvaluation(context.scheduleId, mathResponse.body.subject.id, 'Devoir 1', 1);
    const math2 = await createEvaluation(context.scheduleId, mathResponse.body.subject.id, 'Devoir 2', 3);
    const french = await createEvaluation(frenchSchedules[0]!.id, frenchResponse.body.subject.id, 'Dictée', 1);

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
      expect.objectContaining({ subjectId: mathResponse.body.subject.id, status: 'completed' }),
      expect.objectContaining({ subjectId: frenchResponse.body.subject.id, status: 'in_progress' }),
    ]));
  });
});
