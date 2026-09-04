import { describe, expect, it } from 'vitest';

import { withTenantSchema } from '../../src/shared/database/db.js';
import { buildDashboardActionsService } from '../../src/modules/dashboard-actions/dashboard-actions.service.js';
import { getAuthHeaders, getSeedContext, queryTenant, request, tenantTable, TEST_SCHEMA_NAME } from './setup.js';

const suffix = String(Date.now());

type IdRow = { id: string };

describe('dashboard action items integration (7b)', () => {
  it('expose les indicateurs consolidés par niveau pour la direction', async () => {
    const headers = await getAuthHeaders('director');

    const response = await request()
      .get('/api/v1/dashboard/pilotage')
      .set(headers);

    expect(response.status).toBe(200);
    expect(response.body.population).toEqual(expect.objectContaining({
      activeStudents: expect.any(Number),
      activeTeachers: expect.any(Number),
      activeClasses: expect.any(Number),
    }));
    expect(response.body.risks).toEqual(expect.objectContaining({
      studentAbsences: expect.any(Number),
      studentGrades: expect.any(Number),
      studentPayments: expect.any(Number),
      teacherAbsences: expect.any(Number),
    }));
    expect(Array.isArray(response.body.academic)).toBe(true);
  });

  it('calcule les moyennes et comptes de notes depuis les données brutes de la période', async () => {
    const headers = await getAuthHeaders('director');
    const context = getSeedContext();
    const shortSuffix = suffix.slice(-10);
    const year = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('school_years')} (label, start_date, end_date, status)
       VALUES ($1, '2110-09-01', '2111-06-30', 'draft') RETURNING id::text`,
      [`D-${shortSuffix}`]
    );
    const level = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('levels')} (name, order_index, is_exam_class)
       VALUES ($1, 99970, false) RETURNING id::text`,
      [`Dashboard notes ${suffix}`]
    );
    const schoolClass = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('classes')} (name, level_id, school_year_id, is_active)
       VALUES ($1, $2::uuid, $3::uuid, true) RETURNING id::text`,
      [`Dashboard classe ${suffix}`, level[0]!.id, year[0]!.id]
    );
    const period = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('grading_periods')} (school_year_id, type, order_index, label, start_date, end_date)
       VALUES ($1::uuid, 'trimester', 1, $2, '2110-09-01', '2110-12-15') RETURNING id::text`,
      [year[0]!.id, `Trimestre ${suffix}`]
    );
    const subject = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('subjects')} (level_id, name, coefficient)
       VALUES ($1::uuid, $2, 2) RETURNING id::text`,
      [level[0]!.id, `Mathématiques ${suffix}`]
    );
    const students = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, matricule)
       VALUES ($1::uuid, 'Awa', 'Test', $2), ($1::uuid, 'Koffi', 'Test', $3) RETURNING id::text`,
      [schoolClass[0]!.id, `DASH-A-${suffix}`, `DASH-K-${suffix}`]
    );
    const evaluation = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('evaluations')}
         (lesson_slot_id, subject_id, class_id, grading_period_id, teacher_id, type, coefficient, label, evaluation_date)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'scheduled', 1, 'Devoir dashboard', '2110-10-10')
       RETURNING id::text`,
      [context.scheduleId, subject[0]!.id, schoolClass[0]!.id, period[0]!.id, context.teacherId]
    );
    await queryTenant(
      `INSERT INTO ${tenantTable('evaluation_grades')} (evaluation_id, student_id, score, max_score)
       VALUES ($1::uuid, $2::uuid, 16, 20), ($1::uuid, $3::uuid, 8, 20)`,
      [evaluation[0]!.id, students[0]!.id, students[1]!.id]
    );

    const response = await request()
      .get(`/api/v1/dashboard/pilotage?schoolYearId=${year[0]!.id}&gradingPeriodId=${period[0]!.id}`)
      .set(headers);

    expect(response.status).toBe(200);
    expect(response.body.academic).toEqual([
      expect.objectContaining({
        levelId: level[0]!.id,
        averageScore: 12,
        studentsWithAverage: 2,
        gradeCount: 2,
        gradesAtLeastTen: 1,
      }),
    ]);
  });

  it('conserve les présences de chaque jour lors d’un changement de période EDT', async () => {
    const headers = await getAuthHeaders('director');
    const context = getSeedContext();
    const dates = await queryTenant<{ date: string; day_of_week: number }>(
      `SELECT d::date::text AS date, EXTRACT(ISODOW FROM d)::int AS day_of_week
       FROM generate_series(CURRENT_DATE - INTERVAL '6 days', CURRENT_DATE, INTERVAL '1 day') d
       WHERE EXTRACT(ISODOW FROM d)::int BETWEEN 1 AND 6
       ORDER BY d DESC
       LIMIT 2`
    );
    expect(dates).toHaveLength(2);

    const scheduleIds: string[] = [];
    for (const [index, date] of [...dates].reverse().entries()) {
      const period = await queryTenant<IdRow>(
        `INSERT INTO ${tenantTable('schedule_periods')} (name, valid_from, valid_to, is_active, created_at)
         VALUES ($1, $2::date, $2::date, true, NOW() + ($3 * INTERVAL '1 second')) RETURNING id::text`,
        [`Historique ${suffix}-${index}`, date.date, index]
      );
      const schedule = await queryTenant<IdRow>(
        `INSERT INTO ${tenantTable('schedules')}
           (schedule_period_id, teacher_id, class_id, room_id, time_slot_id, day_of_week, subject, is_active)
         SELECT $1::uuid, teacher_id, class_id, room_id, time_slot_id, $2, subject, true
         FROM ${tenantTable('schedules')} WHERE id = $3::uuid
         RETURNING id::text`,
        [period[0]!.id, date.day_of_week, context.scheduleId]
      );
      scheduleIds.push(schedule[0]!.id);
      await queryTenant(
        `INSERT INTO ${tenantTable('attendances_teacher')} (teacher_id, schedule_id, date, status)
         VALUES ($1::uuid, $2::uuid, $3::date, $4::attendance_teacher_status)`,
        [context.teacherId, schedule[0]!.id, date.date, index === 0 ? 'present' : 'absent']
      );
    }

    const response = await request().get('/api/v1/attendance/history?days=7').set(headers);

    expect(response.status).toBe(200);
    const older = response.body.find((row: { date: string }) => row.date === dates[1]!.date);
    const newer = response.body.find((row: { date: string }) => row.date === dates[0]!.date);
    expect(older).toMatchObject({ present_count: 1, absent_count: 0, not_checked_count: 0, total_count: 1 });
    expect(newer).toMatchObject({ present_count: 0, absent_count: 1, not_checked_count: 0, total_count: 1 });
    expect(scheduleIds).toHaveLength(2);
  });

  it('génère, expose et résout des items croisés pour la direction', async () => {
    const headers = await getAuthHeaders('director');

    // Élèves à risque (warning/critical) → items student_at_risk
    await queryTenant(`UPDATE ${tenantTable('school_years')} SET status='closed' WHERE status='active'`);
    const years = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('school_years')} (label, start_date, end_date, end_of_year_review_start_date, status)
       VALUES ($1, '2105-09-01', '2106-06-30', '2106-05-01', 'active') RETURNING id::text`,
      [`da-${suffix}`]
    );
    const levels = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('levels')} (name, order_index, is_exam_class) VALUES ($1, 99960, false) RETURNING id::text`,
      [`DA level ${suffix}`]
    );
    const classes = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('classes')} (name, level_id, school_year_id, is_active)
       VALUES ($1, $2::uuid, $3::uuid, true) RETURNING id::text`,
      [`DA class ${suffix}`, levels[0]!.id, years[0]!.id]
    );
    const students = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, matricule)
       VALUES ($1::uuid, 'Risk', 'One', $2), ($1::uuid, 'Risk', 'Two', $3) RETURNING id::text`,
      [classes[0]!.id, `DA-1-${suffix}`, `DA-2-${suffix}`]
    );
    for (const studentId of students) {
      await queryTenant(
        `INSERT INTO ${tenantTable('student_risk_status')}
           (student_id, absences_signal, grades_signal, payment_signal, risk_score, level, computed_at)
         VALUES ($1::uuid, true, true, true, 3, 'critical', NOW())`,
        [studentId.id]
      );
    }

    // Génération complète (providers réels du schéma de test)
    const generated = await withTenantSchema(TEST_SCHEMA_NAME ?? '', async (tenantDb) =>
      buildDashboardActionsService(tenantDb).generateAll({
        weeklyAbsenceCount: 4,
        salaryPendingCount: 0,
        pendingValidations: 2,
        commissionOverdueCount: 0,
      })
    );
    expect(generated.generated).toBeGreaterThanOrEqual(2);

    // Une condition persistante est recalculée à chaque cycle du worker : les
    // items précédents deviennent historiques et ne doivent pas bloquer l'insert.
    await expect(
      withTenantSchema(TEST_SCHEMA_NAME ?? '', async (tenantDb) =>
        buildDashboardActionsService(tenantDb).generateAll({
          weeklyAbsenceCount: 4,
          salaryPendingCount: 0,
          pendingValidations: 2,
          commissionOverdueCount: 0,
        })
      )
    ).resolves.toEqual(expect.objectContaining({ generated: expect.any(Number) }));

    const validationItemStates = await queryTenant<{ is_open: boolean }>(
      `SELECT resolved_at IS NULL AS is_open
       FROM ${tenantTable('dashboard_action_items')}
       WHERE type = 'validations_pending'`
    );
    expect(validationItemStates.filter((item) => item.is_open)).toHaveLength(1);
    expect(validationItemStates.filter((item) => !item.is_open)).toHaveLength(1);

    // Lecture direction : les items sont triés par priorité
    const list = await request().get('/api/v1/dashboard/action-items').set(headers);
    expect(list.status).toBe(200);
    const open = list.body.items as Array<{ id: string; type: string; priority: string; resolved_at?: string | null; resolvedAt?: string | null }>;
    expect(open.some((item) => item.type === 'teacher_absences_high' && item.priority === 'high')).toBe(true);
    expect(open.some((item) => item.type === 'validations_pending' && item.priority === 'high')).toBe(true);
    expect(open.some((item) => item.type === 'student_at_risk')).toBe(true);

    // Résolution persistée côté serveur
    const target = open.find((item) => item.type === 'student_at_risk')!;
    const resolve = await request()
      .post(`/api/v1/dashboard/action-items/${target.id}/resolve`)
      .set(headers);
    expect(resolve.status).toBe(200);

    const after = await request().get('/api/v1/dashboard/action-items').set(headers);
    const stillOpen = (after.body.items as Array<{ type: string }>).filter(
      (item) => item.type === 'student_at_risk',
    );
    expect(stillOpen).toHaveLength(0);
  });
});
