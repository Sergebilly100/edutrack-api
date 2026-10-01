import { describe, expect, it, vi } from 'vitest';
import { ConductReviewService } from '../../src/modules/conduct-review/conduct-review.service.js';
import type { ConductReviewRepository, DecisionScope } from '../../src/modules/conduct-review/conduct-review.repository.js';

const scope = (overrides: Partial<DecisionScope> = {}): DecisionScope => ({
  classId: 'class-1', className: '6e A', levelId: 'level-1', levelName: '6e',
  schoolYearId: 'year-1', schoolYearLabel: '2026-2027',
  gradingPeriodId: 'period-1', gradingPeriodLabel: 'T1',
  studentCount: 18, pendingCount: 12, reviewOpen: true, isClosed: false,
  ...overrides,
});

describe('ConductReviewService', () => {
  it('ne propose au décideur que les classes en revue avec décisions manquantes', async () => {
    const repository = {
      listTeacherActions: vi.fn().mockResolvedValue([]),
      listDecisionScopes: vi.fn().mockResolvedValue([
        scope(),
        scope({ classId: 'class-2', reviewOpen: false }),
        scope({ classId: 'class-3', isClosed: true }),
        scope({ classId: 'class-4', pendingCount: 0 }),
        scope({ classId: 'class-5', studentCount: 0 }),
      ]),
    } as unknown as ConductReviewRepository;
    const service = new ConductReviewService(repository);

    const result = await service.getWorkspace({ userId: 'user-1', canFinalize: true });

    expect(result.decisionActions).toEqual([scope()]);
    expect(result.decisionScopes).toHaveLength(5);
    expect(repository.listDecisionScopes).toHaveBeenCalledWith('user-1', true);
  });
});
