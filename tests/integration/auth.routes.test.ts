import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  withTenantSchema: vi.fn(),
  login: vi.fn(),
  signRefreshToken: vi.fn(),
  verifyAccessToken: vi.fn(),
  getMe: vi.fn(),
  verifyRefreshToken: vi.fn(),
  refreshAccessToken: vi.fn(),
  logout: vi.fn(),
  changePassword: vi.fn(),
}));

vi.mock('../../src/shared/database/db.js', () => ({
  withTenantSchema: mocks.withTenantSchema,
}));

vi.mock('../../src/modules/auth/auth.service.js', () => ({
  login: mocks.login,
  signRefreshToken: mocks.signRefreshToken,
  verifyAccessToken: mocks.verifyAccessToken,
  getMe: mocks.getMe,
  verifyRefreshToken: mocks.verifyRefreshToken,
  refreshAccessToken: mocks.refreshAccessToken,
  logout: mocks.logout,
  changePassword: mocks.changePassword,
}));

import authController from '../../src/modules/auth/auth.controller.js';

const buildApp = async () => {
  const app = Fastify();
  await app.register(authController);
  await app.ready();
  return app;
};

const parseBody = (payload: string): unknown => JSON.parse(payload);

beforeEach(() => {
  vi.clearAllMocks();

  mocks.withTenantSchema.mockImplementation(async (_schema, callback) => {
    return callback({ execute: vi.fn() });
  });

  mocks.login.mockResolvedValue({
    accessToken: 'access-token',
    tokenType: 'Bearer',
    expiresIn: '15m',
    user: {
      id: 'user-1',
      role: 'teacher',
      name: 'Prof Test',
      phone: null,
      email: 'prof@test.ci',
      username: 'diallo.ibra',
    },
  });

  mocks.signRefreshToken.mockResolvedValue('refresh-token');
  mocks.verifyAccessToken.mockResolvedValue({
    sub: 'user-1',
    role: 'teacher',
    schemaName: 'tenant_demo',
  });
  mocks.getMe.mockResolvedValue({
    user: {
      id: 'user-1',
      role: 'teacher',
      name: 'Prof Test',
      phone: null,
      email: 'prof@test.ci',
      username: 'diallo.ibra',
    },
  });

  mocks.verifyRefreshToken.mockResolvedValue({
    sub: 'user-1',
    schemaName: 'tenant_demo',
    type: 'refresh',
  });
  mocks.refreshAccessToken.mockResolvedValue({
    accessToken: 'new-access-token',
    tokenType: 'Bearer',
    expiresIn: '15m',
  });
  mocks.logout.mockResolvedValue(undefined);
  mocks.changePassword.mockResolvedValue(undefined);
});

describe('auth routes', () => {
  it('POST /api/v1/auth/login/teacher — 200 + cookie refresh_token', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login/teacher',
      headers: { 'x-tenant-schema': 'tenant_demo' },
      payload: { identifier: 'diallo.ibra', password: 'edutrack2024' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toContain('refresh_token=');
    await app.close();
  });

  it('POST /api/v1/auth/login/teacher — mauvais mot de passe → 401', async () => {
    mocks.login.mockRejectedValue(new Error('Invalid credentials'));
    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login/teacher',
      headers: { 'x-tenant-schema': 'tenant_demo' },
      payload: { identifier: 'diallo.ibra', password: 'wrong' },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('POST /api/v1/auth/login/teacher — header x-tenant-schema absent → 400', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login/teacher',
      payload: { identifier: 'diallo.ibra', password: 'edutrack2024' },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('POST /api/v1/auth/login/teacher — header x-tenant-schema invalide → 400', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login/teacher',
      headers: { 'x-tenant-schema': '../../etc' },
      payload: { identifier: 'diallo.ibra', password: 'edutrack2024' },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('POST /api/v1/auth/login/teacher — body invalide → 400 Validation error', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login/teacher',
      headers: { 'x-tenant-schema': 'tenant_demo' },
      payload: { identifier: 'abc', password: 'test' },
    });

    expect(response.statusCode).toBe(400);
    const body = parseBody(response.body) as { error: string };
    expect(body.error).toBe('Validation error');
    await app.close();
  });

  it('GET /api/v1/auth/me — token valide → 200', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it('GET /api/v1/auth/me — sans Authorization → 401', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('GET /api/v1/auth/me — token malformé → 401', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: 'Bearer' },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('POST /api/v1/auth/refresh — cookie valide → 200 + accessToken', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: 'refresh_token=valid-refresh-token' },
    });

    expect(response.statusCode).toBe(200);
    const body = parseBody(response.body) as { accessToken: string };
    expect(body.accessToken).toBe('new-access-token');
    await app.close();
  });

  it('POST /api/v1/auth/refresh — body refreshToken valide → 200 + accessToken', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: 'valid-refresh-token' },
    });

    expect(response.statusCode).toBe(200);
    const body = parseBody(response.body) as { accessToken: string };
    expect(body.accessToken).toBe('new-access-token');
    await app.close();
  });

  it('POST /api/v1/auth/refresh — sans cookie → 401', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('POST /api/v1/auth/logout — retourne success true', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      payload: { refreshToken: 'valid-refresh-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(parseBody(response.body)).toEqual({ success: true });
    await app.close();
  });

  it('POST /api/v1/auth/change-password — directeur autorisé → 200', async () => {
    mocks.verifyAccessToken.mockResolvedValue({
      sub: 'director-1',
      role: 'director',
      schemaName: 'tenant_demo',
    });
    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: { authorization: 'Bearer valid-token' },
      payload: {
        currentPassword: 'director2024',
        newPassword: 'SecurePass1',
        confirmPassword: 'SecurePass1',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(parseBody(response.body)).toEqual({ success: true });
    await app.close();
  });

  it('POST /api/v1/auth/change-password — staff interdit → 403', async () => {
    mocks.verifyAccessToken.mockResolvedValue({
      sub: 'staff-1',
      role: 'staff',
      schemaName: 'tenant_demo',
    });
    mocks.changePassword.mockRejectedValue(
      new Error('Modification de mot de passe non autorisée pour ce rôle')
    );
    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: { authorization: 'Bearer valid-token' },
      payload: {
        currentPassword: 'staff2024',
        newPassword: 'SecurePass1',
        confirmPassword: 'SecurePass1',
      },
    });

    expect(response.statusCode).toBe(403);
    const body = parseBody(response.body) as { code: string };
    expect(body.code).toBe('FORBIDDEN');
    await app.close();
  });
});
