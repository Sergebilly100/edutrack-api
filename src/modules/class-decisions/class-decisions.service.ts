import { ClassDecisionsRepository } from './class-decisions.repository.js';
import type {
  BulkClassDecisionsInput,
  BulkClassDecisionsPreview,
  ClassDecisionItem,
  ClassDecisionValue,
  LevelOption,
  ValidateClassDecisionInput,
} from './class-decisions.types.js';

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

  async listDecisions(filters: { levelId?: string; classId?: string } = {}, today?: string) {
    const schoolYear = await this.requireOpenReview(today);
    const [decisions, levels, classes] = await Promise.all([
      this.repository.listForSchoolYear(schoolYear.id, filters),
      this.repository.listLevels(),
      this.repository.listClasses(schoolYear.id),
    ]);
    return { schoolYear, decisions, levels, classes };
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

  private buildBulkPreview(
    decisions: ClassDecisionItem[],
    levels: LevelOption[],
    input: BulkClassDecisionsInput
  ): BulkClassDecisionsPreview {
    const levelNames = new Map(levels.map((level) => [level.id, level.name]));
    const items = decisions.map((decision) => {
      if (decision.generalAverage === null) {
        return {
          ...decision,
          proposedDecision: null,
          proposedNextLevelId: null,
          proposedNextLevelName: null,
          isEligible: false,
          blockingReason: 'GENERAL_AVERAGE_PENDING' as const,
        };
      }
      const rule = decision.generalAverage >= input.threshold ? input.atOrAbove : input.below;
      return {
        ...decision,
        proposedDecision: rule.finalDecision,
        proposedNextLevelId: rule.nextLevelId,
        proposedNextLevelName: rule.nextLevelId ? levelNames.get(rule.nextLevelId) ?? null : null,
        isEligible: true,
        blockingReason: null,
      };
    });
    const eligibleCount = items.filter((item) => item.isEligible).length;
    return {
      items,
      eligibleCount,
      pendingCount: items.length - eligibleCount,
      canApply: items.length > 0 && eligibleCount === items.length,
    };
  }

  private async getBulkPreview(
    schoolYearId: string,
    input: BulkClassDecisionsInput
  ): Promise<BulkClassDecisionsPreview> {
    const [decisions, levels] = await Promise.all([
      this.repository.listForSchoolYear(schoolYearId, {
        levelId: input.levelId,
        classId: input.classId,
      }),
      this.repository.listLevels(),
    ]);
    return this.buildBulkPreview(decisions, levels, input);
  }

  async previewBulkDecisions(input: BulkClassDecisionsInput, today?: string) {
    const schoolYear = await this.requireOpenReview(today);
    return this.getBulkPreview(schoolYear.id, input);
  }

  async validateBulkDecisions(
    input: BulkClassDecisionsInput,
    validatedByUserId: string,
    today?: string
  ) {
    const schoolYear = await this.requireOpenReview(today);
    const rules = [input.atOrAbove, input.below];
    if (rules.some((rule) => rule.finalDecision === 'promoted' && rule.nextLevelId === null)) {
      throw new ClassDecisionsModuleError(
        'Un niveau suivant est requis pour une décision d’admission',
        400,
        'PROMOTED_NEXT_LEVEL_REQUIRED'
      );
    }
    if (rules.some((rule) => rule.finalDecision === 'expelled' && rule.nextLevelId !== null)) {
      throw new ClassDecisionsModuleError(
        'Une exclusion ne peut pas comporter de niveau suivant',
        400,
        'EXPELLED_NEXT_LEVEL_FORBIDDEN'
      );
    }
    const nextLevelIds = [input.atOrAbove.nextLevelId, input.below.nextLevelId].filter(
      (levelId): levelId is string => levelId !== null
    );
    for (const levelId of nextLevelIds) {
      if (!(await this.repository.levelExists(levelId))) {
        throw new ClassDecisionsModuleError('Level not found', 400, 'NEXT_LEVEL_NOT_FOUND');
      }
    }
    const preview = await this.getBulkPreview(schoolYear.id, input);
    if (!preview.canApply) {
      throw new ClassDecisionsModuleError(
        'Toutes les moyennes générales doivent être finalisées avant la validation groupée',
        409,
        'GENERAL_AVERAGES_PENDING'
      );
    }
    if (preview.items.some(
      (item) => item.proposedDecision === 'repeat' && item.proposedNextLevelId !== item.currentLevelId
    )) {
      throw new ClassDecisionsModuleError(
        'Une décision de redoublement doit conserver le niveau actuel',
        400,
        'REPEAT_CURRENT_LEVEL_REQUIRED'
      );
    }
    await this.repository.validateBulkDecisions(
      preview.items.map((item) => ({
        studentId: item.studentId,
        schoolYearId: schoolYear.id,
        finalDecision: item.proposedDecision as ClassDecisionValue,
        nextLevelId: item.proposedNextLevelId,
        validatedByUserId,
      }))
    );
    return preview;
  }
}

export const buildClassDecisionsService = (
  db: ConstructorParameters<typeof ClassDecisionsRepository>[0]
): ClassDecisionsService => new ClassDecisionsService(new ClassDecisionsRepository(db));
