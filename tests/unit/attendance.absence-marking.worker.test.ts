import { describe, it, expect, beforeEach, vi } from 'vitest';

const schemaIsProvisioned = vi.fn();
const withTenantSchema = vi.fn();
const markMissingAttendancesAsAbsent = vi.fn();

vi.mock('../../src/shared/database/db.js', () => ({
  schemaIsProvisioned: (...args: unknown[]) => schemaIsProvisioned(...args),
  withTenantSchema: (...args: unknown[]) => withTenantSchema(...args),
}));

vi.mock('../../src/modules/attendance/attendance.service.js', () => ({
  buildAttendanceService: () => ({
    markMissingAttendancesAsAbsent: () => markMissingAttendancesAsAbsent(),
  }),
}));

vi.mock('../../src/shared/observability/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { runAbsenceMarkingForSchema } from '../../src/modules/attendance/attendance.absence-marking.worker.js';

describe('runAbsenceMarkingForSchema', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // withTenantSchema exécute la callback avec un faux tenantDb
    withTenantSchema.mockImplementation(async (_schema: string, cb: (db: unknown) => Promise<unknown>) =>
      cb({})
    );
  });

  it('ignore proprement un schéma non provisionné sans throw', async () => {
    schemaIsProvisioned.mockResolvedValue(false);

    const result = await runAbsenceMarkingForSchema({ schemaName: 'school_inexistant' });

    expect(result).toEqual({ marked: 0, skipped: true });
    expect(withTenantSchema).not.toHaveBeenCalled();
    expect(markMissingAttendancesAsAbsent).not.toHaveBeenCalled();
  });

  it('exécute le marquage sur un schéma provisionné', async () => {
    schemaIsProvisioned.mockResolvedValue(true);
    markMissingAttendancesAsAbsent.mockResolvedValue(9);

    const result = await runAbsenceMarkingForSchema({ schemaName: 'school_sainte_marie' });

    expect(result).toEqual({ marked: 9 });
    expect(withTenantSchema).toHaveBeenCalledOnce();
    expect(markMissingAttendancesAsAbsent).toHaveBeenCalledOnce();
  });
});
