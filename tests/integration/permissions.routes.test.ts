import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSION_KEYS } from '../../src/modules/permissions/permissions.types.js';

const mocks = vi.hoisted(() => ({
  withTenantSchema: vi.fn(),
  verifyAccessToken: vi.fn(),
  dbExecute: vi.fn(),
}));

vi.mock('../../src/shared/database/db.js', () => ({
  withTenantSchema: mocks.withTenantSchema,
}));

vi.mock('../../src/modules/auth/auth.service.js', async () => {
  const actual = await vi.importActual('../../src/modules/auth/auth.service.js');
  return {
    ...actual,
    verifyAccessToken: mocks.verifyAccessToken,
  };
});

import permissionsController from '../../src/modules/permissions/permissions.controller.js';
import { requirePermission } from '../../src/shared/middleware/auth.middleware.js';

const buildApp = async () => {
  const app = Fastify();
  await app.register(permissionsController);
  app.post('/api/v1/billing/salary/compute', { preHandler: requirePermission('salary.compute') }, async () => {
    return { ok: true };
  });
  await app.ready();
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();

  mocks.dbExecute.mockResolvedValue({ rows: [] });
  mocks.withTenantSchema.mockImplementation(async (_schema, callback) => {
    return callback({ execute: mocks.dbExecute });
  });
  mocks.verifyAccessToken.mockResolvedValue({
    sub: 'staff-user-id',
    role: 'staff',
    schemaName: 'school_sainte_marie',
  });
});

describe('permissions routes', () => {
  it('GET /api/v1/permissions/me ne donne aucune permission implicite au staff sans poste assigné', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/permissions/me',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { role: string; permissions: string[] };
    expect(body.role).toBe('staff');
    expect(body.permissions).toEqual([]);

    await app.close();
  });

  it('POST /api/v1/billing/salary/compute refuse un staff (403)', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/salary/compute?month=2025-01',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body) as { code: string };
    expect(body.code).toBe('FORBIDDEN');

    await app.close();
  });

  it('POST /api/v1/billing/salary/compute autorise un director', async () => {
    mocks.verifyAccessToken.mockResolvedValue({
      sub: 'director-user-id',
      role: 'director',
      schemaName: 'school_sainte_marie',
    });

    const app = await buildApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/salary/compute?month=2025-01',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });

    await app.close();
  });

  it('GET /api/v1/permissions/me retourne toutes les permissions pour director', async () => {
    mocks.verifyAccessToken.mockResolvedValue({
      sub: 'director-user-id',
      role: 'director',
      schemaName: 'school_sainte_marie',
    });

    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/permissions/me',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { role: string; permissions: string[] };
    expect(body.role).toBe('director');
    expect(new Set(body.permissions)).toEqual(
      new Set(PERMISSION_KEYS.filter((permission) => permission !== 'settings.sms_templates'))
    );

    await app.close();
  });
});
