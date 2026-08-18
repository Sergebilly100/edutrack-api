import { ClassDecisionsRepository } from './class-decisions.repository.js';
import type { ValidateClassDecisionInput } from './class-decisions.types.js';

export class ClassDecisionsModuleError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string
  ) {
    super(message);
    this.name = 'ClassDecisionsModuleError';
  }
}

export const isEndOfYearReviewVisible = (reviewStartDate: string, today: string): boolean =>
  today >= reviewStartDate;

const currentIsoDate = (): string => new Date().toISOString().slice(0, 10);

export class ClassDecisionsService {
  constructor(private readonly repository: ClassDecisionsRepository) {}

  async getReviewStatus(today = currentIsoDate()) {
    const activeSchoolYear = await this.repository.getActiveSchoolYear();
    return {
      visible: activeSchoolYear
        ? isEndOfYearReviewVisible(activeSchoolYear.endOfYearReviewStartDate, today)
        : false,
      activeSchoolYear,
    };
  }

  private async requireOpenReview(today = currentIsoDate()) {
    const status = await this.getReviewStatus(today);
    if (!status.activeSchoolYear) {
      throw new ClassDecisionsModuleError(
        'No active school year is configured',
        409,
        'ACTIVE_SCHOOL_YEAR_REQUIRED'
      );
    }
    if (!status.visible) {
      throw new ClassDecisionsModuleError(
        'End-of-year review has not started',
        403,
        'END_OF_YEAR_REVIEW_NOT_OPEN'
      );
    }
    return status.activeSchoolYear;
  }

  async listDecisions(today?: string) {
    const schoolYear = await this.requireOpenReview(today);
    const [decisions, levels] = await Promise.all([
      this.repository.listForSchoolYear(schoolYear.id),
      this.repository.listLevels(),
    ]);
    return { schoolYear, decisions, levels };
  }

  async validateDecision(
    studentId: string,
    input: ValidateClassDecisionInput,
    validatedByUserId: string,
    today?: string
  ) {
    const schoolYear = await this.requireOpenReview(today);
    if (input.nextLevelId && !(await this.repository.levelExists(input.nextLevelId))) {
      throw new ClassDecisionsModuleError('Level not found', 400, 'NEXT_LEVEL_NOT_FOUND');
    }
    const decision = await this.repository.validateDecision({
      studentId,
      schoolYearId: schoolYear.id,
      finalDecision: input.finalDecision,
      nextLevelId: input.nextLevelId,
      validatedByUserId,
    });
    if (!decision) {
      throw new ClassDecisionsModuleError(
        'Student not found in the active school year',
        404,
        'STUDENT_NOT_FOUND'
      );
    }
    return decision;
  }
}

export const buildClassDecisionsService = (
  db: ConstructorParameters<typeof ClassDecisionsRepository>[0]
): ClassDecisionsService => new ClassDecisionsService(new ClassDecisionsRepository(db));
