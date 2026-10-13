import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReportCardsRepository } from '../../src/modules/report-cards/report-cards.repository.js';
import {
  computeClassStats,
  computeRankMap,
  computeWeightedGeneralAverage,
  ReportCardsService,
} from '../../src/modules/report-cards/report-cards.service.js';

const repository = {
  transaction: vi.fn(),
  findClassContext: vi.fn(),
  schoolYearStatus: vi.fn(),
  lockClassPeriod: vi.fn(),
  findGradingPeriod: vi.fn(),
  isBulletinGenerationAvailable: vi.fn(),
  isClassReviewClosed: vi.fn(),
  closeClassReview: vi.fn(),
  markRegenerated: vi.fn(),
  markRepublished: vi.fn(),
  getCorrectionPublicationState: vi.fn(),
  isLastPeriodOfYear: vi.fn(),
  listIncompleteSubjects: vi.fn(),
  listClassStudents: vi.fn(),
  listSubjectAverages: vi.fn(),
  listGeneralAverages: vi.fn(),
  listLevelSubjects: vi.fn(),
  findConductGrade: vi.fn(),
  findValidatedDecision: vi.fn(),
  findExistingCard: vi.fn(),
  replaceGeneratedCard: vi.fn(),
  upsertGeneralAverage: vi.fn(),
  publishCard: vi.fn(),
  listPublishableCardsOfClass: vi.fn(),
  listPublishedSummariesForStudent: vi.fn(),
  listCardLines: vi.fn(),
  findCardDetail: vi.fn(),
  listCardsOfClass: vi.fn(),
  listClaims: vi.fn(),
} as unknown as ReportCardsRepository;

vi.mocked(repository.transaction).mockImplementation(async (work) => work(repository));

describe('computeRankMap (rang dense)', () => {
  it('partage le rang des ex aequo puis donne le rang suivant', () => {
    const ranks = computeRankMap([
      { key: 'a', value: 15 },
      { key: 'b', value: 12 },
      { key: 'c', value: 12 },
      { key: 'd', value: 9 },
    ]);
    expect(ranks.get('a')).toBe(1);
    expect(ranks.get('b')).toBe(2);
    expect(ranks.get('c')).toBe(2);
    expect(ranks.get('d')).toBe(3);
  });

  it('classe 6e, 6e, 6e, 7e quand les moyennes affichées sont ex aequo', () => {
    const values = [19, 18, 17, 16, 15, 14.201, 14.203, 14.204, 13];
    const ranks = computeRankMap(values.map((value, index) => ({ key: String(index), value })));
    expect(values.slice(5, 8).map((value) => value.toFixed(2))).toEqual(['14.20', '14.20', '14.20']);
    expect(values.map((_, index) => ranks.get(String(index)))).toEqual([1, 2, 3, 4, 5, 6, 6, 6, 7]);
  });
});

describe('computeClassStats (statistiques de classe)', () => {
  it('calcule moyenne, min, max et effectif', () => {
    const stats = computeClassStats([10, 14, 16]);
    expect(stats).toEqual({ average: 13.333, min: 10, max: 16, headcount: 3 });
  });

  it('renvoie null sans données', () => {
    expect(computeClassStats([])).toBeNull();
  });
});

describe('computeWeightedGeneralAverage (matières + conduite)', () => {
  it('applique le coefficient de conduite comme celui d’une matière', () => {
    expect(computeWeightedGeneralAverage([
      { average: 16, coefficient: 4 },
      { average: 13, coefficient: 2 },
      { average: 17, coefficient: 1 },
    ])).toBe(15.286);
  });
  it('fait évoluer la moyenne et le rang avec le coefficient annuel', () => {
    const a = computeWeightedGeneralAverage([{ average: 12, coefficient: 2 }, { average: 20, coefficient: 2 }])!;
    const b = computeWeightedGeneralAverage([{ average: 15, coefficient: 2 }, { average: 10, coefficient: 2 }])!;
    expect(a).toBe(16);
    expect(b).toBe(12.5);
    expect(computeClassStats([a, b])).toEqual({ average: 14.25, min: 12.5, max: 16, headcount: 2 });
    expect(computeRankMap([{ key: 'a', value: a }, { key: 'b', value: b }]).get('a')).toBe(1);
  });
});

