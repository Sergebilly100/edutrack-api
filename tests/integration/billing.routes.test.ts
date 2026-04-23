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

    const markPaid = await request()
      .patch(`/api/v1/billing/salary/${recordId as string}/status`)
      .set(headers)
      .send({ status: 'paid', notes: 'test' });
    expect(markPaid.status).toBe(200);

    const recompute = await request()
      .post(`/api/v1/billing/salary/compute?month=${currentMonth}`)
      .set(headers);
    expect(recompute.status).toBe(200);
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
