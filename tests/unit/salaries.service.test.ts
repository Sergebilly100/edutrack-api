import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  on: vi.fn(),
  withTenantSchema: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('../../src/shared/events/event-bus.js', () => ({
  on: mocks.on,
}));

vi.mock('../../src/shared/database/db.js', () => ({
  withTenantSchema: mocks.withTenantSchema,
}));

vi.mock('../../src/shared/observability/logger.js', () => ({
  logger: { error: mocks.loggerError },
}));

import { registerSalaryEventListeners } from '../../src/modules/salaries/salaries.service.js';

const tenantDb = { execute: vi.fn() };
const handlers = new Map<string, (payload: unknown) => void>();
const checkoutPayload = {
  schemaName: 'school_test',
  teacherId: '00000000-0000-4000-8000-000000000001',
  monthStart: '2026-04-01',
  monthEnd: '2026-04-30',
};

describe('SalariesService event listeners', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();

    mocks.on.mockImplementation((event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler);
    });
    mocks.withTenantSchema.mockImplementation(
      (_schemaName: string, callback: (db: typeof tenantDb) => Promise<unknown>) =>
        callback(tenantDb)
    );

    registerSalaryEventListeners();
  });

  it('ignores a checkout when no salary record exists for the month', async () => {
    tenantDb.execute
      .mockResolvedValueOnce({ rows: [{ id: checkoutPayload.teacherId }] })
      .mockResolvedValueOnce({ rows: [] });

    handlers.get('teacher.checkout_completed')?.(checkoutPayload);

    await vi.waitFor(() => {
      expect(tenantDb.execute).toHaveBeenCalledTimes(2);
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mocks.loggerError).not.toHaveBeenCalled();
  });

  it('logs unexpected checkout recalculation failures without rejecting the event', async () => {
    mocks.withTenantSchema.mockRejectedValue(new Error('database unavailable'));

    handlers.get('teacher.checkout_completed')?.(checkoutPayload);

    await vi.waitFor(() => {
      expect(mocks.loggerError).toHaveBeenCalledWith(
        expect.objectContaining({
          schemaName: checkoutPayload.schemaName,
          teacherId: checkoutPayload.teacherId,
        }),
        '[salaries] teacher.checkout_completed listener failed (non-blocking)'
      );
    });
  });
});
