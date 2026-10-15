import { EvaluationReviewRepository } from './evaluation-review.repository.js';
import type { EvaluationReviewOptionsQuery, EvaluationReviewQuery, ReviewOption } from './evaluation-review.types.js';

export class EvaluationReviewError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
  }
}

export const assertOption = (id: string | undefined, options: ReviewOption[], label: string): void => {
  if (id && !options.some((option) => option.id === id)) {
    throw new EvaluationReviewError(`${label} incompatible avec la sélection`, 'INVALID_EVALUATION_SCOPE');
  }
};

export class EvaluationReviewService {
  constructor(private readonly repository: EvaluationReviewRepository) {}

  async options(query: EvaluationReviewOptionsQuery) {
    if (query.gradingPeriodId && (!query.schoolYearId || !await this.repository.periodBelongsToYear(query.gradingPeriodId, query.schoolYearId))) {
      throw new EvaluationReviewError('Période incompatible avec l’année scolaire', 'INVALID_EVALUATION_SCOPE');
    }
    const options = await this.repository.options(query);
    assertOption(query.schoolYearId, options.schoolYears, 'Année scolaire');
    assertOption(query.levelId, options.levels, 'Niveau');
    assertOption(query.classId, options.classes, 'Classe');
    assertOption(query.subjectId, options.subjects, 'Matière');
    return options;
  }

  async list(query: EvaluationReviewQuery) {
    await this.validateScope(query);
    return this.repository.list(query);
  }

  async listSpontaneous(query: EvaluationReviewQuery) {
    await this.validateScope(query);
    return this.repository.listSpontaneous(query);
  }

  async remind(evaluationId: string) {
    const result = await this.repository.remind(evaluationId);
    if (result === 'not_found') throw new EvaluationReviewError('Évaluation introuvable', 'EVALUATION_NOT_FOUND');
    if (result === 'not_due') throw new EvaluationReviewError('Relance indisponible pour cette évaluation', 'EVALUATION_NOT_DUE');
    if (result === 'too_soon') throw new EvaluationReviewError('Une relance a déjà été envoyée dans les dernières 24 h', 'EVALUATION_REMINDER_TOO_SOON');
    return { lastReminderAt: result };
  }

  private async validateScope(query: EvaluationReviewQuery): Promise<void> {
    const options = await this.options({ schoolYearId: query.schoolYearId, gradingPeriodId: query.gradingPeriodId,
      levelId: query.levelId, classId: query.classId, subjectId: query.subjectId });
    assertOption(query.teacherId, options.teachers, 'Professeur');
  }
}

export const buildEvaluationReviewService = (db: ConstructorParameters<typeof EvaluationReviewRepository>[0]) =>
  new EvaluationReviewService(new EvaluationReviewRepository(db));
