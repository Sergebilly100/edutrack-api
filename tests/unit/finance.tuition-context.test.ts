import { describe, expect, it, vi } from 'vitest';
import { FinanceService } from '../../src/modules/finance/finance.service.js';
import type { FinanceRepository } from '../../src/modules/finance/finance.repository.js';

describe('missing tuition context', () => {
  it('uses the server scope, including enrollment class, without calculating an amount', async () => {
    const context = { schoolYearId: 'year', schoolYearLabel: '2026-2027', levelId: 'level', levelName: 'Sixième' };
    const repository = {
      getAmountDueContext: vi.fn().mockResolvedValue(null),
      listMandatorySubscriptionPlans: vi.fn().mockResolvedValue([]),
      getTuitionPlanRequiredContext: vi.fn().mockResolvedValue(context),
    };
    const service = new FinanceService(repository as unknown as FinanceRepository);
    await expect(service.getAmountDue('student', 'year')).rejects.toMatchObject({ statusCode: 409, code: 'TUITION_PLAN_REQUIRED', context });
    expect(repository.getTuitionPlanRequiredContext).toHaveBeenCalledWith('student', 'year');
  });
})
