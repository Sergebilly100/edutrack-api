import { ReportCardsRepository } from './report-cards.repository.js';
import type { ReportCardPdfPayload, ReportCardLinePayload } from '../../shared/pdf/index.js';
import type { ClassReadiness, ReportCardDetail } from './report-cards.types.js';

export class ReportCardsModuleError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string
  ) {
    super(message);
    this.name = 'ReportCardsModuleError';
  }
}

// ── Fonctions pures de calcul (snapshot) ────────────────────────────────────

/** Rangs en classement compétitif : ex aequo partagent le même rang. */
export const computeRankMap = (entries: Array<{ key: string; value: number }>): Map<string, number> => {
  const sorted = [...entries].sort((a, b) => b.value - a.value);
  const ranks = new Map<string, number>();
  let currentRank = 1;
  let previousValue: number | null = null;
  for (const [index, entry] of sorted.entries()) {
    if (previousValue !== null && entry.value !== previousValue) {
      currentRank = index + 1;
    }
    ranks.set(entry.key, currentRank);
    previousValue = entry.value;
  }
  return ranks;
};

export type ClassStats = {
  average: number;
  min: number;
  max: number;
  headcount: number;
};

export const computeClassStats = (averages: number[]): ClassStats | null => {
  if (averages.length === 0) return null;
  const total = averages.reduce((sum, value) => sum + value, 0);
  return {
    average: Math.round((total / averages.length) * 1000) / 1000,
    min: Math.min(...averages),
    max: Math.max(...averages),
    headcount: averages.length,
  };
};

export class ReportCardsService {
  constructor(private readonly repository: ReportCardsRepository) {}

  async generateForClass(classId: string, gradingPeriodId: string): Promise<{ generatedCount: number }> {
    const klass = await this.repository.findClassContext(classId);
    if (!klass) {
      throw new ReportCardsModuleError('Classe introuvable', 404, 'CLASS_NOT_FOUND');
    }

    const period = await this.repository.findGradingPeriod(gradingPeriodId);
    if (!period || period.schoolYearId !== klass.schoolYearId) {
      throw new ReportCardsModuleError('Période introuvable pour cette classe', 404, 'GRADING_PERIOD_NOT_FOUND');
    }

    const roster = await this.repository.listClassStudents(classId);
    const stats = computeClassStats(
      (await this.repository.listGeneralAverages(classId, gradingPeriodId)).map((row) => row.average)
    );
    // Les statistiques de classe portent sur les élèves notés ; l'effectif
    // affiché reste celui de la classe entière si plus grand.
    if (!stats) {
      throw new ReportCardsModuleError(
        'Aucune moyenne générale calculée pour cette classe et cette période',
        409,
        'NO_AVERAGES_COMPUTED'
      );
    }

    const generalAverages = await this.repository.listGeneralAverages(classId, gradingPeriodId);
    const subjectAverages = await this.repository.listSubjectAverages(classId, gradingPeriodId);
    const levelSubjects = await this.repository.listLevelSubjects(klass.levelId);
    const isLastPeriod = await this.repository.isLastPeriodOfYear(klass.schoolYearId, gradingPeriodId);

    const generalRanks = computeRankMap(generalAverages.map((row) => ({ key: row.studentId, value: row.average })));

    // Rang par matière au sein de la classe.
    const subjectRanks = new Map<string, Map<string, number>>();
    for (const subject of levelSubjects) {
      const entries = subjectAverages
        .filter((row) => row.subjectId === subject.id)
        .map((row) => ({ key: row.studentId, value: row.average }));
      subjectRanks.set(subject.id, computeRankMap(entries));
    }

    const headcount = Math.max(stats.headcount, roster.length);
    let generatedCount = 0;
    let skippedPublished = 0;

    for (const student of roster) {
      const existingCard = await this.repository.findExistingCard(student.id, gradingPeriodId);
      if (existingCard?.status === 'published') {
        // Un bulletin publié ne change jamais : on passe à l'élève suivant.
        skippedPublished += 1;
        continue;
      }

      const studentGeneral = generalAverages.find((row) => row.studentId === student.id);
      if (!studentGeneral) continue; // élève sans moyennes : rien à figer

      const lines: Array<{
        subjectId: string | null;
        lineType: 'subject' | 'conduct';
        average: number;
        coefficient: number;
        rank: number | null;
      }> = [];

      for (const subject of levelSubjects) {
        const entry = subjectAverages.find((row) => row.studentId === student.id && row.subjectId === subject.id);
        if (!entry) continue;
        lines.push({
          subjectId: subject.id,
          lineType: 'subject',
          average: entry.average,
          coefficient: subject.coefficient,
          rank: subjectRanks.get(subject.id)?.get(student.id) ?? null,
        });
      }

      const conduct = await this.repository.findConductGrade(student.id, gradingPeriodId);
      if (conduct) {
        lines.push({
          subjectId: null,
          lineType: 'conduct',
          average: conduct.note,
          coefficient: conduct.coefficient,
          rank: null,
        });
      }

      let decisionId: string | null = null;
      if (isLastPeriod) {
        const decision = await this.repository.findValidatedDecision(student.id, klass.schoolYearId);
        decisionId = decision?.id ?? null;
      }

      await this.repository.replaceGeneratedCard({
        studentId: student.id,
        classId,
        gradingPeriodId,
        generalAverage: studentGeneral.average,
        rank: generalRanks.get(student.id) ?? headcount,
        classAverage: stats.average,
        classMinAverage: stats.min,
        classMaxAverage: stats.max,
        classHeadcount: headcount,
        classDecisionId: decisionId,
        lines,
      });
      generatedCount += 1;
    }

    if (generatedCount === 0 && skippedPublished === 0) {
      throw new ReportCardsModuleError(
        'Aucun bulletin généré : aucune moyenne disponible pour cette classe',
        409,
        'NOTHING_TO_GENERATE'
      );
    }

    return { generatedCount };
  }

