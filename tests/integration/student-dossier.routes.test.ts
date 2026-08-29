import { describe, expect, it } from 'vitest';

import { signAccessToken } from '../../src/modules/auth/auth.service.js';
import { getAuthHeaders, getSeedContext, queryTenant, request, tenantTable, TEST_SCHEMA_NAME } from './setup.js';

const suffix = String(Date.now());

type IdRow = { id: string };

describe('student dossier integration (7c)', () => {
  it('agrège la timeline et restreint la vue prof', async () => {
    const context = getSeedContext();
    const directorHeaders = await getAuthHeaders('director');

    await queryTenant(`UPDATE ${tenantTable('school_years')} SET status='closed' WHERE status='active'`);
    const years = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('school_years')} (label, start_date, end_date, end_of_year_review_start_date, status)
       VALUES ($1, '2107-09-01', '2108-06-30', '2108-05-01', 'active') RETURNING id::text`,
      [`ds-${suffix}`]
    );
    const levels = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('levels')} (name, order_index, is_exam_class) VALUES ($1, 99970, false) RETURNING id::text`,
      [`DS level ${suffix}`]
    );
    const classes = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('classes')} (name, level_id, school_year_id, is_active)
       VALUES ($1, $2::uuid, $3::uuid, true) RETURNING id::text`,
      [`DS class ${suffix}`, levels[0]!.id, years[0]!.id]
    );
    const students = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, matricule)
       VALUES ($1::uuid, 'Dossier', 'Kid', $2) RETURNING id::text`,
      [classes[0]!.id, `DS-${suffix}`]
    );
    const studentId = students[0]!.id;

    // Paiement confirmé
    await queryTenant(
      `INSERT INTO ${tenantTable('payments')} (student_id, school_year_id, amount, method, source, status, payment_date, receipt_number)
       VALUES ($1::uuid, $2::uuid, 50000, 'cash', 'cashier_manual', 'confirmed', CURRENT_DATE, $3)`,
      [studentId, years[0]!.id, `REC-DS-${suffix}`]
    );

    // Token prof enseignant dans cette classe (schedule lié)
    const teacherUser = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('users')} (role, name, phone, password_hash, is_active)
       VALUES ('teacher', 'Prof Dossier', '2250750000001', 'not-used', true) RETURNING id::text`
    );
    const teachers = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('teachers')} (user_id, username, type, subjects, hourly_rate)
       VALUES ($1::uuid, $2, 'vacataire', '{SVT}', 4000) RETURNING id::text`,
      [teacherUser[0]!.id, `dossier.${suffix}`]
    );

    await queryTenant(
      `INSERT INTO ${tenantTable('schedule_periods')} (name, valid_from, valid_to, is_active)
       VALUES ($1, '2000-01-01', '2100-12-31', true)`,
      [`Dossier EDT ${suffix}`]
    );
    await queryTenant(
      `INSERT INTO ${tenantTable('schedules')}
         (schedule_period_id, teacher_id, class_id, room_id, time_slot_id, day_of_week, subject, is_active)
       SELECT sp.id, $2::uuid, $3::uuid,
              (SELECT id FROM ${tenantTable('rooms')} ORDER BY name LIMIT 1),
              (SELECT id FROM ${tenantTable('time_slots')} ORDER BY sort_order LIMIT 1),
              1, 'SVT', true
       FROM ${tenantTable('schedule_periods')} sp
       WHERE sp.name = $1
       LIMIT 1`,
      [`Dossier EDT ${suffix}`, teachers[0]!.id, classes[0]!.id]
    );

    const teacherToken = await signAccessToken({
      sub: teacherUser[0]!.id,
      role: 'teacher',
      schemaName: TEST_SCHEMA_NAME,
    });

    // Vue direction : paiement visible
    const directorView = await request()
      .get(`/api/v1/students/${studentId}/dossier`)
      .set(directorHeaders);
    expect(directorView.status).toBe(200);
    expect(directorView.body.student).toMatchObject({ id: studentId, className: `DS class ${suffix}` });
    expect(Array.isArray(directorView.body.events)).toBe(true);
    const paymentEvent = directorView.body.events.find((event: { type: string }) => event.type === 'payment');
    expect(paymentEvent).toBeDefined();

    // Vue prof : le paiement est masqué (scoping académique uniquement)
    const teacherView = await request()
      .get(`/api/v1/students/${studentId}/dossier`)
      .set({ authorization: `Bearer ${teacherToken}` });
    expect(teacherView.status).toBe(200);
    expect(teacherView.body.student).toMatchObject({ id: studentId, className: `DS class ${suffix}` });
    const teacherPayments = teacherView.body.events.filter((event: { type: string }) => event.type === 'payment');
    expect(teacherPayments).toHaveLength(0);

    const otherClasses = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('classes')} (name, level_id, school_year_id, is_active)
       VALUES ($1, $2::uuid, $3::uuid, true) RETURNING id::text`,
      [`DS other class ${suffix}`, levels[0]!.id, years[0]!.id]
    );
    const otherStudents = await queryTenant<IdRow>(
      `INSERT INTO ${tenantTable('students')} (class_id, first_name, last_name, matricule)
       VALUES ($1::uuid, 'Hors', 'Portée', $2) RETURNING id::text`,
      [otherClasses[0]!.id, `DS-OUT-${suffix}`]
    );
    const outsideScope = await request()
      .get(`/api/v1/students/${otherStudents[0]!.id}/dossier`)
      .set({ authorization: `Bearer ${teacherToken}` });
    expect(outsideScope.status).toBe(403);

    // Timeline triée chronologiquement décroissante
    const directorDates = directorView.body.events.map((event: { date: string }) => event.date);
    expect([...directorDates].sort().reverse()).toEqual(directorDates);
    void context;
  });
});
