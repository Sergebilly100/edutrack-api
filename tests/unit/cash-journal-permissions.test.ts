import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  exportAllowed: true,
  service: {
    getPaginatedCashJournal: vi.fn(async () => ({ entries: [], totals: {}, counts: { confirmed: 0, cancelled: 0 }, count: 0, pagination: {} })),
    exportCashJournalExcel: vi.fn(async () => Buffer.from('xlsx')),
  },
}));

vi.mock('../../src/shared/middleware/auth.middleware.js', () => {
  const attach = (request: { headers: Record<string, unknown>; claims?: unknown; permissions?: Set<string> }) => {
    request.claims = { schemaName: 'tenant_x' };
    request.permissions = new Set(String(request.headers['x-perms'] ?? '').split(',').filter(Boolean));
  };
  return {
    authenticateRequest: async (request: never) => attach(request),
    requireParent: async () => undefined,
    checkStudentAccess: async () => undefined,
    ParentAccessError: class extends Error {},
    requireAnyPermission: () => async (request: never) => attach(request),
    requirePermission: (permission: string) => async (request: { headers: Record<string, unknown> } & never, reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
      attach(request);
      if (!(request as { permissions: Set<string> }).permissions.has(permission)) reply.code(403).send({ error: 'forbidden' });
    },
  };
});
vi.mock('../../src/shared/database/db.js', () => ({
  db: { execute: async () => [{ allowed: state.exportAllowed }] },
  withTenantSchema: async (_schema: string, run: (db: unknown) => unknown) => run({}),
}));
vi.mock('../../src/modules/finance/finance.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  buildFinanceService: () => state.service,
}));

import financeController from '../../src/modules/finance/finance.controller.js';

const build = async () => {
  const app = Fastify();
  await app.register(financeController);
  return app;
};
const get = (app: Awaited<ReturnType<typeof build>>, url: string, perms: string) => app.inject({ method: 'GET', url, headers: { 'x-perms': perms } });

describe('cash journal – permissions', () => {
  beforeEach(() => { state.exportAllowed = true; vi.clearAllMocks(); });

  it('requires payments.view to read the journal', async () => {
    const app = await build();
    expect((await get(app, '/api/v1/payments/cash-journal', '')).statusCode).toBe(403);
  });

  it('does not include cancelled payments without payments.cancel', async () => {
    const app = await build();
    const response = await get(app, '/api/v1/payments/cash-journal', 'payments.view');
    expect(response.statusCode).toBe(200);
    expect(state.service.getPaginatedCashJournal).toHaveBeenCalledWith(expect.objectContaining({ includeCancelled: false, status: undefined }));
  });

  it('rejects an explicit cancelled filter without payments.cancel', async () => {
    const app = await build();
    const response = await get(app, '/api/v1/payments/cash-journal?status=cancelled', 'payments.view');
    expect(response.statusCode).toBe(403);
    expect(state.service.getPaginatedCashJournal).not.toHaveBeenCalled();
  });

  it('includes cancelled payments with payments.cancel', async () => {
    const app = await build();
    const response = await get(app, '/api/v1/payments/cash-journal?status=cancelled', 'payments.view,payments.cancel');
    expect(response.statusCode).toBe(200);
    expect(state.service.getPaginatedCashJournal).toHaveBeenCalledWith(expect.objectContaining({ includeCancelled: true, status: 'cancelled' }));
  });

  it('requires payments.view to export and forwards the cancelled scope', async () => {
    const app = await build();
    expect((await get(app, '/api/v1/payments/cash-journal/export?format=xlsx', '')).statusCode).toBe(403);
    const ok = await get(app, '/api/v1/payments/cash-journal/export?format=xlsx', 'payments.view');
    expect(ok.statusCode).toBe(200);
    expect(state.service.exportCashJournalExcel).toHaveBeenCalledWith(expect.objectContaining({ includeCancelled: false }));
  });

  it('refuses exports when the school disabled data export', async () => {
    state.exportAllowed = false;
    const app = await build();
    const response = await get(app, '/api/v1/payments/cash-journal/export?format=xlsx', 'payments.view');
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'EXPORT_DISABLED' });
    expect(state.service.exportCashJournalExcel).not.toHaveBeenCalled();
  });

  it('refuses a cancelled-only export without payments.cancel', async () => {
    const app = await build();
    const response = await get(app, '/api/v1/payments/cash-journal/export?format=xlsx&status=cancelled', 'payments.view');
    expect(response.statusCode).toBe(403);
  });
});
