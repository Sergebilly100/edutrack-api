import { describe, expect, it } from 'vitest';

import {
  TEST_SCHEMA_NAME,
  getAuthHeaders,
  getSeedContext,
  request,
} from './setup.js';

describe('auth integration (real db)', () => {
  it('POST /api/v1/auth/login/teacher retourne 200 + accessToken + refresh cookie', async () => {
    const context = getSeedContext();

    const response = await request().post('/api/v1/auth/login/teacher').set({
      'x-tenant-schema': TEST_SCHEMA_NAME,
    }).send({
      identifier: context.teacherUsername,
      password: context.teacherPassword,
    });

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('accessToken');
    expect(response.body).toHaveProperty('tokenType', 'Bearer');
    expect(response.headers['set-cookie']).toBeDefined();
  });

  it('POST /api/v1/auth/login/teacher avec mauvais mot de passe retourne 401', async () => {
    const context = getSeedContext();

    const response = await request().post('/api/v1/auth/login/teacher').set({
      'x-tenant-schema': TEST_SCHEMA_NAME,
    }).send({
      identifier: context.teacherUsername,
      password: 'wrong-password',
    });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
    });
  });

  it('GET /api/v1/schedule/active sans token retourne 401', async () => {
    const response = await request().get('/api/v1/schedule/active').set({
      'x-tenant-schema': TEST_SCHEMA_NAME,
    });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
    });
  });

  it('GET /api/v1/schedule/active avec token + schema retourne 200', async () => {
    const headers = await getAuthHeaders('director');

    const response = await request().get('/api/v1/schedule/active').set(headers);

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('date');
    expect(response.body).toHaveProperty('schedules');
  });

  it('POST /api/v1/auth/refresh avec cookie valide retourne un nouveau accessToken', async () => {
    const context = getSeedContext();

    const loginResponse = await request().post('/api/v1/auth/login/teacher').set({
      'x-tenant-schema': TEST_SCHEMA_NAME,
    }).send({
      identifier: context.teacherUsername,
      password: context.teacherPassword,
    });

    expect(loginResponse.status).toBe(200);
    const cookies = loginResponse.headers['set-cookie'];
    const refreshCookie = Array.isArray(cookies)
      ? cookies.find((cookie) => cookie.startsWith('refresh_token='))
      : undefined;

    expect(refreshCookie).toBeDefined();

    const refreshResponse = await request()
      .post('/api/v1/auth/refresh')
      .set('Cookie', refreshCookie!);

    expect(refreshResponse.status).toBe(200);
    expect(refreshResponse.body).toHaveProperty('accessToken');
    expect(refreshResponse.body).toMatchObject({
      tokenType: 'Bearer',
    });
  });

  it('POST /api/v1/auth/refresh sans cookie retourne 401', async () => {
    const response = await request().post('/api/v1/auth/refresh');

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
    });
  });
});
