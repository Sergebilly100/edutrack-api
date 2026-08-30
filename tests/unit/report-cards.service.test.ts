import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReportCardsRepository } from '../../src/modules/report-cards/report-cards.repository.js';
import {
  computeClassStats,
  computeRankMap,
  computeWeightedGeneralAverage,
  ReportCardsService,
} from '../../src/modules/report-cards/report-cards.service.js';

const repository = {
  findClassContext: vi.fn(),
  findGradingPeriod: vi.fn(),
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
  publishCard: vi.fn(),
  listPublishableCardsOfClass: vi.fn(),
  listPublishedSummariesForStudent: vi.fn(),
  listCardLines: vi.fn(),
  findCardDetail: vi.fn(),
} as unknown as ReportCardsRepository;

describe('computeRankMap (rang compétitif)', () => {
  it('partage le rang des ex aequo et saute les rangs suivants', () => {
    const ranks = computeRankMap([
      { key: 'a', value: 15 },
      { key: 'b', value: 12 },
      { key: 'c', value: 12 },
      { key: 'd', value: 9 },
    ]);
    expect(ranks.get('a')).toBe(1);
    expect(ranks.get('b')).toBe(2);
    expect(ranks.get('c')).toBe(2);
    expect(ranks.get('d')).toBe(4);
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
});

describe('ReportCardsService.generateForClass', () => {
  const classContext = { id: 'class-1', name: '6ème A', levelId: 'level-1', schoolYearId: 'year-1' };
  const period = { id: 'period-1', label: 'T1', orderIndex: 2, schoolYearId: 'year-1', yearLabel: '2094-2095' };

  const baseRepo = (): void => {
    repository.findClassContext.mockResolvedValue(classContext);
    repository.findGradingPeriod.mockResolvedValue(period);
    repository.isLastPeriodOfYear.mockResolvedValue(false);
    repository.listIncompleteSubjects.mockResolvedValue([]);
    repository.listLevelSubjects.mockResolvedValue([
      { id: 'subject-1', name: 'Maths', coefficient: 4 },
      { id: 'subject-2', name: 'Français', coefficient: 2 },
    ]);
    repository.findConductGrade.mockResolvedValue(null);
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
    // Conduite uniquement pour student-a
    repository.findConductGrade.mockImplementation(async (studentId: string) =>
      studentId === 'student-a' ? { note: 17, coefficient: 1 } : null
    );

    const service = new ReportCardsService(repository);
    const result = await service.generateForClass('class-1', 'period-1');
    expect(result.generatedCount).toBe(2);

    const firstCall = repository.replaceGeneratedCard.mock.calls[0]![0] as Record<string, unknown>;
    expect(firstCall.studentId).toBe('student-a');
    // Stats de classe snapshotées
    expect(firstCall.classAverage).toBe(12.643);
    expect(firstCall.classMinAverage).toBe(10);
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
    expect((secondCall.lines as unknown[])).toHaveLength(2); // pas de conduite pour student-b
  });

  it("n'attache la décision de fin d'année que sur la dernière période", async () => {
    baseRepo();
    repository.listClassStudents.mockResolvedValue([{ id: 'student-a', fullName: 'Awa Koné' }]);
    repository.listGeneralAverages.mockResolvedValue([{ studentId: 'student-a', average: 15 }]);
    repository.listSubjectAverages.mockResolvedValue([]);
    repository.findExistingCard.mockResolvedValue(null);

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
    repository.findValidatedDecision.mockResolvedValue({ id: 'decision-1', decision: 'promoted' });

    await service.generateForClass('class-1', 'period-1');
    expect(repository.replaceGeneratedCard.mock.calls[0]![0]).toMatchObject({
      classDecisionId: 'decision-1',
    });
  });

  it("saute les bulletins publiés sans faire échouer la génération de masse", async () => {
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

    const service = new ReportCardsService(repository);
    const result = await service.generateForClass('class-1', 'period-1');

    expect(result.generatedCount).toBe(1);
    expect(repository.replaceGeneratedCard).toHaveBeenCalledTimes(1);
    expect((repository.replaceGeneratedCard.mock.calls[0]![0] as Record<string, unknown>).studentId).toBe(
      'student-draft'
    );
  });

  it("échoue clairement quand aucune moyenne n'est calculée", async () => {
    baseRepo();
    repository.listGeneralAverages.mockResolvedValue([]);

    const service = new ReportCardsService(repository);
    await expect(service.generateForClass('class-1', 'period-1')).rejects.toMatchObject({
      code: 'NO_AVERAGES_COMPUTED',
      statusCode: 409,
    });
  });

  it('refuse la génération tant qu’une matière de la classe n’est pas validée', async () => {
    baseRepo();
    repository.listIncompleteSubjects.mockResolvedValue(['Français']);

    const service = new ReportCardsService(repository);
    await expect(service.generateForClass('class-1', 'period-1')).rejects.toMatchObject({
      code: 'SUBJECT_AVERAGES_PENDING',
      statusCode: 409,
    });
    expect(repository.listClassStudents).not.toHaveBeenCalled();
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
    expect(repository.publishCard).toHaveBeenCalledTimes(2);
    expect(repository.publishCard).toHaveBeenNthCalledWith(1, 'c1', 'user-1');
    expect(repository.publishCard).toHaveBeenNthCalledWith(2, 'c2', 'user-1');
  });
});
