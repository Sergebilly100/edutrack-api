import { describe, expect, it } from 'vitest';

import { buildDashboardActionsService } from '../../src/modules/dashboard-actions/dashboard-actions.service.js';
import { withTenantSchema } from '../../src/shared/database/db.js';
import {
  getAuthHeaders,
  getSeedContext,
  queryTenant,
  request,
  tenantTable,
  TEST_SCHEMA_NAME,
} from './setup.js';

type IdRow = { id: string };

describe('critical path E2E integration', () => {
  it('enchaîne inscription, caisse, paiement, notes, bulletin et dashboard sur le même élève', async () => {
    const suffix = Date.now().toString(36);
    const context = getSeedContext();
    const directorHeaders = await getAuthHeaders('director');
    const teacherHeaders = await getAuthHeaders('teacher');

    await queryTenant(`UPDATE ${tenantTable('school_years')} SET status = 'closed' WHERE status = 'active'`);
    const schoolYears = await queryTenant<IdRow>(`
      INSERT INTO ${tenantTable('school_years')}
        (label, start_date, end_date, end_of_year_review_start_date, status)
      VALUES ($1, '2088-09-01', '2089-06-30', '2089-05-31', 'active')
      RETURNING id::text
    `, [`critical-path-${suffix}`]);
    const schoolYearId = schoolYears[0]!.id;

    const levels = await queryTenant<IdRow>(`
      INSERT INTO ${tenantTable('levels')} (name, order_index, is_exam_class)
      VALUES ($1, 990, false)
      RETURNING id::text
    `, [`Critical path level ${suffix}`]);
    const levelId = levels[0]!.id;
    const classes = await queryTenant<IdRow>(`
      INSERT INTO ${tenantTable('classes')} (name, level_id, school_year_id, is_active)
      VALUES ($1, $2::uuid, $3::uuid, true)
      RETURNING id::text
    `, [`Critical path class ${suffix}`, levelId, schoolYearId]);
    const classId = classes[0]!.id;

    const tuitionPlan = await request()
      .put(`/api/v1/tuition-plans/levels/${levelId}`)
      .set(directorHeaders)
      .send({
        schoolYearId,
        totalAmount: 120_000,
        currency: 'FCFA',
        scheduleSteps: [{ dueDate: '2088-09-15', cumulativeAmountExpected: 120_000 }],
      });
    expect(tuitionPlan.status, JSON.stringify(tuitionPlan.body)).toBe(200);

    const studentCreation = await request()
      .post('/api/v1/students')
      .set(directorHeaders)
      .send({
        class_id: classId,
        first_name: 'Awa',
        last_name: 'Parcours',
        matricule: `E2E-${suffix}`,
        parent_name: 'Koffi Parcours',
        parent_phone: '2250701234567',
      });
    expect(studentCreation.status, JSON.stringify(studentCreation.body)).toBe(201);
    const studentId = studentCreation.body.data.id as string;

    const parentLinks = await queryTenant<{ parent_id: string }>(`
      SELECT psl.parent_id::text
      FROM ${tenantTable('parent_student_links')} psl
      WHERE psl.student_id = $1::uuid
    `, [studentId]);
    expect(parentLinks).toHaveLength(1);

    const enrollmentCreation = await request()
      .post('/api/v1/enrollments')
      .set(directorHeaders)
      .send({ studentId, classId, schoolYearId, type: 'new_registration' });
    expect(enrollmentCreation.status, JSON.stringify(enrollmentCreation.body)).toBe(201);
    expect(enrollmentCreation.body.enrollment.status).toBe('pending_cashier');
    const enrollmentId = enrollmentCreation.body.enrollment.id as string;

    const confirmation = await request()
      .post(`/api/v1/enrollments/${enrollmentId}/confirm-payment`)
      .set(directorHeaders)
      .send({ amount: 120000, method: 'cash', schoolReceiptReference: `CAISSE-${suffix}` });
    expect(confirmation.status, JSON.stringify(confirmation.body)).toBe(200);
    expect(confirmation.body.enrollment).toMatchObject({
      id: enrollmentId,
      status: 'confirmed',
      confirmedByUserId: context.directorUserId,
    });
    expect(confirmation.body.payment).toMatchObject({
      studentId,
      schoolYearId,
      amount: 120_000,
      source: 'cashier_manual',
      status: 'confirmed',
    });

    const recordedPayments = await queryTenant<{ amount: string; source: string; status: string }>(`
      SELECT amount::text, source::text, status::text
      FROM ${tenantTable('payments')}
      WHERE student_id = $1::uuid AND school_year_id = $2::uuid
      ORDER BY created_at
    `, [studentId, schoolYearId]);
    expect(recordedPayments).toEqual([
      expect.objectContaining({ amount: '120000.00', source: 'cashier_manual', status: 'confirmed' }),
    ]);

    const additionalPayment = await request()
      .post('/api/v1/payments')
      .set(directorHeaders)
      .send({ studentId, schoolYearId, amount: 15_000, method: 'mobile_money' });
    expect(additionalPayment.status, JSON.stringify(additionalPayment.body)).toBe(201);
    expect(additionalPayment.body.financialStatus).toMatchObject({
      confirmedPaid: 135_000,
      remainingDue: 0,
      standing: 'up_to_date',
    });

    const financialSummary = await request()
      .get(`/api/v1/finance/financial-summary?school_year_id=${schoolYearId}`)
      .set(directorHeaders);
    expect(financialSummary.status, JSON.stringify(financialSummary.body)).toBe(200);
    expect(Number(financialSummary.body.school.total_paid)).toBe(135_000);
    expect(financialSummary.body.classes).toEqual(expect.arrayContaining([
      expect.objectContaining({ class_id: classId, total_paid: expect.anything() }),
    ]));
    const classFinancialSummary = financialSummary.body.classes.find(
      (summary: { class_id: string }) => summary.class_id === classId
    ) as { total_paid: string | number };
    expect(Number(classFinancialSummary.total_paid)).toBe(135_000);

    const subject = await request()
      .post('/api/v1/subjects')
      .set(directorHeaders)
      .send({ levelId, name: 'Mathématiques E2E', coefficient: 4 });
    expect(subject.status, JSON.stringify(subject.body)).toBe(201);
    const subjectId = subject.body.subject.id as string;

    const gradingPeriod = await request()
      .post('/api/v1/grading-periods')
      .set(directorHeaders)
      .send({
        schoolYearId,
        type: 'trimester',
        orderIndex: 1,
        label: 'Trimestre E2E',
        startDate: '2088-09-01',
        endDate: '2088-12-20',
      });
    expect(gradingPeriod.status, JSON.stringify(gradingPeriod.body)).toBe(201);
    const gradingPeriodId = gradingPeriod.body.gradingPeriod.id as string;

    const seededSchedule = await queryTenant<{
      schedule_period_id: string;
      room_id: string;
      time_slot_id: string;
      day_of_week: number;
    }>(`
      SELECT schedule_period_id::text, room_id::text, time_slot_id::text, day_of_week
      FROM ${tenantTable('schedules')}
      WHERE id = $1::uuid
    `, [context.scheduleId]);
    const alternateSlots = await queryTenant<IdRow>(`
      SELECT id::text
      FROM ${tenantTable('time_slots')}
      WHERE id <> $1::uuid
      ORDER BY sort_order
      LIMIT 1
    `, [seededSchedule[0]!.time_slot_id]);
    const schedules = await queryTenant<IdRow>(`
      INSERT INTO ${tenantTable('schedules')}
        (schedule_period_id, teacher_id, class_id, room_id, time_slot_id, day_of_week, subject, is_active)
      VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, 'Mathématiques E2E', true)
      RETURNING id::text
    `, [
      seededSchedule[0]!.schedule_period_id,
      context.teacherId,
      classId,
      seededSchedule[0]!.room_id,
      alternateSlots[0]!.id,
      seededSchedule[0]!.day_of_week,
    ]);
    const scheduleId = schedules[0]!.id;

    const evaluation = await request()
      .post('/api/v1/evaluations')
      .set(teacherHeaders)
      .send({
        lessonSlotId: scheduleId,
        subjectId,
        classId,
        gradingPeriodId,
        type: 'scheduled',
        evaluationDate: '2088-10-01',
        coefficient: 1,
        label: 'Devoir E2E',
      });
    expect(evaluation.status, JSON.stringify(evaluation.body)).toBe(201);
    const evaluationId = evaluation.body.evaluation.id as string;

    const grade = await request()
      .put(`/api/v1/evaluations/${evaluationId}/grades`)
      .set(teacherHeaders)
      .send({ studentId, score: 16, maxScore: 20 });
    expect(grade.status, JSON.stringify(grade.body)).toBe(200);
    expect(grade.body.averages).toMatchObject({ generalAverage: 16 });

    const incomplete = await request()
      .put('/api/v1/class-subject-completion')
      .set(teacherHeaders)
      .send({ classId, subjectId, gradingPeriodId, status: 'in_progress' });
    expect(incomplete.status).toBe(200);

    await withTenantSchema(TEST_SCHEMA_NAME, (tenantDb) =>
      buildDashboardActionsService(tenantDb).generateAll()
    );
    const blockedBeforeCompletion = await request()
      .get('/api/v1/dashboard/action-items')
      .set(directorHeaders);
    expect(blockedBeforeCompletion.status).toBe(200);
    expect((blockedBeforeCompletion.body.items as Array<{ type: string; referenceId: string | null }>)).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'report_cards_blocked', referenceId: classId })])
    );

    const completed = await request()
      .put('/api/v1/class-subject-completion')
      .set(teacherHeaders)
      .send({ classId, subjectId, gradingPeriodId, status: 'completed' });
    expect(completed.status).toBe(200);
    expect(completed.body.completion.status).toBe('completed');

    const academicCompletion = await request()
      .get(`/api/v1/report-cards/completion?classId=${classId}&gradingPeriodId=${gradingPeriodId}`)
      .set(directorHeaders);
    expect(academicCompletion.status, JSON.stringify(academicCompletion.body)).toBe(200);
    expect(academicCompletion.body.subjects).toEqual(expect.arrayContaining([
      expect.objectContaining({ subjectId, status: 'completed' }),
    ]));

    const generated = await request()
      .post('/api/v1/report-cards/generate')
      .set(directorHeaders)
      .send({ class_id: classId, grading_period_id: gradingPeriodId });
    expect(generated.status, JSON.stringify(generated.body)).toBe(200);
    expect(generated.body.generatedCount).toBe(1);

    const reportCards = await queryTenant<IdRow>(`
      SELECT id::text
      FROM ${tenantTable('report_cards')}
      WHERE student_id = $1::uuid AND grading_period_id = $2::uuid AND status = 'generated'
    `, [studentId, gradingPeriodId]);
    expect(reportCards).toHaveLength(1);
    const reportCardId = reportCards[0]!.id;

    const published = await request()
      .post(`/api/v1/report-cards/${reportCardId}/publish`)
      .set(directorHeaders);
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(published.body).toEqual({ success: true });

    await withTenantSchema(TEST_SCHEMA_NAME, (tenantDb) =>
      buildDashboardActionsService(tenantDb).generateAll()
    );
    const finalActionItems = await request()
      .get('/api/v1/dashboard/action-items')
      .set(directorHeaders);
    expect(finalActionItems.status).toBe(200);
    expect((finalActionItems.body.items as Array<{ type: string; referenceId: string | null }>)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'report_cards_blocked', referenceId: classId })])
    );

    const publishedCard = await queryTenant<{ status: string; published_by_user_id: string | null }>(`
      SELECT status::text, published_by_user_id::text
      FROM ${tenantTable('report_cards')}
      WHERE id = $1::uuid
    `, [reportCardId]);
    expect(publishedCard[0]).toEqual({ status: 'published', published_by_user_id: context.directorUserId });
  });
});
