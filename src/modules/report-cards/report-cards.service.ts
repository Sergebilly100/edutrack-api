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

export const computeWeightedGeneralAverage = (
  entries: Array<{ average: number; coefficient: number }>
): number | null => {
  const totalCoefficient = entries.reduce((sum, entry) => sum + entry.coefficient, 0);
  if (totalCoefficient <= 0) return null;
  const weightedTotal = entries.reduce(
    (sum, entry) => sum + entry.average * entry.coefficient,
    0
  );
  return Math.round((weightedTotal / totalCoefficient) * 1000) / 1000;
};

export class ReportCardsService {
  constructor(private readonly repository: ReportCardsRepository) {}

  async listReportCardClasses(schoolYearId: string) {
    if (!(await this.repository.schoolYearExists(schoolYearId))) {
      throw new ReportCardsModuleError('Année scolaire introuvable', 404, 'SCHOOL_YEAR_NOT_FOUND');
    }
    return this.repository.listReportCardClasses(schoolYearId);
  }

  async assertClassPeriodScope(classId: string, gradingPeriodId: string): Promise<void> {
    const [klass, period] = await Promise.all([
      this.repository.findClassContext(classId),
      this.repository.findGradingPeriod(gradingPeriodId),
    ]);
    if (!klass) throw new ReportCardsModuleError('Classe introuvable', 404, 'CLASS_NOT_FOUND');
    if (!period) throw new ReportCardsModuleError('Période introuvable', 404, 'GRADING_PERIOD_NOT_FOUND');
    if (klass.schoolYearId !== period.schoolYearId) {
      throw new ReportCardsModuleError('La classe et la période doivent appartenir à la même année scolaire', 400, 'CLASS_PERIOD_YEAR_MISMATCH');
    }
  }

  private async assertYearEditable(schoolYearId: string): Promise<void> {
    if (await this.repository.schoolYearStatus(schoolYearId) === 'closed') {
      throw new ReportCardsModuleError('L’année scolaire est clôturée', 409, 'SCHOOL_YEAR_CLOSED');
    }
  }

  async createClaim(input: { classId: string; studentId?: string; subjectId: string; gradingPeriodId: string; userId: string; reason: string }) {
    return this.repository.transaction(async (repository) => {
      await repository.lockClassPeriod(input.classId, input.gradingPeriodId);
      const klass = await repository.findClassContext(input.classId);
      const period = await repository.findGradingPeriod(input.gradingPeriodId);
      if (!klass || !period || klass.schoolYearId !== period.schoolYearId
        || !(await repository.subjectBelongsToClass(input.classId, input.subjectId))) {
        throw new ReportCardsModuleError('Classe, matière ou période incohérente', 400, 'CLAIM_SCOPE_MISMATCH');
      }
      await new ReportCardsService(repository).assertYearEditable(klass.schoolYearId);
      if (!(await repository.isAssignedSubject(input.classId, input.subjectId))) {
        throw new ReportCardsModuleError('Aucun professeur affecté à cette matière', 409, 'CLAIM_TEACHER_MISSING');
      }
      if (input.studentId && !(await repository.listClassStudents(input.classId)).some((student) => student.id === input.studentId)) {
        throw new ReportCardsModuleError('Cet élève ne fait pas partie de la classe', 400, 'CLAIM_STUDENT_CLASS_MISMATCH');
      }
      if (!(await repository.isSubjectCompleted(input.classId, input.subjectId, input.gradingPeriodId))) {
        throw new ReportCardsModuleError('Les moyennes de cette matière ne sont pas validées', 409, 'CLAIM_SUBJECT_NOT_COMPLETED');
      }
      const existing = await repository.listClaims({ classId: input.classId, gradingPeriodId: input.gradingPeriodId });
      if (existing.some((claim) => ['open', 'pending_exceptional_authorization', 'approved'].includes(claim.status)
        || (claim.phase !== 'before' && ['corrected', 'regenerated'].includes(claim.status)))) {
        throw new ReportCardsModuleError('Une correction est déjà en cours pour cette classe et cette période', 409, 'CLAIM_ALREADY_OPEN');
      }
      const phase = await repository.getCardsPhase(input.classId, input.gradingPeriodId);
      return { id: await repository.createClaim({ ...input, phase, status: phase === 'published' ? 'pending_exceptional_authorization' : 'open' }) };
    });
  }

