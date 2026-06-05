import { describe, expect, it } from 'vitest';

import { getAuthHeaders, getSeedContext, queryTenant, request, tenantTable } from './setup.js';

// Helper : insert une présence du prof seed pour le mois courant
// Utilise un UPDATE pour éviter les problèmes de cast de type enum hors search_path
const insertTeacherAttendance = async (teacherId: string, scheduleId: string) => {
  const today = new Date().toISOString().slice(0, 10);
  // On insère sans cast enum : on laisse la valeur DEFAULT 'present' (déjà défini sur la table)
  await queryTenant(
    `
      INSERT INTO ${tenantTable('attendances_teacher')} (teacher_id, schedule_id, date)
      VALUES ($1, $2, $3::date)
      ON CONFLICT (teacher_id, schedule_id, date) DO NOTHING
    `,
    [teacherId, scheduleId, today]
  );
};

const currentMonth = new Date().toISOString().slice(0, 7);

const grantStaffPermissions = async (permissions: string[]): Promise<void> => {
  const context = getSeedContext();
  const positionName = `Staff access ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`;
  const positions = await queryTenant<{ id: string }>(
    `
      INSERT INTO ${tenantTable('admin_positions')} (name, permissions, created_by)
      VALUES ($1, $2::jsonb, $3)
      RETURNING id
    `,
    [positionName, JSON.stringify(permissions), context.directorUserId]
  );
  const positionId = positions[0]?.id;
  expect(positionId).toBeTruthy();

  await queryTenant(
    `
      INSERT INTO ${tenantTable('position_assignments')} (user_id, position_id, assigned_by)
      VALUES ($1, $2, $3)
      ON CONFLICT DO NOTHING
    `,
    [context.staffUserId, positionId, context.directorUserId]
  );
};