describe('ReportCardsService.generateForClass', () => {
  const classContext = { id: 'class-1', name: '6ème A', levelId: 'level-1', schoolYearId: 'year-1' };
  const period = { id: 'period-1', label: 'T1', orderIndex: 2, schoolYearId: 'year-1', yearLabel: '2094-2095' };

  const baseRepo = (): void => {
    repository.findClassContext.mockResolvedValue(classContext);
    repository.schoolYearStatus.mockResolvedValue('active');
    repository.findGradingPeriod.mockResolvedValue(period);
    repository.isBulletinGenerationAvailable.mockResolvedValue(true);
    repository.isClassReviewClosed.mockResolvedValue(false);
    repository.closeClassReview.mockResolvedValue(undefined);
    repository.isLastPeriodOfYear.mockResolvedValue(false);
    repository.listIncompleteSubjects.mockResolvedValue([]);
    repository.listLevelSubjects.mockResolvedValue([
      { id: 'subject-1', name: 'Maths', coefficient: 4 },
      { id: 'subject-2', name: 'Français', coefficient: 2 },
    ]);
    repository.findConductGrade.mockResolvedValue(null);
    repository.findExistingCard.mockResolvedValue(null);
    repository.findValidatedDecision.mockResolvedValue(null);
    repository.replaceGeneratedCard.mockImplementation(async () =>
      crypto.randomUUID()
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fige un snapshot complet : moyennes, rangs, stats de classe, ligne conduite", async () => {
    baseRepo();
    repository.listClassStudents.mockResolvedValue([
      { id: 'student-a', fullName: 'Awa Koné' },
      { id: 'student-b', fullName: 'Yao Bertin' },
    ]);
    repository.listGeneralAverages.mockResolvedValue([
      { studentId: 'student-a', average: 15 },
      { studentId: 'student-b', average: 10 },
    ]);
    repository.listSubjectAverages.mockResolvedValue([
      { studentId: 'student-a', subjectId: 'subject-1', average: 16 },
      { studentId: 'student-a', subjectId: 'subject-2', average: 13 },
      { studentId: 'student-b', subjectId: 'subject-1', average: 11 },
      { studentId: 'student-b', subjectId: 'subject-2', average: 8 },
    ]);
    repository.findExistingCard.mockResolvedValue(null);
    // La conduite finale est obligatoire pour chaque élève confirmé.
    repository.findConductGrade.mockImplementation(async (studentId: string) =>
      studentId === 'student-a' ? { note: 17, coefficient: 1 } : { note: 12, coefficient: 1 }
    );

    const service = new ReportCardsService(repository);
    const result = await service.generateForClass('class-1', 'period-1');
    expect(result.generatedCount).toBe(2);
    expect(repository.closeClassReview).toHaveBeenCalledWith('period-1', 'class-1');

    const firstCall = repository.replaceGeneratedCard.mock.calls[0]![0] as Record<string, unknown>;
    expect(firstCall.studentId).toBe('student-a');
    // Stats de classe snapshotées
    expect(firstCall.classAverage).toBe(12.786);
    expect(firstCall.classMinAverage).toBe(10.286);
    expect(firstCall.classMaxAverage).toBe(15.286);
    expect(firstCall.classHeadcount).toBe(2);
    // Rang général
    expect(firstCall.rank).toBe(1);
    expect(firstCall.generalAverage).toBe(15.286);
    // Lignes : 2 matières + conduite, rang matière correct
    const lines = firstCall.lines as Array<{ subjectId: string | null; rank: number | null; lineType: string; average: number; coefficient: number }>;
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ subjectId: 'subject-1', rank: 1, average: 16, coefficient: 4 });
    expect(lines[1]).toMatchObject({ subjectId: 'subject-2', rank: 1, average: 13, coefficient: 2 });
    expect(lines[2]).toMatchObject({ lineType: 'conduct', average: 17, coefficient: 1 });

    const secondCall = repository.replaceGeneratedCard.mock.calls[1]![0] as Record<string, unknown>;
    expect(secondCall.rank).toBe(2);
    expect((secondCall.lines as unknown[])).toHaveLength(3);
    expect(repository.upsertGeneralAverage).toHaveBeenCalledWith('student-a', 'period-1', 15.286, 1);
  });

  it('fige les rangs denses 6, 6, 6, 7 au général et par matière', async () => {
    baseRepo();
    const values = [19, 18, 17, 16, 15, 14.201, 14.203, 14.204, 13];
    const students = values.map((_, index) => ({ id: `student-${index}`, fullName: `Élève ${index}` }));
    repository.listClassStudents.mockResolvedValue(students);
    repository.listLevelSubjects.mockResolvedValue([{ id: 'subject-1', name: 'Maths', coefficient: 1 }]);
    repository.listSubjectAverages.mockResolvedValue(values.map((average, index) => ({
      studentId: students[index]!.id, subjectId: 'subject-1', average,
    })));
    repository.findConductGrade.mockResolvedValue({ note: 20, coefficient: 1 });

    const result = await new ReportCardsService(repository).generateForClass('class-1', 'period-1');
    expect(result.generatedCount).toBe(9);
    const savedCards = repository.replaceGeneratedCard.mock.calls.map(([card]) => card);
    expect(savedCards.map((card) => card.rank)).toEqual([1, 2, 3, 4, 5, 6, 6, 6, 7]);
    expect(savedCards.map((card) => card.lines[0]?.rank)).toEqual([1, 2, 3, 4, 5, 6, 6, 6, 7]);
    expect(savedCards.slice(5, 8).map((card) => card.generalAverage)).toEqual([17.101, 17.102, 17.102]);
    expect(repository.upsertGeneralAverage.mock.calls.map((call) => call[3]))
      .toEqual([1, 2, 3, 4, 5, 6, 6, 6, 7]);
  });

  it("n'attache la décision de fin d'année que sur la dernière période", async () => {
    baseRepo();
    repository.listClassStudents.mockResolvedValue([{ id: 'student-a', fullName: 'Awa Koné' }]);
    repository.listGeneralAverages.mockResolvedValue([{ studentId: 'student-a', average: 15 }]);
    repository.listSubjectAverages.mockResolvedValue([]);
    repository.findExistingCard.mockResolvedValue(null);
    repository.findConductGrade.mockResolvedValue({ note: 15, coefficient: 1 });

    // Période NON finale
    repository.isLastPeriodOfYear.mockResolvedValue(false);
    const service = new ReportCardsService(repository);
    await service.generateForClass('class-1', 'period-1');
    expect(repository.replaceGeneratedCard.mock.calls[0]![0]).toMatchObject({ classDecisionId: null });

    vi.clearAllMocks();
    baseRepo();
    repository.isLastPeriodOfYear.mockResolvedValue(true);
    repository.listClassStudents.mockResolvedValue([{ id: 'student-a', fullName: 'Awa Koné' }]);
    repository.listGeneralAverages.mockResolvedValue([{ studentId: 'student-a', average: 15 }]);
    repository.listSubjectAverages.mockResolvedValue([]);
    repository.findExistingCard.mockResolvedValue(null);
    repository.findConductGrade.mockResolvedValue({ note: 15, coefficient: 1 });
    repository.findValidatedDecision.mockResolvedValue({ id: 'decision-1', decision: 'promoted' });

    await service.generateForClass('class-1', 'period-1');
    expect(repository.replaceGeneratedCard.mock.calls[0]![0]).toMatchObject({
      classDecisionId: 'decision-1',
    });
  });

  it("recalcule le bulletin non publié et préserve le bulletin publié", async () => {
    baseRepo();
    repository.listClassStudents.mockResolvedValue([
      { id: 'student-published', fullName: 'Publié' },
      { id: 'student-draft', fullName: 'Brouillon' },
    ]);
    repository.listGeneralAverages.mockResolvedValue([
      { studentId: 'student-published', average: 15 },
      { studentId: 'student-draft', average: 10 },
    ]);
    repository.listSubjectAverages.mockResolvedValue([]);
    repository.findExistingCard.mockImplementation(async (studentId: string) =>
      studentId === 'student-published'
        ? { id: 'card-pub', status: 'published' as const }
        : { id: 'card-draft', status: 'generated' as const }
    );
    repository.replaceGeneratedCard.mockResolvedValue('regen-id');
    repository.findConductGrade.mockResolvedValue({ note: 15, coefficient: 1 });

    const service = new ReportCardsService(repository);
    const result = await service.generateForClass('class-1', 'period-1');

    expect(result).toEqual({ generatedCount: 1, classClosed: true, periodCompleted: true });
    expect(repository.replaceGeneratedCard).toHaveBeenCalledTimes(1);
    expect(repository.closeClassReview).toHaveBeenCalledWith('period-1', 'class-1');
  });

  it('garde la revue clôturée même après une nouvelle inscription confirmée', async () => {
    baseRepo();
    repository.isClassReviewClosed.mockResolvedValue(true);
    const service = new ReportCardsService(repository);

    expect(await service.generateForClass('class-1', 'period-1')).toEqual({
      generatedCount: 0,
      classClosed: true,
      periodCompleted: true,
    });
    expect(repository.listClassStudents).toHaveBeenCalled();
    expect(repository.replaceGeneratedCard).not.toHaveBeenCalled();
  });

  it("échoue clairement quand aucune moyenne n'est calculée", async () => {
    baseRepo();
    repository.listClassStudents.mockResolvedValue([]);
    repository.listGeneralAverages.mockResolvedValue([]);

    const service = new ReportCardsService(repository);
    await expect(service.generateForClass('class-1', 'period-1')).rejects.toMatchObject({
      code: 'NO_AVERAGES_COMPUTED',
      statusCode: 409,
    });
  });

  it('refuse la génération si un élève confirmé est sans conduite finale', async () => {
    baseRepo();
    repository.listClassStudents.mockResolvedValue([{ id: 'student-a', fullName: 'Awa Koné' }]);
    repository.listSubjectAverages.mockResolvedValue([{ studentId: 'student-a', subjectId: 'subject-1', average: 14 }]);
    await expect(new ReportCardsService(repository).generateForClass('class-1', 'period-1'))
      .rejects.toMatchObject({ code: 'CONDUCT_GRADES_PENDING', statusCode: 409 });
    expect(repository.replaceGeneratedCard).not.toHaveBeenCalled();
  });

  it('refuse la génération tant qu’une matière de la classe n’est pas validée', async () => {
    baseRepo();
    repository.listIncompleteSubjects.mockResolvedValue(['Français']);

    const service = new ReportCardsService(repository);
    await expect(service.generateForClass('class-1', 'period-1')).rejects.toMatchObject({
      code: 'SUBJECT_AVERAGES_PENDING',
      statusCode: 409,
    });
    expect(repository.listClassStudents).toHaveBeenCalledWith('class-1');
  });
});

