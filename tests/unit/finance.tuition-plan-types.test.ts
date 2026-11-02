import { describe, expect, it } from 'vitest';
import { upsertTuitionPlanBodySchema } from '../../src/modules/finance/finance.types.js';

describe('tuition plan registration amount', () => {
  it('defaults the new field for existing API clients', () => {
    expect(upsertTuitionPlanBodySchema.parse({
      schoolYearId: '550e8400-e29b-41d4-a716-446655440000',
      totalAmount: 100_000,
    })).toMatchObject({
      registrationAmount: 0,
      currency: 'FCFA',
      scheduleSteps: [],
    });
  });

  it('rejects negative registration amounts', () => {
    expect(upsertTuitionPlanBodySchema.safeParse({
      schoolYearId: '550e8400-e29b-41d4-a716-446655440000',
      totalAmount: 100_000,
      registrationAmount: -1,
    }).success).toBe(false);
  });
});