  async decideClaim(input: { claimId: string; decision: 'approved' | 'refused'; userId: string; role: string; reason: string; canPublish: boolean; canCorrectPublished: boolean }) {
    return this.repository.transaction(async (repository) => {
      const claim = await repository.findClaim(input.claimId, true);
      if (!claim) throw new ReportCardsModuleError('Réclamation introuvable', 404, 'CLAIM_NOT_FOUND');
      await repository.lockClassPeriod(claim.class_id, claim.grading_period_id);
      const klass = await repository.findClassContext(claim.class_id);
      if (!klass) throw new ReportCardsModuleError('Classe introuvable', 404, 'CLASS_NOT_FOUND');
      await new ReportCardsService(repository).assertYearEditable(klass.schoolYearId);
      if (claim.status !== 'open' && claim.status !== 'pending_exceptional_authorization') {
        throw new ReportCardsModuleError('Cette réclamation a déjà été traitée', 409, 'CLAIM_ALREADY_DECIDED');
      }
      if (!input.canPublish) throw new ReportCardsModuleError('Autorisation de publication requise', 403, 'FORBIDDEN');
      const phase = await repository.getCardsPhase(claim.class_id, claim.grading_period_id);
      if (input.decision === 'approved' && phase === 'published' && (!input.canCorrectPublished || !['director', 'super_admin'].includes(input.role))) {
        throw new ReportCardsModuleError('Autorisation exceptionnelle de direction requise', 403, 'PUBLISHED_CORRECTION_FORBIDDEN');
      }
      await repository.setClaimDecision(claim.id, { status: input.decision, phase, userId: input.userId, reason: input.reason, oldStatus: claim.status });
      if (input.decision === 'approved') {
        const scope = { classId: claim.class_id, subjectId: claim.subject_id,
          gradingPeriodId: claim.grading_period_id, claimId: claim.id, userId: input.userId, reason: input.reason };
        if (phase === 'before') await repository.reopenSubject(scope);
        else await repository.invalidateClassCards(scope);
      }
      return { id: claim.id, status: input.decision, phase };
    });
  }

  async listClaims(filters: Parameters<ReportCardsRepository['listClaims']>[0]) {
    if (filters.classId && filters.gradingPeriodId) {
      await this.assertClassPeriodScope(filters.classId, filters.gradingPeriodId);
    }
    return this.repository.listClaims(filters);
  }

  async listClaimStudents(classId: string) {
    if (!(await this.repository.findClassContext(classId))) {
      throw new ReportCardsModuleError('Classe introuvable', 404, 'CLASS_NOT_FOUND');
    }
    return this.repository.listClassStudents(classId);
  }

  async listVersions(classId: string, gradingPeriodId: string) {
    await this.assertClassPeriodScope(classId, gradingPeriodId);
    return this.repository.listVersions(classId, gradingPeriodId);
  }

  async listAcademicAudit(classId: string, gradingPeriodId: string) {
    await this.assertClassPeriodScope(classId, gradingPeriodId);
    return this.repository.listAcademicAudit(classId, gradingPeriodId);
  }

  async isStudentReportInRevision(studentId: string, schoolYearId?: string) {
    return this.repository.isStudentReportInRevision(studentId, schoolYearId);
  }

  async listConductAmbiguities() {
    return { periods: await this.repository.listConductAmbiguities() };
  }

  // periodCompleted remains a compatibility alias for the class-level result.
  async generateForClass(classId: string, gradingPeriodId: string, userId?: string): Promise<{ generatedCount: number; classClosed: boolean; periodCompleted: boolean }> {
    return this.repository.transaction(async (repository) => {
      await repository.lockClassPeriod(classId, gradingPeriodId);
      return new ReportCardsService(repository).generateForClassLocked(classId, gradingPeriodId, userId);
    });
  }

