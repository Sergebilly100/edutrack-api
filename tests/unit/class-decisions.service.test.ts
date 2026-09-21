import { describe, expect, it, vi } from 'vitest';

import type { ClassDecisionsRepository } from '../../src/modules/class-decisions/class-decisions.repository.js';
import {
  ClassDecisionsService,
  isEndOfYearReviewVisible,
} from '../../src/modules/class-decisions/class-decisions.service.js';

const activeSchoolYear = {
  id: '550e8400-e29b-41d4-a716-446655440001',
  label: '09/2026 - 06/2027',
  endDate: '2027-06-30',
  endOfYearReviewStartDate: '2027-05-31',
};

const repository = {
  getActiveSchoolYear: vi.fn(),
  listForSchoolYear: vi.fn(),
  listLevels: vi.fn(),
  listClasses: vi.fn(),
  levelExists: vi.fn(),
  validateDecision: vi.fn(),
  validateBulkDecisions: vi.fn(),
} as unknown as ClassDecisionsRepository;

describe('end-of-year review visibility', () => {
  it('reste masquée avant la date seuil', () => {
    expect(isEndOfYearReviewVisible('2027-05-31', '2027-05-30')).toBe(false);
  });

  it('devient visible à la date seuil', () => {
    expect(isEndOfYearReviewVisible('2027-05-31', '2027-05-31')).toBe(true);
  });

  it("reste masquée lorsqu'aucune année n'est active", async () => {
    vi.mocked(repository.getActiveSchoolYear).mockResolvedValue(null);
    const service = new ClassDecisionsService(repository);
    await expect(service.getReviewStatus('2027-06-01')).resolves.toEqual({
      visible: false,
      activeSchoolYear: null,
    });
  });

  it('expose l’année active une fois le seuil atteint', async () => {
    vi.mocked(repository.getActiveSchoolYear).mockResolvedValue(activeSchoolYear);
    const service = new ClassDecisionsService(repository);
    await expect(service.getReviewStatus('2027-05-31')).resolves.toEqual({
      visible: true,
      activeSchoolYear,
    });
  });

  it('prévisualise les décisions sans valider quand une moyenne générale est encore en attente', async () => {
    vi.mocked(repository.getActiveSchoolYear).mockResolvedValue(activeSchoolYear);
    vi.mocked(repository.listForSchoolYear).mockResolvedValue([
      {
        studentId: 'student-1', studentFirstName: 'Awa', studentLastName: 'Koné', studentMatricule: null,
        className: '3ème A', currentLevelId: 'level-3', currentLevelName: '3ème', generalAverage: 12,
        suggestedDecision: null, finalDecision: null, nextLevelId: null, nextLevelName: null, validatedAt: null,
      },
      {
        studentId: 'student-2', studentFirstName: 'Jean', studentLastName: 'Assimi', studentMatricule: null,
        className: '3ème A', currentLevelId: 'level-3', currentLevelName: '3ème', generalAverage: null,
        suggestedDecision: null, finalDecision: null, nextLevelId: null, nextLevelName: null, validatedAt: null,
      },
    ]);
    vi.mocked(repository.listLevels).mockResolvedValue([
      { id: 'level-3', name: '3ème', orderIndex: 3 },
      { id: 'level-4', name: '2nde', orderIndex: 4 },
    ]);
    vi.mocked(repository.levelExists).mockResolvedValue(true);

    const service = new ClassDecisionsService(repository);
    const input = {
      levelId: 'level-3', threshold: 10,
      atOrAbove: { finalDecision: 'promoted' as const, nextLevelId: 'level-4' },
      below: { finalDecision: 'repeat' as const, nextLevelId: 'level-3' },
    };

    const preview = await service.previewBulkDecisions(input, '2027-06-01');
    expect(preview).toMatchObject({ eligibleCount: 1, pendingCount: 1, canApply: false });
    expect(preview.items[0]).toMatchObject({ proposedDecision: 'promoted', proposedNextLevelName: '2nde' });
    expect(preview.items[1]).toMatchObject({ blockingReason: 'GENERAL_AVERAGE_PENDING' });

    await expect(service.validateBulkDecisions(input, 'user-1', '2027-06-01')).rejects.toMatchObject({
      code: 'GENERAL_AVERAGES_PENDING',
      statusCode: 409,
    });
    expect(repository.validateBulkDecisions).not.toHaveBeenCalled();
  });

  it('valide atomiquement la prévisualisation quand toutes les moyennes sont prêtes', async () => {
    vi.mocked(repository.getActiveSchoolYear).mockResolvedValue(activeSchoolYear);
    vi.mocked(repository.listForSchoolYear).mockResolvedValue([
      {
        studentId: 'student-1', studentFirstName: 'Awa', studentLastName: 'Koné', studentMatricule: null,
        className: '3ème A', currentLevelId: 'level-3', currentLevelName: '3ème', generalAverage: 8,
        suggestedDecision: null, finalDecision: null, nextLevelId: null, nextLevelName: null, validatedAt: null,
      },
    ]);
    vi.mocked(repository.listLevels).mockResolvedValue([{ id: 'level-3', name: '3ème', orderIndex: 3 }]);
    vi.mocked(repository.levelExists).mockResolvedValue(true);
    vi.mocked(repository.validateBulkDecisions).mockResolvedValue(undefined);

    const service = new ClassDecisionsService(repository);
    const result = await service.validateBulkDecisions({
      classId: 'class-1', threshold: 10,
      atOrAbove: { finalDecision: 'expelled', nextLevelId: null },
      below: { finalDecision: 'repeat', nextLevelId: 'level-3' },
    }, 'user-1', '2027-06-01');

    expect(result).toMatchObject({ eligibleCount: 1, canApply: true });
    expect(repository.validateBulkDecisions).toHaveBeenCalledWith([{
      studentId: 'student-1', schoolYearId: activeSchoolYear.id, finalDecision: 'repeat',
      nextLevelId: 'level-3', validatedByUserId: 'user-1',
    }]);
  });
});
