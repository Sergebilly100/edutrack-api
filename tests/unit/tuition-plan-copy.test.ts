import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  upsert: vi.fn(async () => ({})),
  recalcAll: vi.fn(async () => ({ schoolYearId: 'y', studentCount: 0 })),
  service: {
    preview: vi.fn(async () => ({ targets: [] })),
    copy: vi.fn(async () => ({ results: [], cacheRefreshed: true })),
  },
}));

vi.mock('../../src/modules/finance/finance.repository.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/modules/finance/finance.repository.js')>();
  class FakeRepository { constructor(readonly db: unknown) {} upsertTuitionPlan = state.upsert; }
  return { ...original, FinanceRepository: FakeRepository };
});
vi.mock('../../src/modules/finance/financial-cache.service.js', () => ({
  FinancialCacheService: class { recalcAll = state.recalcAll; },
}));
vi.mock('../../src/modules/finance/financial-cache.repository.js', () => ({ FinancialCacheRepository: class {} }));
vi.mock('../../src/shared/middleware/auth.middleware.js', () => {
  const attach = (request: { headers: Record<string, unknown>; claims?: unknown; permissions?: Set<string> }) => {
    request.claims = { schemaName: 'tenant_x', role: 'director' };
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
  db: { execute: async () => [{ allowed: true }] },
  withTenantSchema: async (_schema: string, run: (db: unknown) => unknown) => run({}),
}));
vi.mock('../../src/modules/finance/tuition-plan-copy.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  buildTuitionPlanCopyService: () => state.service,
}));

import financeController from '../../src/modules/finance/finance.controller.js';
import { TuitionPlanCopyService } from '../../src/modules/finance/tuition-plan-copy.js';

const SOURCE = '11111111-1111-4111-8111-111111111111';
const YEAR = '22222222-2222-4222-8222-222222222222';
const L1 = '33333333-3333-4333-8333-333333333331';
const L2 = '33333333-3333-4333-8333-333333333332';
const L3 = '33333333-3333-4333-8333-333333333333';

const plan = { totalAmount: 300000, registrationAmount: 50000, currency: 'FCFA', scheduleSteps: [{ dueDate: '2026-10-01', cumulativeAmountExpected: 100000 }, { dueDate: '2027-01-10', cumulativeAmountExpected: 300000 }] };
const target = (levelId: string, extra: Record<string, unknown> = {}) => ({ levelId, levelName: `N-${levelId.slice(-1)}`, existingPlan: null, enrolledStudents: 0, studentsWithIndividualTerms: 0, ...extra });

type Internals = { loadYear: unknown; loadSource: unknown; loadTargetStates: unknown };
const build = (options: { yearStatus?: string; states?: Record<string, ReturnType<typeof target> | undefined>; sourcePlan?: boolean } = {}) => {
  const db = { transaction: async (run: (tx: unknown) => unknown) => run({}) };
  const service = new TuitionPlanCopyService(db as never);
  const internals = service as unknown as Internals;
  internals.loadYear = async () => ({ label: '2026-2027', status: options.yearStatus ?? 'active' });
  internals.loadSource = async () => {
    if (options.sourcePlan === false) throw Object.assign(new Error('absent'), { code: 'SOURCE_PLAN_NOT_FOUND', statusCode: 404 });
    return { levelName: 'Source', plan };
  };
  internals.loadTargetStates = async (_db: unknown, _year: string, ids?: string[]) => (ids ?? []).map((id) => options.states?.[id] ?? target(id));
  return service;
};
const input = (targets: Array<Record<string, unknown>>) => ({ schoolYearId: YEAR, targets } as never);

