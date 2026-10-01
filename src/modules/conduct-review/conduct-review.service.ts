import { ConductReviewRepository } from './conduct-review.repository.js';

export class ConductReviewService {
  constructor(private readonly repository: ConductReviewRepository) {}

  async getTeacherActions(userId: string) {
    return { teacherActions: await this.repository.listTeacherActions(userId) };
  }

  async getDecisionWorkspace(context: { userId: string; canFinalize: boolean }) {
    const decisionScopes = await this.repository.listDecisionScopes(context.userId, context.canFinalize);
    return {
      decisionScopes,
      decisionActions: decisionScopes.filter((scope) =>
        scope.reviewOpen && !scope.isClosed && scope.pendingCount > 0 && scope.studentCount > 0),
    };
  }

}

export const buildConductReviewService = (db: ConstructorParameters<typeof ConductReviewRepository>[0]) =>
  new ConductReviewService(new ConductReviewRepository(db));
