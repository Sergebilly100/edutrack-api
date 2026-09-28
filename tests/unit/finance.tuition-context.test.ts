import { describe, expect, it, vi } from 'vitest';
import { FinanceService } from '../../src/modules/finance/finance.service.js';
import type { FinanceRepository } from '../../src/modules/finance/finance.repository.js';

describe('missing tuition context', () => {
  it('uses the server scope, including enrollment class, without calculating an amount', async () => {
    const context = { schoolYearId: 'year', schoolYearLabel: '2026-2027', levelId: 'level', levelName: 'Sixième' };
    const repository = {
      getAmountDueContext: vi.fn().mockResolvedValue(null),
      hasConfirmedEnrollment: vi.fn().mockResolvedValue(true),
      listMandatorySubscriptionPlans: vi.fn().mockResolvedValue([]),
      getTuitionPlanRequiredContext: vi.fn().mockResolvedValue(context),
    };
    const service = new FinanceService(repository as unknown as FinanceRepository);
    await expect(service.getAmountDue('student', 'year')).rejects.toMatchObject({ statusCode: 409, code: 'TUITION_PLAN_REQUIRED', context });
    expect(repository.getTuitionPlanRequiredContext).toHaveBeenCalledWith('student', 'year', false);
  });

  it('rejects a student without a confirmed enrollment before exposing tuition data', async () => {
    const repository = {
      getAmountDueContext: vi.fn().mockResolvedValue(null),
      listMandatorySubscriptionPlans: vi.fn().mockResolvedValue([]),
      hasConfirmedEnrollment: vi.fn().mockResolvedValue(false),
      getTuitionPlanRequiredContext: vi.fn(),
    };
    const service = new FinanceService(repository as unknown as FinanceRepository);
    await expect(service.getAmountDue('student', 'year')).rejects.toMatchObject({
      statusCode: 409, code: 'CONFIRMED_ENROLLMENT_REQUIRED',
    });
    expect(repository.getTuitionPlanRequiredContext).not.toHaveBeenCalled();
  });

  it('previews a pending enrollment only for its confirmation flow', async () => {
    const repository = {
      getAmountDueContext: vi.fn().mockResolvedValue({
        student_id: 'student', student_name: 'Awa', student_matricule: null,
        class_id: 'class', class_name: '6e', school_year_id: 'year', plan_id: 'plan',
        plan_total_amount: '100000', currency: 'FCFA', override_total_amount: null, discount_amount: null,
      }),
      listMandatorySubscriptionPlans: vi.fn().mockResolvedValue([]),
      getPaymentCoverage: vi.fn().mockResolvedValue({ confirmedPaid: 25000, waivedAmount: 10000 }),
    };
    const service = new FinanceService(repository as unknown as FinanceRepository);
    await expect(service.getEnrollmentPaymentPreview('student', 'year')).resolves.toMatchObject({
      totalDue: 100000, confirmedPaid: 25000, remainingDue: 65000,
    });
    expect(repository.getAmountDueContext).toHaveBeenCalledWith('student', 'year', true);
  });
})