  async publish(cardId: string, userId: string): Promise<void> {
    await this.repository.publishCard(cardId, userId);
  }

  async listClassCards(classId: string, gradingPeriodId: string) {
    return this.repository.listCardsOfClass(classId, gradingPeriodId);
  }

  async publishBulk(classId: string, gradingPeriodId: string, userId: string): Promise<{ publishedCount: number }> {
    const cardIds = await this.repository.listPublishableCardsOfClass(classId, gradingPeriodId);
    for (const id of cardIds) {
      await this.repository.publishCard(id, userId);
    }
    return { publishedCount: cardIds.length };
  }

  async getClassReadiness(gradingPeriodId: string, schoolYearId: string): Promise<ClassReadiness[]> {
    const classes = await this.repository.listClassReadiness(gradingPeriodId, schoolYearId);
    const completions = await this.repository.listCompletionForYear(schoolYearId);

    return classes.map((row) => {
      const subjects = completions
        .filter((entry) => entry.class_id === row.class_id)
        .map((entry) => ({
          subjectId: entry.subject_id,
          subjectName: '',
          completedCount: entry.completed_count,
          expectedCount: row.headcount,
          complete: entry.completed_count >= row.headcount && row.headcount > 0,
        }));

      return {
        classId: row.class_id,
        className: row.class_name,
        headcount: row.headcount,
        studentsWithGeneralAverage: row.with_general,
        subjects,
        readyToGenerate: row.headcount > 0 && row.with_general >= row.headcount,
      };
    });
  }

  async getReadinessForPeriod(gradingPeriodId: string): Promise<ClassReadiness[]> {
    const period = await this.repository.findGradingPeriod(gradingPeriodId);
    if (!period) {
      throw new ReportCardsModuleError('Période introuvable', 404, 'GRADING_PERIOD_NOT_FOUND');
    }
    return this.getClassReadiness(gradingPeriodId, period.schoolYearId);
  }

  /** Payload du PDF (snapshot figé), consommé par le worker pdf-exports. */
  async getPdfPayload(cardId: string): Promise<ReportCardPdfPayload> {
    const card = await this.getDetail(cardId);

    const lines: ReportCardLinePayload[] = card.lines.map((line) => ({
      label: line.subjectName ?? 'Conduite',
      average: line.average,
      coefficient: line.coefficient,
      rank: line.rank,
      isConduct: line.lineType === 'conduct',
    }));

    return {
      studentName: card.studentName,
      className: card.className,
      periodLabel: card.periodLabel,
      schoolYearLabel: '',
      generalAverage: card.generalAverage,
      generalRank: card.rank,
      classHeadcount: card.classHeadcount,
      classAverage: card.classAverage,
      classMinAverage: card.classMinAverage,
      classMaxAverage: card.classMaxAverage,
      yearEndDecisionLabel:
        card.yearEndDecision === null
          ? null
          : card.yearEndDecision.decision === 'promoted'
            ? 'Admis(e)'
            : card.yearEndDecision.decision === 'repeat'
              ? 'Redouble'
              : 'Exclu(e)',
      lines,
    };
  }

  async listPublishedForStudent(studentId: string) {
    return this.repository.listPublishedSummariesForStudent(studentId);
  }

  async getPublishedDetail(studentId: string, cardId: string): Promise<ReportCardDetail> {
    const detail = await this.getDetail(cardId);
    if (detail.status !== 'published' || detail.studentId !== studentId) {
      throw new ReportCardsModuleError(
        'Ce bulletin n\u2019est pas publié ou ne correspond pas à cet élève',
        403,
        'REPORT_CARD_NOT_PUBLISHED'
      );
    }
    return detail;
  }

  async getDetail(cardId: string): Promise<ReportCardDetail> {
    const card = await this.repository.findCardDetail(cardId);
    if (!card) {
      throw new ReportCardsModuleError('Bulletin introuvable', 404, 'REPORT_CARD_NOT_FOUND');
    }

    const lines = await this.repository.listCardLines(cardId);

    return {
      id: card.id,
      studentId: card.student_id,
      studentName: card.student_name,
      classId: card.class_id,
      className: card.class_name,
      gradingPeriodId: card.grading_period_id,
      periodLabel: card.period_label,
      generalAverage: Number(card.general_average),
      rank: card.rank,
      classAverage: Number(card.class_average),
      classMinAverage: Number(card.class_min_average),
      classMaxAverage: Number(card.class_max_average),
      classHeadcount: card.class_headcount,
      yearEndDecision:
        card.decision === null ? null : { decision: card.decision as 'promoted' | 'repeat' | 'expelled' },
      status: card.status as 'generated' | 'published',
      generatedAt: card.generated_at,
      publishedAt: card.published_at,
      lines: lines.map((line) => ({
        id: line.id,
        subjectId: line.subject_id,
        subjectName: line.subject_name,
        lineType: line.line_type as 'subject' | 'conduct',
        average: Number(line.subject_average),
        coefficient: Number(line.subject_coefficient),
        rank: line.subject_rank,
      })),
    };
  }
}

export const buildReportCardsService = (db: ConstructorParameters<typeof ReportCardsRepository>[0]) =>
  new ReportCardsService(new ReportCardsRepository(db));