describe('snapshot immuable après publication', () => {
  it('la consultation lit les valeurs figées, jamais recalculées depuis les notes sources', async () => {
    vi.clearAllMocks();
    // Le bulletin a été généré avec general_average = 15 alors que la note
    // source a depuis été corrigée. La lecture doit renvoyer 15.
    repository.findCardDetail.mockResolvedValue({
      id: 'card-1',
      student_id: 'student-a',
      student_name: 'Awa Koné',
      class_id: 'class-1',
      class_name: '6ème A',
      grading_period_id: 'period-1',
      period_label: 'T1',
      general_average: '15.000',
      rank: 1,
      class_average: '12.500',
      class_min_average: '10.000',
      class_max_average: '15.000',
      class_headcount: 2,
      status: 'published',
      generated_at: '2026-01-01T00:00:00Z',
      published_at: '2026-01-02T00:00:00Z',
      decision: null,
    });
    repository.listCardLines.mockResolvedValue([
      {
        id: 'line-1',
        subject_id: 'subject-1',
        subject_name: 'Maths',
        line_type: 'subject',
        subject_average: '16.000',
        subject_coefficient: '4.000',
        subject_rank: 1,
      },
    ]);

    const service = new ReportCardsService(repository);
    const detail = await service.getDetail('card-1');

    expect(detail.generalAverage).toBe(15);
    expect(detail.lines).toHaveLength(1);
    expect(detail.lines[0]).toMatchObject({ average: 16, coefficient: 4, rank: 1 });
    // Aucune requête vers les moyennes sources pendant la consultation.
    expect(repository.listGeneralAverages).not.toHaveBeenCalled();
    expect(repository.listSubjectAverages).not.toHaveBeenCalled();
  });
});

