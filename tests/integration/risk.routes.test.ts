import { describe, expect, it } from 'vitest';

import { withTenantSchema } from '../../src/shared/database/db.js';
import { buildRiskService } from '../../src/modules/risk/risk.service.js';
import {
  getAuthHeaders,
  getSeedContext,
  queryTenant,
  request,
  tenantTable,
  TEST_SCHEMA_NAME,
} from './setup.js';

const suffix = String(Date.now());

type IdRow = { id: string };

describe('risk alerts integration (7a)', () => {
  it('calcule le niveau élève selon les signaux actifs et expose les profs à risque', async () => {
    const headers = await getAuthHeaders('director');

    // Un élève avec un paiement en retard, un élève sans signal initial.
    await queryTenant(`UPDATE ${tenantTable('school_years')} SET status='closed' WHERE status='active'`);
    const years = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('school_years')} (label, start_date, end_date, end_of_year_review_start_date, status)
       VALUES ($1, '2103-09-01', '2104-06-30', '2104-05-01', 'active') RETURNING id::text`,
      [`rk-${suffix}`]
    );
    const yearId = years[0]!.id;
    const levels = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('levels')} (name, order_index, is_exam_class) VALUES ($1, 99950, false) RETURNING id::text`,
      [`RK level ${suffix}`]
    );
    const classes = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('classes')} (name, level_id, school_year_id, is_active)
       VALUES ($1, $2::uuid, $3::uuid, true) RETURNING id::text`,
      [`RK class ${suffix}`, levels[0]!.id, yearId]
    );
    const classId = classes[0]!.id;
    const students = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, matricule)
       VALUES ($1::uuid, 'Risky', 'Kid', $2), ($1::uuid, 'Safe', 'Kid', $3) RETURNING id::text`,
      [classId, `RK-R-${suffix}`, `RK-S-${suffix}`]
    );
    const riskyStudentId = students[0]!.id;
    const safeStudentId = students[1]!.id;
    const riskScheduleId = (await queryTenant<IdRow>(`INSERT INTO ${tenantTable('schedules')}
      (schedule_period_id,teacher_id,class_id,room_id,time_slot_id,day_of_week,subject,is_active)
      SELECT schedule_period_id,teacher_id,$1::uuid,room_id,time_slot_id,day_of_week,subject,false
      FROM ${tenantTable('schedules')} WHERE id=$2::uuid RETURNING id::text`,
    [classId, getSeedContext().scheduleId]))[0]!.id;
    await queryTenant(`INSERT INTO ${tenantTable('enrollments')} (student_id, class_id, school_year_id, type, status)
      VALUES ($1::uuid, $3::uuid, $4::uuid, 'new_registration', 'confirmed'),
             ($2::uuid, $3::uuid, $4::uuid, 'new_registration', 'confirmed')`,
      [riskyStudentId, safeStudentId, classId, yearId]);

    const gradingPeriods = await queryTenant<IdRow & { order_index: number }>(
      `INSERT INTO ${tenantTable('grading_periods')}
         (school_year_id, type, order_index, label, start_date, review_start_date, end_date)
       VALUES
         ($1::uuid, 'trimester', 1, $2, '2103-09-01', '2103-11-01', '2103-12-01'),
         ($1::uuid, 'trimester', 2, $3, '2104-01-01', '2104-03-01', '2104-04-01'),
         ($1::uuid, 'trimester', 3, $4, '2104-05-01', '2104-06-01', '2104-06-30')
       RETURNING id::text, order_index`,
      [yearId, `RK T1 ${suffix}`, `RK T2 ${suffix}`, `RK T3 ${suffix}`]
    );
    const [firstPeriod, secondPeriod, provisionalPeriod] = gradingPeriods.sort((a, b) => a.order_index - b.order_index);
    await queryTenant(
      `INSERT INTO ${tenantTable('grading_period_class_closures')} (grading_period_id, class_id)
       VALUES ($1::uuid, $3::uuid), ($2::uuid, $3::uuid)`,
      [firstPeriod!.id, secondPeriod!.id, classId]
    );
    await queryTenant(
      `INSERT INTO ${tenantTable('student_period_averages')}
         (student_id, grading_period_id, average)
       VALUES
         ($1::uuid, $3::uuid, 15), ($1::uuid, $4::uuid, 14), ($1::uuid, $5::uuid, 8),
         ($2::uuid, $3::uuid, 15), ($2::uuid, $4::uuid, 12), ($2::uuid, $5::uuid, 8)`,
      [riskyStudentId, safeStudentId, firstPeriod!.id, secondPeriod!.id, provisionalPeriod!.id]
    );

    // Cache financier : risky en retard
    await queryTenant(
      `INSERT INTO ${tenantTable('student_financial_status')}
         (student_id, school_year_id, total_expected_to_date, total_paid, total_due_year, status, last_computed_at)
       VALUES ($1::uuid, $2::uuid, 100000, 10000, 300000, 'late', NOW()),
              ($3::uuid, $2::uuid, 100000, 100000, 300000, 'up_to_date', NOW())`,
      [riskyStudentId, yearId, safeStudentId]
    );

    // Exécution du recalcul risque (même logique que le job 15 min)
    const summary = await withTenantSchema(TEST_SCHEMA_NAME, async (tenantDb) =>
      buildRiskService(tenantDb).recalculateAll()
    );
    expect(summary.students).toBeGreaterThanOrEqual(2);
    expect(summary.teachers).toBeGreaterThanOrEqual(0);
    const completedPeriodDrop = await queryTenant<{ grades_signal: boolean }>(
      `SELECT grades_signal FROM ${tenantTable('student_risk_status')} WHERE student_id = $1::uuid`,
      [safeStudentId]
    );
    expect(completedPeriodDrop[0]?.grades_signal).toBe(true);

    // La période sélectionnée (T2) est clôturée et baisse la moyenne de Safe
    // d'au moins deux points ; la moyenne provisoire de T3 reste ignorée.
    const list = await request()
      .get('/api/v1/risk/students')
      .set(headers)
      .query({ schoolYearId: yearId, gradingPeriodId: secondPeriod!.id });
    expect(list.status).toBe(200);
    const rows = list.body.students as Array<{ student_id: string; grades_signal: boolean; risk_score: number; level: string }>;
    expect(list.body.pagination).toEqual(expect.objectContaining({ page: 1, limit: 10 }));
    const risky = rows.find((row) => row.student_id === riskyStudentId);
    const safe = rows.find((row) => row.student_id === safeStudentId);
    expect(risky).toBeDefined();
    expect(safe).toBeDefined();
    expect(risky?.grades_signal).toBe(false);
    expect(safe?.grades_signal).toBe(true);
    expect(risky?.risk_score).toBeGreaterThanOrEqual(1);
    expect(['attention', 'warning', 'critical']).toContain(risky?.level);

    const provisionalSelection = await request()
      .get('/api/v1/risk/students')
      .set(headers)
      .query({
        schoolYearId: yearId,
        gradingPeriodId: provisionalPeriod!.id,
        category: 'grades',
        atRisk: true,
      });
    expect(provisionalSelection.status).toBe(200);
    const provisionalRows = provisionalSelection.body.students as Array<{ student_id: string; grades_signal: boolean }>;
    expect(provisionalRows.find((row) => row.student_id === safeStudentId)?.grades_signal).toBe(true);
    expect(provisionalRows.find((row) => row.student_id === riskyStudentId)?.grades_signal).toBe(false);

    const dashboard = await request()
      .get('/api/v1/dashboard/pilotage')
      .set(headers)
      .query({ schoolYearId: yearId, gradingPeriodId: provisionalPeriod!.id });
    expect(dashboard.status).toBe(200);
    const selectedGradeRisks = await request()
      .get('/api/v1/risk/students')
      .set(headers)
      .query({
        schoolYearId: yearId,
        gradingPeriodId: provisionalPeriod!.id,
        category: 'grades',
        atRisk: true,
      });
    expect(selectedGradeRisks.status).toBe(200);
    expect(dashboard.body.risks.studentGrades).toBe(selectedGradeRisks.body.pagination.total);

    const filteredStudents = await request()
      .get('/api/v1/risk/students')
      .set(headers)
      .query({ page: 1, limit: 1, schoolLevelId: levels[0]!.id, classId, category: 'payments' });
    expect(filteredStudents.status).toBe(200);
    expect(filteredStudents.body.pagination).toEqual(expect.objectContaining({ page: 1, limit: 1 }));
    expect((filteredStudents.body.students as Array<{ payment_signal: boolean }>).every((row) => row.payment_signal)).toBe(true);

    // Règles : lecture et mise à jour du seuil absences élève
    const rules = await request().get('/api/v1/risk/rules').set(headers);
    expect(rules.status).toBe(200);
    expect(rules.body.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ subjectType: 'student', signalType: 'absences', thresholdValue: 3, periodDays: 30, isActive: true }),
      expect.objectContaining({ subjectType: 'student', signalType: 'grades', thresholdValue: 2, periodDays: 0, isActive: true }),
      expect.objectContaining({ subjectType: 'student', signalType: 'payments', thresholdValue: 1, periodDays: 0, isActive: true }),
      expect.objectContaining({ subjectType: 'teacher', signalType: 'absences', thresholdValue: 3, periodDays: 30, isActive: true }),
    ]));

    const update = await request()
      .put('/api/v1/risk/rules/student/absences')
      .set(headers)
      .send({ thresholdValue: 4, periodDays: 21, isActive: true });
    expect(update.status).toBe(200);

    // Trois absences récentes ne franchissent pas un seuil configuré à 4.
    await queryTenant(
      `INSERT INTO ${tenantTable('attendances_student')} (student_id, schedule_id, date, status)
       SELECT $1::uuid, $2::uuid, CURRENT_DATE - offsets.day, 'absent'
       FROM (VALUES (0), (1), (2)) AS offsets(day)`,
      [riskyStudentId, riskScheduleId]
    );
    await withTenantSchema(TEST_SCHEMA_NAME, async (tenantDb) =>
      buildRiskService(tenantDb).recalculateStudents()
    );
    const belowStudentThreshold = await request().get('/api/v1/risk/students').set(headers);
    const riskyBelowThreshold = (belowStudentThreshold.body.students as Array<{
      student_id: string; absences_signal: boolean;
    }>).find((row) => row.student_id === riskyStudentId);
    expect(riskyBelowThreshold?.absences_signal).toBe(false);

    const lowerStudentThreshold = await request()
      .put('/api/v1/risk/rules/student/absences')
      .set(headers)
      .send({ thresholdValue: 3, periodDays: 21, isActive: true });
    expect(lowerStudentThreshold.status).toBe(200);
    await withTenantSchema(TEST_SCHEMA_NAME, async (tenantDb) =>
      buildRiskService(tenantDb).recalculateStudents()
    );
    const atStudentThreshold = await request().get('/api/v1/risk/students').set(headers);
    const riskyAtThreshold = (atStudentThreshold.body.students as Array<{
      student_id: string; absences_signal: boolean;
    }>).find((row) => row.student_id === riskyStudentId);
    expect(riskyAtThreshold?.absences_signal).toBe(true);

    const { teacherId } = getSeedContext();
    await queryTenant(
      `INSERT INTO ${tenantTable('attendances_teacher')} (teacher_id, schedule_id, date, status)
       SELECT $1::uuid, id, CURRENT_DATE - offsets.day, 'absent'
       FROM ${tenantTable('schedules')}
       CROSS JOIN (VALUES (0), (1), (2)) AS offsets(day)
       LIMIT 3`,
      [teacherId]
    );
    const updateTeacherThreshold = await request()
      .put('/api/v1/risk/rules/teacher/absences')
      .set(headers)
      .send({ thresholdValue: 4, periodDays: 21, isActive: true });
    expect(updateTeacherThreshold.status).toBe(200);
    await withTenantSchema(TEST_SCHEMA_NAME, async (tenantDb) =>
      buildRiskService(tenantDb).recalculateTeachers()
    );
    const belowTeacherThreshold = await request().get('/api/v1/risk/teachers').set(headers).query({ atRisk: false });
    const teacherBelowThreshold = (belowTeacherThreshold.body.teachers as Array<{
      teacher_id: string; absences_signal: boolean;
    }>).find((row) => row.teacher_id === teacherId);
    expect(teacherBelowThreshold?.absences_signal).toBe(false);

    const lowerTeacherThreshold = await request()
      .put('/api/v1/risk/rules/teacher/absences')
      .set(headers)
      .send({ thresholdValue: 3, periodDays: 21, isActive: true });
    expect(lowerTeacherThreshold.status).toBe(200);
    await withTenantSchema(TEST_SCHEMA_NAME, async (tenantDb) =>
      buildRiskService(tenantDb).recalculateTeachers()
    );
    const atTeacherThreshold = await request().get('/api/v1/risk/teachers').set(headers);
    const teacherAtThreshold = (atTeacherThreshold.body.teachers as Array<{
      teacher_id: string; absences_signal: boolean;
    }>).find((row) => row.teacher_id === teacherId);
    expect(teacherAtThreshold?.absences_signal).toBe(true);

    const teacherMonth = new Date().toISOString().slice(0, 7);
    const monthlyTeachers = await request()
      .get('/api/v1/risk/teachers')
      .set(headers)
      .query({ month: teacherMonth, page: 1, limit: 1 });
    expect(monthlyTeachers.status).toBe(200);
    expect(monthlyTeachers.body.pagination).toEqual(expect.objectContaining({ page: 1, limit: 1 }));
    const teacherInMonth = (monthlyTeachers.body.teachers as Array<{
      teacher_id: string; absence_count: number;
    }>).find((row) => row.teacher_id === teacherId);
    // J-1 et J-2 appartiennent au mois précédent les deux premiers jours du mois.
    expect(teacherInMonth?.absence_count).toBeGreaterThanOrEqual(Math.min(3, new Date().getUTCDate()));

    // Désactiver le risque financier retire effectivement ce signal au prochain recalcul.
    const disablePaymentRisk = await request()
      .put('/api/v1/risk/rules/student/payments')
      .set(headers)
      .send({ thresholdValue: 1, periodDays: 0, isActive: false });
    expect(disablePaymentRisk.status).toBe(200);

    await withTenantSchema(TEST_SCHEMA_NAME, async (tenantDb) =>
      buildRiskService(tenantDb).recalculateStudents()
    );
    const afterDisable = await request().get('/api/v1/risk/students').set(headers);
    const riskyAfterDisable = (afterDisable.body.students as Array<{
      student_id: string; payment_signal: boolean;
    }>).find((row) => row.student_id === riskyStudentId);
    expect(riskyAfterDisable?.payment_signal).toBe(false);
  });

  it('profs à risque : endpoint aligné sur teachers.view / attendance.view', async () => {
    const headers = await getAuthHeaders('director');
    const response = await request().get('/api/v1/risk/teachers').set(headers);
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.teachers)).toBe(true);
  });
});
