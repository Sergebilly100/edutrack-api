import { randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  getAuthHeaders,
  getSeedContext,
  queryPublic,
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

  it('POST /api/v1/attendance/qr-scan avec token invalide retourne 400 QR_NOT_IN_SCHOOL', async () => {
    const context = getSeedContext();
    const headers = await getAuthHeaders('teacher');
    const invalidToken = randomBytes(32).toString('hex');

    const response = await request().post('/api/v1/attendance/qr-scan').set(headers).send({
      qr_token: invalidToken,
      scan_type: 'start',
      schedule_id: context.scheduleId,
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'QR_NOT_IN_SCHOOL' });
  });

  it('POST /api/v1/attendance/qr-scan start après end ne retourne pas 500', async () => {
    const context = getSeedContext();
    const headers = await getAuthHeaders('teacher');

    const endResponse = await request().post('/api/v1/attendance/qr-scan').set(headers).send({
      qr_token: context.validRoomToken,
      scan_type: 'end',
      schedule_id: context.scheduleId,
      date: LEGACY_CHECK_IN_DATE,
    });

    expect(endResponse.status).toBe(200);

    const startResponse = await request().post('/api/v1/attendance/qr-scan').set(headers).send({
      qr_token: context.validRoomToken,
      scan_type: 'start',
      schedule_id: context.scheduleId,
      date: LEGACY_CHECK_IN_DATE,
    });

    expect(startResponse.status).toBe(200);
    expect(startResponse.body).toHaveProperty('data.valid');
    expect(startResponse.body).toHaveProperty('data.roomMismatch');

    const rows = await queryTenant<{ room_scan_start_at: string | null; room_scan_end_at: string | null }>(
      `
        SELECT room_scan_start_at::text, room_scan_end_at::text
        FROM ${tenantTable('attendances_teacher')}
        WHERE teacher_id = $1 AND schedule_id = $2 AND date = $3::date
      `,
      [context.teacherId, context.scheduleId, LEGACY_CHECK_IN_DATE]
    );

    expect(rows[0]?.room_scan_start_at).toBeTruthy();
    expect(rows[0]?.room_scan_end_at).toBeNull();
  });

  it('POST /api/v1/attendance/check-in préserve les coordonnées lors d\'un UPDATE avec COALESCE', async () => {
    const context = getSeedContext();
    const headers = await getAuthHeaders('teacher');
    const testDate = '2000-01-05';

    // Insérer directement une attendance avec coordonnées géo
    await queryTenant(
      `
        INSERT INTO ${tenantTable('attendances_teacher')} (
          teacher_id, schedule_id, date, status, checked_in_at,
          checkin_latitude, checkin_longitude, checkin_accuracy,
          geo_status
        )
        VALUES ($1, $2, $3::date, 'present', NOW(), 48.8566, 2.3522, 10, 'verified')
      `,
      [context.teacherId, context.scheduleId, testDate]
    );

    // Vérifier l'insertion initiale
    const rowsAfterInsert = await queryTenant<{
      checkin_latitude: string | null;
      checkin_longitude: string | null;
      checkin_accuracy: string | null;
    }>(
      `
        SELECT checkin_latitude::text, checkin_longitude::text, checkin_accuracy::text
        FROM ${tenantTable('attendances_teacher')}
        WHERE teacher_id = $1 AND schedule_id = $2 AND date = $3::date
      `,
      [context.teacherId, context.scheduleId, testDate]
    );

    expect(rowsAfterInsert[0]?.checkin_latitude).toContain('48.8566');
    expect(rowsAfterInsert[0]?.checkin_longitude).toContain('2.3522');
    expect(rowsAfterInsert[0]?.checkin_accuracy).toContain('10');

    // Faire un check-in SANS coordonnées (simule un re-pointage sans géo)
    // Cela déclenchera un UPDATE via ON CONFLICT avec latitude/longitude = null
    const secondResponse = await request()
      .post('/api/v1/attendance/check-in')
      .set(headers)
      .send({
        schedule_id: context.scheduleId,
        date: testDate,
        // Pas de latitude/longitude/accuracy
      });

    expect(secondResponse.status).toBe(200);

    // Vérifier que les coordonnées du premier pointage sont PRÉSERVÉES grâce à COALESCE
    const rowsAfterUpdate = await queryTenant<{
      checkin_latitude: string | null;
      checkin_longitude: string | null;
      checkin_accuracy: string | null;
    }>(
      `
        SELECT checkin_latitude::text, checkin_longitude::text, checkin_accuracy::text
        FROM ${tenantTable('attendances_teacher')}
        WHERE teacher_id = $1 AND schedule_id = $2 AND date = $3::date
      `,
      [context.teacherId, context.scheduleId, testDate]
    );

    expect(rowsAfterUpdate[0]?.checkin_latitude).toContain('48.8566');
    expect(rowsAfterUpdate[0]?.checkin_longitude).toContain('2.3522');
    expect(rowsAfterUpdate[0]?.checkin_accuracy).toContain('10');
  });
});
