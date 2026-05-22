import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  withTenantSchema: vi.fn(),
  login: vi.fn(),
  signRefreshToken: vi.fn(),
  signAccessToken: vi.fn(),
  verifyAccessToken: vi.fn(),
  getMe: vi.fn(),
  verifyRefreshToken: vi.fn(),
  refreshAccessToken: vi.fn(),
  registerRefreshToken: vi.fn(),
  logout: vi.fn(),
  changePassword: vi.fn(),
  listUserSessions: vi.fn(),
  revokeUserSession: vi.fn(),
  buildParentPortalService: vi.fn(),
  assertSuperAdminDomain: vi.fn(),
  assertParentPortalEnabled: vi.fn(),
  updateMe: vi.fn(),
}));

vi.mock('../../src/shared/database/db.js', () => ({
  withTenantSchema: mocks.withTenantSchema,
}));

vi.mock('../../src/modules/auth/auth.service.js', () => ({
  login: mocks.login,
  signRefreshToken: mocks.signRefreshToken,
  signAccessToken: mocks.signAccessToken,
  verifyAccessToken: mocks.verifyAccessToken,
  getMe: mocks.getMe,
  verifyRefreshToken: mocks.verifyRefreshToken,
  refreshAccessToken: mocks.refreshAccessToken,
  registerRefreshToken: mocks.registerRefreshToken,
  logout: mocks.logout,
  changePassword: mocks.changePassword,
  listUserSessions: mocks.listUserSessions,
  revokeUserSession: mocks.revokeUserSession,
  assertSuperAdminDomain: mocks.assertSuperAdminDomain,
  assertParentPortalEnabled: mocks.assertParentPortalEnabled,
  updateMe: mocks.updateMe,
}));

vi.mock('../../src/modules/parent-portal/parent-portal.service.js', () => ({
  ParentPortalError: class ParentPortalError extends Error {
    statusCode = 400;
    code = 'BAD_REQUEST';
  },
  buildParentPortalService: mocks.buildParentPortalService,
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
  mocks.signAccessToken.mockResolvedValue('access-token-parent');
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
  mocks.registerRefreshToken.mockResolvedValue(undefined);
  mocks.logout.mockResolvedValue(undefined);
  mocks.changePassword.mockResolvedValue(undefined);
  mocks.listUserSessions.mockResolvedValue([
    {
      sessionId: '3e5d9f3c-2a5c-4d3e-a95f-2bb8244f3e31',
      createdAt: '2026-04-23T00:00:00.000Z',
      expiresAt: '2026-05-23T00:00:00.000Z',
      isCurrent: true,
      userAgent: 'vitest',
      ipAddress: '127.0.0.1',
    },
  ]);
  mocks.revokeUserSession.mockResolvedValue(true);
  mocks.buildParentPortalService.mockReturnValue({
    loginParent: vi.fn().mockResolvedValue({
      parentId: 'parent-1',
      studentIds: ['student-1'],
    }),
  });
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

  it('POST /api/v1/auth/login/teacher — header x-tenant-schema absent (fallback host) → 200', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login/teacher',
      headers: { host: 'localhost' },
      payload: { identifier: 'diallo.ibra', password: 'edutrack2024' },
    });

    expect(response.statusCode).toBe(200);
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

  it('POST /api/v1/auth/change-password — bon mot de passe actuel → 200', async () => {
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
        current_password: 'director2024',
        new_password: 'SecurePass1',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(parseBody(response.body)).toEqual({ message: 'Mot de passe mis à jour' });
    await app.close();
  });

  it('POST /api/v1/auth/change-password — mauvais mot de passe actuel → 401', async () => {
    mocks.verifyAccessToken.mockResolvedValue({
      sub: 'director-1',
      role: 'director',
      schemaName: 'tenant_demo',
    });
    mocks.changePassword.mockRejectedValue(new Error('Current password is incorrect'));
    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: { authorization: 'Bearer valid-token' },
      payload: {
        current_password: 'wrong-password',
        new_password: 'SecurePass1',
      },
    });

    expect(response.statusCode).toBe(401);
    expect(parseBody(response.body)).toEqual({ error: 'Mot de passe actuel incorrect' });
    await app.close();
  });

  it('GET /api/v1/auth/sessions — retourne la liste des sessions', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/sessions',
      headers: {
        authorization: 'Bearer valid-token',
        cookie: 'refresh_token=valid-refresh-token',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(parseBody(response.body)).toEqual({
      sessions: [
        {
          sessionId: '3e5d9f3c-2a5c-4d3e-a95f-2bb8244f3e31',
          createdAt: '2026-04-23T00:00:00.000Z',
          expiresAt: '2026-05-23T00:00:00.000Z',
          isCurrent: true,
          userAgent: 'vitest',
          ipAddress: '127.0.0.1',
        },
      ],
    });
    expect(mocks.listUserSessions).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('DELETE /api/v1/auth/sessions/:sessionId — revoke une session utilisateur', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/sessions/3e5d9f3c-2a5c-4d3e-a95f-2bb8244f3e31',
      headers: {
        authorization: 'Bearer valid-token',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(parseBody(response.body)).toEqual({ success: true });
    expect(mocks.revokeUserSession).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
