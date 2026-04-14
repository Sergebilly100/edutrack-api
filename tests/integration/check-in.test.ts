import { randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  getAuthHeaders,
  getSeedContext,
  queryTenant,
  request,
  tenantTable,
} from './setup.js';

const LEGACY_CHECK_IN_DATE = '2000-01-03';

describe('attendance integration (real db)', () => {
  it('POST /api/v1/attendance/check-in crée une attendance', async () => {
    const context = getSeedContext();
    const headers = await getAuthHeaders('teacher');

    const response = await request()
      .post('/api/v1/attendance/check-in')
      .set(headers)
      .send({
        schedule_id: context.scheduleId,
        date: LEGACY_CHECK_IN_DATE,
      });

    expect(response.status).toBe(200);

    const rows = await queryTenant<{ count: number }>(
      `
        SELECT COUNT(*)::int AS count
        FROM ${tenantTable('attendances_teacher')}
        WHERE teacher_id = $1 AND schedule_id = $2 AND date = $3::date
      `,
      [context.teacherId, context.scheduleId, LEGACY_CHECK_IN_DATE]
    );

    expect(Number(rows[0]?.count ?? 0)).toBe(1);
  });

  it('POST /api/v1/attendance/check-in avec schedule invalide retourne 404', async () => {
    const headers = await getAuthHeaders('teacher');

    const response = await request().post('/api/v1/attendance/check-in').set(headers).send({
      schedule_id: randomUUID(),
      date: LEGACY_CHECK_IN_DATE,
    });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      code: 'SCHEDULE_NOT_FOUND',
      statusCode: 404,
    });
  });

  it("POST /api/v1/attendance/check-in est idempotent (pas de doublon)", async () => {
    const context = getSeedContext();
    const headers = await getAuthHeaders('teacher');

    const first = await request()
      .post('/api/v1/attendance/check-in')
      .set(headers)
      .send({
        schedule_id: context.scheduleId,
        date: LEGACY_CHECK_IN_DATE,
      });

    const second = await request()
      .post('/api/v1/attendance/check-in')
      .set(headers)
      .send({
        schedule_id: context.scheduleId,
        date: LEGACY_CHECK_IN_DATE,
      });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const rows = await queryTenant<{ count: number }>(
      `
        SELECT COUNT(*)::int AS count
        FROM ${tenantTable('attendances_teacher')}
        WHERE teacher_id = $1 AND schedule_id = $2 AND date = $3::date
      `,
      [context.teacherId, context.scheduleId, LEGACY_CHECK_IN_DATE]
    );

    expect(Number(rows[0]?.count ?? 0)).toBe(1);
  });

  it('GET /api/v1/attendance/active avec token prof retourne 200', async () => {
    const headers = await getAuthHeaders('teacher');

    const response = await request().get('/api/v1/attendance/active').set(headers);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('date');
    expect(response.body).toHaveProperty('items');
  });

  it('POST /api/v1/attendance/qr-scan avec room token valide retourne valid=true', async () => {
    const context = getSeedContext();
    const headers = await getAuthHeaders('teacher');

    const response = await request().post('/api/v1/attendance/qr-scan').set(headers).send({
      qr_token: context.validRoomToken,
      scan_type: 'start',
      schedule_id: context.scheduleId,
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      data: {
        valid: true,
        roomMismatch: false,
      },
    });
  });

  it('POST /api/v1/attendance/qr-scan avec token invalide persiste room_mismatch=true', async () => {
    const context = getSeedContext();
    const headers = await getAuthHeaders('teacher');
    const invalidToken = randomBytes(32).toString('hex');

    const response = await request().post('/api/v1/attendance/qr-scan').set(headers).send({
      qr_token: invalidToken,
      scan_type: 'start',
      schedule_id: context.scheduleId,
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      data: {
        valid: false,
        roomMismatch: true,
      },
    });

    const rows = await queryTenant<{ room_mismatch: boolean }>(
      `
        SELECT room_mismatch
        FROM ${tenantTable('attendances_teacher')}
        WHERE teacher_id = $1 AND schedule_id = $2 AND date = CURRENT_DATE
      `,
      [context.teacherId, context.scheduleId]
    );

    expect(rows[0]?.room_mismatch).toBe(true);
  });
});
