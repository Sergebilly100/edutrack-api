import { ConductReviewRepository } from './conduct-review.repository.js';

export class ConductReviewService {
  constructor(private readonly repository: ConductReviewRepository) {}

  async getWorkspace(context: { userId: string; canFinalize: boolean }) {
    const [teacherActions, decisionScopes] = await Promise.all([
      this.repository.listTeacherActions(context.userId),
      this.repository.listDecisionScopes(context.userId, context.canFinalize),
    ]);
    return {
      teacherActions,
      decisionScopes,
      decisionActions: decisionScopes.filter((scope) =>
        scope.reviewOpen && !scope.isClosed && scope.pendingCount > 0 && scope.studentCount > 0),
    };
  }

}

export const buildConductReviewService = (db: ConstructorParameters<typeof ConductReviewRepository>[0]) =>
  new ConductReviewService(new ConductReviewRepository(db));
