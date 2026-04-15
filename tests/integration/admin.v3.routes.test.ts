import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createSchool: vi.fn(),
  getAdminMetrics: vi.fn(),
  attachPublicDb: vi.fn(),
  releaseTenantDb: vi.fn(),
  authenticateRequest: vi.fn(),
  requireRole: vi.fn(),
}));

vi.mock('../../src/modules/admin/admin.service.js', async () => {
  const actual = await vi.importActual('../../src/modules/admin/admin.service.js');
  return {
    ...actual,
    createSchool: mocks.createSchool,
    getAdminMetrics: mocks.getAdminMetrics,
  };
});

vi.mock('../../src/shared/middleware/tenant.middleware.js', async () => {
  const actual = await vi.importActual('../../src/shared/middleware/tenant.middleware.js');
  return {
    ...actual,
    attachPublicDb: mocks.attachPublicDb,
    releaseTenantDb: mocks.releaseTenantDb,
  };
});

vi.mock('../../src/shared/middleware/auth.middleware.js', async () => {
  const actual = await vi.importActual('../../src/shared/middleware/auth.middleware.js');
  return {
    ...actual,
    authenticateRequest: mocks.authenticateRequest,
    requireRole: mocks.requireRole,
  };
});

vi.mock('../../src/shared/middleware/admin-audit.middleware.js', () => ({
  adminAuditOnSend: async (_request: unknown, _reply: unknown, payload: unknown) => payload,
}));

import adminController from '../../src/modules/admin/admin.controller.js';

const buildApp = async () => {
  const app = Fastify();
  await app.register(adminController);
  await app.ready();
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();

  mocks.attachPublicDb.mockImplementation(async (request: { db?: unknown }) => {
    request.db = { execute: vi.fn() };
  });
  mocks.releaseTenantDb.mockResolvedValue(undefined);
  mocks.authenticateRequest.mockResolvedValue(undefined);
  mocks.requireRole.mockReturnValue(async () => undefined);
});

describe('admin V3 routes', () => {
  it('POST /api/v1/admin/schools crée une école complète', async () => {
    mocks.createSchool.mockResolvedValue({
      tenantId: 'tenant-1',
      schoolSchemaName: 'school_test',
      directorCredentials: {
        userId: 'user-1',
        name: 'Directeur Test',
        phone: '2250700000001',
        email: 'directeur@test.ci',
        password: 'deadbeefdeadbeef',
      },
    });

    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/schools',
      payload: {
        name: 'Lycée Test',
        subdomain: 'lycee-test',
        city: 'Abidjan',
        teaching_type: 'secondaire',
        director_name: 'Directeur Test',
        director_phone: '2250700000001',
        director_email: 'directeur@test.ci',
        max_admin_positions: 7,
        plan: 'pro',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(mocks.createSchool).toHaveBeenCalledTimes(1);
    expect(response.json().tenantId).toBe('tenant-1');
    await app.close();
  });

  it('GET /api/v1/admin/metrics retourne des données réelles agrégées', async () => {
    mocks.getAdminMetrics.mockResolvedValue({
      totalSchools: 1,
      activeSchools: 1,
      mrrTotalFcfa: 120000,
      dauLast7d: [{ date: '2026-04-15', uniqueUsers: 12 }],
      schoolsByPlan: [{ plan: 'pro', count: 1 }],
    });

    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/metrics',
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.getAdminMetrics).toHaveBeenCalledTimes(1);
    expect(response.json().mrrTotalFcfa).toBe(120000);
    await app.close();
  });
});