  private async generateForClassLocked(classId: string, gradingPeriodId: string, userId?: string): Promise<{ generatedCount: number; classClosed: boolean; periodCompleted: boolean }> {
    const klass = await this.repository.findClassContext(classId);
    if (!klass) {
      throw new ReportCardsModuleError('Classe introuvable', 404, 'CLASS_NOT_FOUND');
    }

    const period = await this.repository.findGradingPeriod(gradingPeriodId);
    if (!period || period.schoolYearId !== klass.schoolYearId) {
      throw new ReportCardsModuleError('Période introuvable pour cette classe', 404, 'GRADING_PERIOD_NOT_FOUND');
    }
    await this.assertYearEditable(klass.schoolYearId);
    const wasClosed = await this.repository.isClassReviewClosed(gradingPeriodId, classId);
    const roster = await this.repository.listClassStudents(classId);
    const existingCards = await Promise.all(roster.map((student) => this.repository.findExistingCard(student.id, gradingPeriodId)));
    if (wasClosed && (existingCards.some(card => card === null) || existingCards.every(card => card?.status === 'published'))) {
      return { generatedCount: 0, classClosed: true, periodCompleted: true };
    }
    const reviewOpen = await this.repository.isBulletinGenerationAvailable(klass.schoolYearId, gradingPeriodId);
    if (!reviewOpen) {
      throw new ReportCardsModuleError(
        'Les bulletins peuvent être générés dès le début de revue de cette période',
        409,
        'BULLETIN_REVIEW_NOT_OPEN'
      );
    }

    const incompleteSubjects = await this.repository.listIncompleteSubjects(classId, gradingPeriodId);
    if (incompleteSubjects.length > 0) {
      throw new ReportCardsModuleError(
        `Les moyennes ne sont pas encore validées pour : ${incompleteSubjects.join(', ')}`,
        409,
        'SUBJECT_AVERAGES_PENDING'
      );
    }

    const subjectAverages = await this.repository.listSubjectAverages(classId, gradingPeriodId);
    const levelSubjects = await this.repository.listLevelSubjects(klass.levelId);
    const isLastPeriod = await this.repository.isLastPeriodOfYear(klass.schoolYearId, gradingPeriodId);

    const conducts = new Map(
      await Promise.all(roster.map(async (student) => [
        student.id,
        await this.repository.findConductGrade(student.id, gradingPeriodId),
      ] as const))
    );
    const missingConduct = roster.filter(student => !conducts.get(student.id)).map(student => student.fullName);
    if (missingConduct.length > 0) {
      throw new ReportCardsModuleError(
        `Note finale de conduite manquante pour : ${missingConduct.join(', ')}`,
        409,
        'CONDUCT_GRADES_PENDING'
      );
    }
    const generalAverages = roster.flatMap((student) => {
      const entries = subjectAverages
        .filter((row) => row.studentId === student.id)
        .flatMap((row) => {
          const subject = levelSubjects.find((item) => item.id === row.subjectId);
          return subject ? [{ average: row.average, coefficient: subject.coefficient }] : [];
        });
      const conduct = conducts.get(student.id);
      if (conduct) entries.push({ average: conduct.note, coefficient: conduct.coefficient });
      const average = computeWeightedGeneralAverage(entries);
      return average === null ? [] : [{ studentId: student.id, average }];
    });
    const stats = computeClassStats(generalAverages.map((row) => row.average));
    // Les statistiques de classe portent sur les élèves notés ; l'effectif
    // affiché reste celui de la classe entière si plus grand.
    if (!stats) {
      throw new ReportCardsModuleError(
        'Aucune moyenne générale calculée pour cette classe et cette période',
        409,
        'NO_AVERAGES_COMPUTED'
      );
    }

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
    let newlyCreatedCount = 0;
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

      const conduct = conducts.get(student.id);
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
      await this.repository.upsertGeneralAverage(student.id, gradingPeriodId, studentGeneral.average, generalRanks.get(student.id) ?? headcount);
      if (!existingCard) newlyCreatedCount += 1;
      generatedCount += 1;
    }

