import { describe, expect, it } from 'vitest';

import { getAuthHeaders, getSeedContext, queryTenant, request, tenantTable } from './setup.js';

const currentMonth = '2025-01';

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