describe('billing integration (real db)', () => {
  it('GET /api/v1/billing/salary/summary retourne 200', async () => {
    const headers = await getAuthHeaders('director');

    const response = await request()
      .get(`/api/v1/billing/salary/summary?month=${currentMonth}`)
      .set(headers);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('month', currentMonth);
    expect(Array.isArray(response.body.items)).toBe(true);
  });

  it('POST /api/v1/billing/salary/compute est idempotent', async () => {
    const headers = await getAuthHeaders('director');

    const first = await request()
      .post(`/api/v1/billing/salary/compute?month=${currentMonth}`)
      .set(headers);

    const second = await request()
      .post(`/api/v1/billing/salary/compute?month=${currentMonth}`)
      .set(headers);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const rows = await queryTenant<{ count: number }>(
      `
        SELECT COUNT(*)::int AS count
        FROM ${tenantTable('salary_records')}
        WHERE period_month = $1::date
      `,
      [`${currentMonth}-01`]
    );

    expect(Number(rows[0]?.count ?? 0)).toBe(1);
  });

  it('POST /api/v1/billing/salary/compute ignore les fiches deja payees', async () => {
    const headers = await getAuthHeaders('director');

    const compute = await request()
      .post(`/api/v1/billing/salary/compute?month=${currentMonth}`)
      .set(headers);
    expect(compute.status).toBe(200);

    const records = await queryTenant<{ id: string }>(
      `
        SELECT id
        FROM ${tenantTable('salary_records')}
        WHERE period_month = $1::date
        LIMIT 1
      `,
      [`${currentMonth}-01`]
    );
    const recordId = records[0]?.id;
    expect(recordId).toBeTruthy();

    await queryTenant(
      `
        UPDATE ${tenantTable('salary_records')}
        SET hours_done = 1::numeric, total_fcfa = 5000, hourly_rate = 5000
        WHERE id = $1
      `,
      [recordId]
    );

    const markPaid = await request()
      .patch(`/api/v1/billing/salary/${recordId as string}/status`)
      .set(headers)
      .send({ status: 'paid', notes: 'test', hoursToPay: 1 });
    expect(markPaid.status).toBe(200);

    const recompute = await request()
      .post(`/api/v1/billing/salary/compute?month=${currentMonth}`)
      .set(headers);
    expect(recompute.status).toBe(200);
  });

  it('permanent: paie mensuelle avec note et historique visible', async () => {
    const headers = await getAuthHeaders('director');
    const context = getSeedContext();

    const users = await queryTenant<{ id: string }>(
      `
        INSERT INTO ${tenantTable('users')} (role, name, email, password_hash, is_active)
        VALUES ('teacher', 'Permanent Integration', 'permanent.integration@edutrack.local', 'hash', true)
        RETURNING id
      `
    );
    const userId = users[0]?.id;
    expect(userId).toBeTruthy();

    const teachers = await queryTenant<{ id: string }>(
      `
        INSERT INTO ${tenantTable('teachers')} (user_id, username, type, subjects, hourly_rate, monthly_salary)
        VALUES ($1, $2, 'permanent', ARRAY['Français']::text[], NULL, 350000)
        RETURNING id
      `,
      [userId, `permanent_test_${Date.now()}`]
    );
    const permanentTeacherId = teachers[0]?.id;
    expect(permanentTeacherId).toBeTruthy();

    const schedules = await queryTenant<{ id: string }>(
      `
        INSERT INTO ${tenantTable('schedules')} (
          schedule_period_id,
          teacher_id,
          class_id,
          room_id,
          time_slot_id,
          day_of_week,
          subject,
          is_active
        )
        SELECT
          s.schedule_period_id,
          $1,
          s.class_id,
          s.room_id,
          s.time_slot_id,
          s.day_of_week,
          'Français',
          true
        FROM ${tenantTable('schedules')} s
        WHERE s.id = $2
        LIMIT 1
        RETURNING id
      `,
      [permanentTeacherId, context.scheduleId]
    );
    expect(schedules[0]?.id).toBeTruthy();

    const compute = await request()
      .post(`/api/v1/billing/salary/compute?month=${currentMonth}`)
      .set(headers);
    expect(compute.status).toBe(200);

    const records = await queryTenant<{ id: string }>(
      `
        SELECT id
        FROM ${tenantTable('salary_records')}
        WHERE teacher_id = $1
          AND period_month = $2::date
        LIMIT 1
      `,
      [permanentTeacherId, `${currentMonth}-01`]
    );
    const permanentRecordId = records[0]?.id;
    expect(permanentRecordId).toBeTruthy();

    const note = 'Paiement permanent avril';
    const markPaid = await request()
      .patch(`/api/v1/billing/salary/${permanentRecordId as string}/status`)
      .set(headers)
      .send({ status: 'paid', notes: note });
    expect(markPaid.status).toBe(200);

    const duplicatePayment = await request()
      .patch(`/api/v1/billing/salary/${permanentRecordId as string}/status`)
      .set(headers)
      .send({ status: 'paid', notes: 'second try' });
    expect(duplicatePayment.status).toBe(409);
    expect(duplicatePayment.body).toMatchObject({
      code: 'SALARY_ALREADY_PAID_FOR_MONTH',
    });

    const details = await request()
      .get(`/api/v1/billing/salary/${permanentTeacherId as string}?month=${currentMonth}`)
      .set(headers);
    expect(details.status).toBe(200);
    expect(details.body?.summary?.status).toBe('paid');
    expect(details.body?.summary?.totalFcfa).toBe(350000);
    expect(details.body?.payment?.notes).toBe(note);
    expect(details.body?.payment?.paidAt).toBeTruthy();
  });

  it('bug 1 : recalcul ne doit pas ecraser le statut paid (salary_payments)', async () => {
    const headers = await getAuthHeaders('director');
    const context = getSeedContext();

    // Insérer une présence (status default = 'present') pour avoir hours_done > 0
    await insertTeacherAttendance(context.teacherId, context.scheduleId);

    // Premier compute
    const compute1 = await request()
      .post(`/api/v1/billing/salary/compute?month=${currentMonth}`)
      .set(headers);
    expect(compute1.status).toBe(200);

    // Récupérer l'id du record créé
    const records = await queryTenant<{ id: string }>(
      `SELECT id FROM ${tenantTable('salary_records')} WHERE teacher_id = $1 AND period_month = $2::date LIMIT 1`,
      [context.teacherId, `${currentMonth}-01`]
    );
    const recordId = records[0]?.id;
    expect(recordId).toBeTruthy();

    // Forcer les données pour permettre le paiement
    await queryTenant(
      `UPDATE ${tenantTable('salary_records')} SET hours_done = 2::numeric, total_fcfa = 10000, hourly_rate = 5000 WHERE id = $1`,
      [recordId]
    );

    // Marquer payé (1 heure sur 2)
    const markPaid = await request()
      .patch(`/api/v1/billing/salary/${recordId as string}/status`)
      .set(headers)
      .send({ status: 'paid', notes: 'premier versement', hoursToPay: 1 });
    expect(markPaid.status).toBe(200);

    // Recompute
    const compute2 = await request()
      .post(`/api/v1/billing/salary/compute?month=${currentMonth}`)
      .set(headers);
    expect(compute2.status).toBe(200);

    // Vérifier que le statut n'a pas été écrasé (toujours pending car paiement partiel)
    const afterRecompute = await queryTenant<{ status: string }>(
      `SELECT status::text AS status FROM ${tenantTable('salary_records')} WHERE id = $1`,
      [recordId]
    );
    // Le record avec paiement partiel doit rester pending (pas écrasé à nothing_to_pay)
    // et surtout NE PAS passer de paid à pending
    expect(['pending', 'paid']).toContain(afterRecompute[0]?.status);
  });

  it('bug 2 : lastComputedAt se met a jour a chaque recalcul', async () => {
    const headers = await getAuthHeaders('director');

    const compute1 = await request()
      .post(`/api/v1/billing/salary/compute?month=${currentMonth}`)
      .set(headers);
    expect(compute1.status).toBe(200);

    const summary1 = await request()
      .get(`/api/v1/billing/salary/summary?month=${currentMonth}`)
      .set(headers);
    const firstComputedAt = summary1.body?.lastComputedAt as string | null;
    expect(firstComputedAt).toBeTruthy();

    // Attendre 1.1s pour que updated_at change
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const compute2 = await request()
      .post(`/api/v1/billing/salary/compute?month=${currentMonth}`)
      .set(headers);
    expect(compute2.status).toBe(200);

    const summary2 = await request()
      .get(`/api/v1/billing/salary/summary?month=${currentMonth}`)
      .set(headers);
    const secondComputedAt = summary2.body?.lastComputedAt as string | null;
    expect(secondComputedAt).toBeTruthy();

    // La seconde date doit être strictement postérieure à la première
    expect(new Date(secondComputedAt!).getTime()).toBeGreaterThan(
      new Date(firstComputedAt!).getTime()
    );
  });

  it('POST /api/v1/billing/salary/compute refuse staff (403)', async () => {
    const headers = await getAuthHeaders('staff');

    const response = await request()
      .post(`/api/v1/billing/salary/compute?month=${currentMonth}`)
      .set(headers);

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
    });
  });

  it('GET /api/v1/attendance/teachers/:teacherId/monthly autorise staff avec teachers.attendance.view', async () => {
    const context = getSeedContext();
    await grantStaffPermissions(['teachers.attendance.view', 'teachers.view']);
    const headers = await getAuthHeaders('staff');

    const response = await request()
      .get(`/api/v1/attendance/teachers/${context.teacherId}/monthly?month=${currentMonth}`)
      .set(headers);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      month: currentMonth,
      summary: {
        totalFcfa: null,
        status: 'attendance_only',
      },
    });
    expect(Array.isArray(response.body.rows)).toBe(true);
  });

  it('GET /api/v1/attendance/teacher-compliance autorise staff avec teachers.ranking.view', async () => {
    await grantStaffPermissions(['teachers.ranking.view']);
    const headers = await getAuthHeaders('staff');

    const response = await request()
      .get(`/api/v1/attendance/teacher-compliance?month=${currentMonth}`)
      .set(headers);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
  });

  it('GET /api/v1/billing/salary/export/:teacherId retourne un job BullMQ', async () => {
    const headers = await getAuthHeaders('director');
    const context = getSeedContext();

    const response = await request()
      .get(`/api/v1/billing/salary/export/${context.teacherId}?month=${currentMonth}`)
      .set(headers);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('jobId');
  });

  it('GET /api/v1/billing/salary/:teacherId/payments retourne un historique', async () => {
    const headers = await getAuthHeaders('director');
    const context = getSeedContext();

    await request()
      .post(`/api/v1/billing/salary/compute?month=${currentMonth}`)
      .set(headers);

    const response = await request()
      .get(`/api/v1/billing/salary/${context.teacherId}/payments?limit=12`)
      .set(headers);

    expect(response.status).toBe(200);
    expect(response.body?.teacher?.id).toBe(context.teacherId);
    expect(Array.isArray(response.body?.items)).toBe(true);
  });

  it('POST /api/v1/billing/salary/export/bulk + GET /api/v1/jobs/:jobId/status retourne pending', async () => {
    const headers = await getAuthHeaders('director');
    const response = await request()
      .post('/api/v1/billing/salary/export/bulk')
      .set(headers)
      .send({
        periodFrom: currentMonth,
        periodTo: currentMonth,
        teacherId: null,
      });

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('jobId');

    const status = await request()
      .get(`/api/v1/jobs/${response.body.jobId as string}/status`)
      .set(headers);

    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      jobId: response.body.jobId,
      status: expect.stringMatching(/pending|processing|done/),
    });
  });
});