    if (generatedCount === 0 && skippedPublished === 0) {
      throw new ReportCardsModuleError(
        'Aucun bulletin généré : aucune moyenne disponible pour cette classe',
        409,
        'NOTHING_TO_GENERATE'
      );
    }

    const classClosed = roster.length > 0
      && existingCards.filter((card) => card !== null).length + newlyCreatedCount >= roster.length;
    if (classClosed) {
      await this.repository.closeClassReview(gradingPeriodId, classId);
      await this.repository.markRegenerated(classId, gradingPeriodId, userId);
    }
    return { generatedCount, classClosed, periodCompleted: classClosed };
  }

  async publish(cardId: string, userId: string): Promise<void> {
    await this.repository.transaction(async (repository) => {
      const existing = await repository.findCardDetail(cardId);
      if (existing) await repository.lockClassPeriod(existing.class_id, existing.grading_period_id);
      if (existing) {
        const klass = await repository.findClassContext(existing.class_id);
        if (klass) await new ReportCardsService(repository).assertYearEditable(klass.schoolYearId);
      }
      if (existing && await repository.getCorrectionPublicationState(existing.class_id, existing.grading_period_id)) {
        throw new ReportCardsModuleError('Publiez toute la classe après une correction', 409, 'CORRECTION_BULK_PUBLICATION_REQUIRED');
      }
      await repository.publishCard(cardId, userId);
      const card = await repository.findCardDetail(cardId);
      if (card) await repository.markRepublished(card.class_id, card.grading_period_id, userId);
    });
  }

  async listClassCards(classId: string, gradingPeriodId: string) {
    await this.assertClassPeriodScope(classId, gradingPeriodId);
    return this.repository.listCardsOfClass(classId, gradingPeriodId);
  }

  async publishBulk(classId: string, gradingPeriodId: string, userId: string): Promise<{ publishedCount: number }> {
    return this.repository.transaction(async (repository) => {
      await repository.lockClassPeriod(classId, gradingPeriodId);
      await new ReportCardsService(repository).assertClassPeriodScope(classId, gradingPeriodId);
      const klass = await repository.findClassContext(classId);
      if (klass) await new ReportCardsService(repository).assertYearEditable(klass.schoolYearId);
      const correctionState = await repository.getCorrectionPublicationState(classId, gradingPeriodId);
      if (correctionState && correctionState !== 'regenerated') {
        throw new ReportCardsModuleError('Régénérez tous les bulletins avant publication', 409, 'CORRECTION_REGENERATION_REQUIRED');
      }
      const cardIds = await repository.listPublishableCardsOfClass(classId, gradingPeriodId);
      if (correctionState === 'regenerated' && cardIds.length === 0) {
        throw new ReportCardsModuleError('Aucun bulletin corrigé à publier', 409, 'CORRECTION_CARDS_MISSING');
      }
      for (const id of cardIds) {
        await repository.publishCard(id, userId);
      }
      await repository.markRepublished(classId, gradingPeriodId, userId);
      return { publishedCount: cardIds.length };
    });
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
        studentsWithFinalConduct: row.with_conduct,
        subjects,
        readyToGenerate: row.headcount > 0 && row.with_general >= row.headcount && row.with_conduct >= row.headcount,
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
      schoolYearLabel: card.schoolYearLabel,
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

  async listPublishedForStudent(studentId: string, schoolYearId?: string) {
    return this.repository.listPublishedSummariesForStudent(studentId, schoolYearId);
  }

  async listPublishedSchoolYearsForStudent(studentId: string) {
    return this.repository.listPublishedSchoolYearsForStudent(studentId);
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
      schoolYearLabel: card.school_year_label,
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