describe('publishBulk', () => {
  it('publie tous les bulletins générés d\u2019une classe/période', async () => {
    vi.clearAllMocks();
    repository.listPublishableCardsOfClass.mockResolvedValue(['c1', 'c2']);
    repository.publishCard.mockResolvedValue(undefined);

    const service = new ReportCardsService(repository);
    const result = await service.publishBulk('class-1', 'period-1', 'user-1');

    expect(result.publishedCount).toBe(2);
    expect(repository.transaction).toHaveBeenCalledOnce();
    expect(repository.publishCard).toHaveBeenCalledTimes(2);
    expect(repository.publishCard).toHaveBeenNthCalledWith(1, 'c1', 'user-1');
    expect(repository.publishCard).toHaveBeenNthCalledWith(2, 'c2', 'user-1');
  });
});

describe('consultation historique des bulletins', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repository.findClassContext.mockResolvedValue({ schoolYearId: 'year-old' });
    repository.findGradingPeriod.mockResolvedValue({ schoolYearId: 'year-current' });
  });

  it('refuse une classe et une période de deux années avant de lire les cartes', async () => {
    await expect(new ReportCardsService(repository).listClassCards('class-old', 'period-current'))
      .rejects.toMatchObject({ code: 'CLASS_PERIOD_YEAR_MISMATCH', statusCode: 400 });
    expect(repository.listCardsOfClass).not.toHaveBeenCalled();
  });

  it('refuse le même couple interannées avant de lire les réclamations', async () => {
    await expect(new ReportCardsService(repository).listClaims({ classId: 'class-old', gradingPeriodId: 'period-current' }))
      .rejects.toMatchObject({ code: 'CLASS_PERIOD_YEAR_MISMATCH', statusCode: 400 });
    expect(repository.listClaims).not.toHaveBeenCalled();
  });

  it('interdit de publier une année clôturée', async () => {
    repository.transaction.mockImplementation(async (work) => work(repository));
    repository.findClassContext.mockResolvedValue({ schoolYearId: 'year-old' });
    repository.findGradingPeriod.mockResolvedValue({ schoolYearId: 'year-old' });
    repository.schoolYearStatus.mockResolvedValue('closed');
    await expect(new ReportCardsService(repository).publishBulk('class-old', 'period-old', 'user-1'))
      .rejects.toMatchObject({ code: 'SCHOOL_YEAR_CLOSED', statusCode: 409 });
    expect(repository.publishCard).not.toHaveBeenCalled();
  });
});