describe('TuitionPlanCopyService.copy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('copie vers un niveau vierge avec montants et échéances identiques', async () => {
    const result = await build().copy(SOURCE, input([{ levelId: L1, overwrite: false, confirmEnrolled: false }]));
    expect(result.results).toEqual([{ levelId: L1, levelName: 'N-1', status: 'copied' }]);
    expect(state.upsert).toHaveBeenCalledWith(L1, { schoolYearId: YEAR, ...plan });
    expect(state.recalcAll).toHaveBeenCalledTimes(1);
    expect(result.cacheRefreshed).toBe(true);
  });

  it('n’écrase rien par défaut : un niveau qui a déjà des frais est ignoré', async () => {
    const service = build({ states: { [L1]: target(L1, { existingPlan: plan }) } });
    const result = await service.copy(SOURCE, input([{ levelId: L1, overwrite: false, confirmEnrolled: false }]));
    expect(result.results[0]).toMatchObject({ status: 'skipped', code: 'PLAN_EXISTS' });
    expect(state.upsert).not.toHaveBeenCalled();
    expect(state.recalcAll).not.toHaveBeenCalled();
  });

  it('écrase le plan existant uniquement avec la confirmation explicite du niveau', async () => {
    const service = build({ states: { [L1]: target(L1, { existingPlan: plan }), [L2]: target(L2, { existingPlan: plan }) } });
    const result = await service.copy(SOURCE, input([
      { levelId: L1, overwrite: true, confirmEnrolled: false },
      { levelId: L2, overwrite: false, confirmEnrolled: false },
    ]));
    expect(result.results.map((item) => item.status)).toEqual(['copied', 'skipped']);
    expect(state.upsert).toHaveBeenCalledTimes(1);
    expect(state.upsert).toHaveBeenCalledWith(L1, expect.anything());
  });

  it('exige une confirmation quand des élèves sont inscrits sur le niveau cible', async () => {
    const service = build({ states: { [L1]: target(L1, { enrolledStudents: 12, studentsWithIndividualTerms: 2 }) } });
    const refused = await service.copy(SOURCE, input([{ levelId: L1, overwrite: false, confirmEnrolled: false }]));
    expect(refused.results[0]).toMatchObject({ status: 'skipped', code: 'ENROLLED_CONFIRMATION_REQUIRED' });
    expect((refused.results[0] as { message: string }).message).toContain('12 élève(s)');
    expect(state.upsert).not.toHaveBeenCalled();
    const accepted = await service.copy(SOURCE, input([{ levelId: L1, overwrite: false, confirmEnrolled: true }]));
    expect(accepted.results[0]).toMatchObject({ status: 'copied' });
  });

  it('un échec sur un niveau n’annule pas les autres (résultat par niveau)', async () => {
    state.upsert.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '23503' }));
    const result = await build().copy(SOURCE, input([
      { levelId: L1, overwrite: false, confirmEnrolled: false },
      { levelId: L2, overwrite: false, confirmEnrolled: false },
      { levelId: L3, overwrite: false, confirmEnrolled: false },
    ]));
    expect(result.results.map((item) => item.status)).toEqual(['error', 'copied', 'copied']);
    expect(result.results[0]).toMatchObject({ levelId: L1, code: '23503' });
    expect(state.recalcAll).toHaveBeenCalledTimes(1);
  });

  it('refuse un niveau source parmi les cibles, des doublons ou une année non ouverte', async () => {
    await expect(build().copy(SOURCE, input([{ levelId: SOURCE }]))).rejects.toMatchObject({ code: 'INVALID_COPY_TARGETS', statusCode: 400 });
    await expect(build().copy(SOURCE, input([{ levelId: L1 }, { levelId: L1 }]))).rejects.toMatchObject({ code: 'INVALID_COPY_TARGETS' });
    await expect(build({ yearStatus: 'closed' }).copy(SOURCE, input([{ levelId: L1 }]))).rejects.toMatchObject({ code: 'SCHOOL_YEAR_NOT_OPEN', statusCode: 409 });
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it('refuse de copier un niveau source sans plan', async () => {
    await expect(build({ sourcePlan: false }).copy(SOURCE, input([{ levelId: L1 }]))).rejects.toMatchObject({ code: 'SOURCE_PLAN_NOT_FOUND', statusCode: 404 });
  });

  it('signale quand le cache financier n’a pas pu être recalculé, sans annuler les copies', async () => {
    state.recalcAll.mockRejectedValueOnce(new Error('cache'));
    const result = await build().copy(SOURCE, input([{ levelId: L1 }]));
    expect(result.results[0]).toMatchObject({ status: 'copied' });
    expect(result.cacheRefreshed).toBe(false);
  });
});

describe('routes de copie des frais – permission', () => {
  const build = async () => { const app = Fastify(); await app.register(financeController); return app; };
  beforeEach(() => vi.clearAllMocks());

  it('exige tuition.edit (aperçu et copie)', async () => {
    const app = await build();
    const preview = `/api/v1/tuition-plans/levels/${SOURCE}/copy-preview?school_year_id=${YEAR}`;
    const copy = `/api/v1/tuition-plans/levels/${SOURCE}/copy`;
    const body = { schoolYearId: YEAR, targets: [{ levelId: L1 }] };
    for (const perms of ['', 'tuition.view']) {
      expect((await app.inject({ method: 'GET', url: preview, headers: { 'x-perms': perms } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: copy, headers: { 'x-perms': perms }, payload: body })).statusCode).toBe(403);
    }
    expect(state.service.preview).not.toHaveBeenCalled();
    expect(state.service.copy).not.toHaveBeenCalled();
    expect((await app.inject({ method: 'GET', url: preview, headers: { 'x-perms': 'tuition.edit' } })).statusCode).toBe(200);
    const ok = await app.inject({ method: 'POST', url: copy, headers: { 'x-perms': 'tuition.edit' }, payload: body });
    expect(ok.statusCode).toBe(200);
    expect(state.service.copy).toHaveBeenCalledWith(SOURCE, { schoolYearId: YEAR, targets: [{ levelId: L1, overwrite: false, confirmEnrolled: false }] });
  });

  it('rejette une requête sans cible', async () => {
    const app = await build();
    const response = await app.inject({ method: 'POST', url: `/api/v1/tuition-plans/levels/${SOURCE}/copy`, headers: { 'x-perms': 'tuition.edit' }, payload: { schoolYearId: YEAR, targets: [] } });
    expect(response.statusCode).toBe(400);
  });
});