describe('réclamations et autorisation de correction', () => {
  const claim = {
    id: 'claim-1', class_id: 'class-1', subject_id: 'subject-1',
    grading_period_id: 'period-1', status: 'pending_exceptional_authorization',
  };
  const scopedRepository = {
    transaction: vi.fn(), lockClassPeriod: vi.fn(), findClassContext: vi.fn(),
    schoolYearStatus: vi.fn(),
    findGradingPeriod: vi.fn(), subjectBelongsToClass: vi.fn(),
    isAssignedSubject: vi.fn(), isSubjectCompleted: vi.fn(), listClaims: vi.fn(), listClassStudents: vi.fn(),
    getCardsPhase: vi.fn(), createClaim: vi.fn(), findClaim: vi.fn(),
    setClaimDecision: vi.fn(), reopenSubject: vi.fn(), invalidateClassCards: vi.fn(),
  };
  const service = new ReportCardsService(scopedRepository as unknown as ReportCardsRepository);

  beforeEach(() => {
    vi.resetAllMocks();
    scopedRepository.transaction.mockImplementation(async (work: (repo: unknown) => Promise<unknown>) => work(scopedRepository));
    scopedRepository.findClassContext.mockResolvedValue({ schoolYearId: 'year-1' });
    scopedRepository.schoolYearStatus.mockResolvedValue('active');
    scopedRepository.findGradingPeriod.mockResolvedValue({ schoolYearId: 'year-1' });
    scopedRepository.subjectBelongsToClass.mockResolvedValue(true);
    scopedRepository.isAssignedSubject.mockResolvedValue(true);
    scopedRepository.isSubjectCompleted.mockResolvedValue(true);
    scopedRepository.listClassStudents.mockResolvedValue([{ id: 'student-1', fullName: 'Aya Test' }]);
    scopedRepository.listClaims.mockResolvedValue([]);
    scopedRepository.getCardsPhase.mockResolvedValue('before');
    scopedRepository.createClaim.mockResolvedValue('claim-1');
    scopedRepository.findClaim.mockResolvedValue(claim);
  });

  it('accepte une nouvelle réclamation après correction avant génération', async () => {
    scopedRepository.listClaims.mockResolvedValue([{ status: 'corrected', phase: 'before' }]);
    await expect(service.createClaim({ classId: 'class-1', subjectId: 'subject-1', gradingPeriodId: 'period-1', userId: 'user-1', reason: 'Erreur de note' }))
      .resolves.toEqual({ id: 'claim-1' });
    expect(scopedRepository.createClaim).toHaveBeenCalled();
  });

  it('cible un élève confirmé de la classe et refuse un élève extérieur', async () => {
    const input = { classId: 'class-1', studentId: 'student-1', subjectId: 'subject-1',
      gradingPeriodId: 'period-1', userId: 'user-1', reason: 'Erreur de note' };
    await expect(service.createClaim(input)).resolves.toEqual({ id: 'claim-1' });
    expect(scopedRepository.createClaim).toHaveBeenCalledWith(expect.objectContaining({ studentId: 'student-1' }));
    scopedRepository.createClaim.mockClear();
    await expect(service.createClaim({ ...input, studentId: 'student-exterieur' }))
      .rejects.toMatchObject({ code: 'CLAIM_STUDENT_CLASS_MISMATCH' });
    expect(scopedRepository.createClaim).not.toHaveBeenCalled();
  });

  it('refuse une deuxième correction ouverte dans la même classe et période', async () => {
    scopedRepository.listClaims.mockResolvedValue([{ status: 'corrected', phase: 'published' }]);
    await expect(service.createClaim({ classId: 'class-1', subjectId: 'subject-2', gradingPeriodId: 'period-1', userId: 'user-1', reason: 'Erreur de note' }))
      .rejects.toMatchObject({ code: 'CLAIM_ALREADY_OPEN' });
    expect(scopedRepository.createClaim).not.toHaveBeenCalled();
  });

  it('exige le droit de correction publiée sans imposer le rôle directeur', async () => {
    scopedRepository.getCardsPhase.mockResolvedValue('published');
    const input = { claimId: 'claim-1', decision: 'approved' as const, userId: 'user-1', reason: 'Erreur confirmée', canPublish: true, canCorrectPublished: true };
    await expect(service.decideClaim({ ...input, canCorrectPublished: false })).rejects.toMatchObject({ code: 'PUBLISHED_CORRECTION_FORBIDDEN' });
    await expect(service.decideClaim({ ...input, canPublish: false })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(scopedRepository.invalidateClassCards).not.toHaveBeenCalled();
    await expect(service.decideClaim(input)).resolves.toMatchObject({ status: 'approved', phase: 'published' });
    expect(scopedRepository.invalidateClassCards).toHaveBeenCalledWith(expect.objectContaining({ claimId: 'claim-1', classId: 'class-1', reason: 'Erreur confirmée' }));
  });

  it('ouvre la seule matière avant génération avec le droit de publication', async () => {
    scopedRepository.findClaim.mockResolvedValue({ ...claim, status: 'open' });
    await service.decideClaim({ claimId: 'claim-1', decision: 'approved', userId: 'user-1',
      reason: 'Erreur confirmée', canPublish: true, canCorrectPublished: false });
    expect(scopedRepository.reopenSubject).toHaveBeenCalledWith(expect.objectContaining({
      classId: 'class-1', subjectId: 'subject-1', claimId: 'claim-1',
    }));
    expect(scopedRepository.invalidateClassCards).not.toHaveBeenCalled();
  });

  it('invalide les cartes générées sans exiger le droit exceptionnel', async () => {
    scopedRepository.findClaim.mockResolvedValue({ ...claim, status: 'open' });
    scopedRepository.getCardsPhase.mockResolvedValue('generated');
    await service.decideClaim({ claimId: 'claim-1', decision: 'approved', userId: 'user-1',
      reason: 'Erreur confirmée', canPublish: true, canCorrectPublished: false });
    expect(scopedRepository.invalidateClassCards).toHaveBeenCalledOnce();
  });

  it('refuse une réclamation avant toute réouverture', async () => {
    scopedRepository.findClaim.mockResolvedValue({ ...claim, status: 'open' });
    await expect(service.decideClaim({ claimId: 'claim-1', decision: 'refused', userId: 'user-1', reason: 'Note vérifiée', canPublish: true, canCorrectPublished: false }))
      .resolves.toMatchObject({ status: 'refused' });
    expect(scopedRepository.setClaimDecision).toHaveBeenCalled();
    expect(scopedRepository.reopenSubject).not.toHaveBeenCalled();
    expect(scopedRepository.invalidateClassCards).not.toHaveBeenCalled();
  });
});
