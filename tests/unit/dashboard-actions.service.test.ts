import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DashboardActionsRepository } from '../../src/modules/dashboard-actions/dashboard-actions.repository.js';
import { DashboardActionsService } from '../../src/modules/dashboard-actions/dashboard-actions.service.js';

const repository = {
  listOpen: vi.fn(),
  replaceType: vi.fn(),
  resolve: vi.fn(),
  countRiskByLevel: vi.fn(),
  listBlockedClasses: vi.fn(),
} as unknown as DashboardActionsRepository;

beforeEach(() => {
  vi.clearAllMocks();
  repository.countRiskByLevel.mockResolvedValue({});
  repository.listBlockedClasses.mockResolvedValue([]);
  repository.replaceType.mockResolvedValue(undefined);
});

describe('DashboardActionsService.generateAll (8 types)', () => {
  const sources = {
    weeklyAbsenceCount: 5,
    salaryPendingCount: 2,
    pendingValidations: 4,
    commissionOverdueCount: 1,
  };

  it('génère les 4 items migrés quand les conditions sources sont réunies', async () => {
    const service = new DashboardActionsService(repository);
    await service.generateAll(sources);

    const types = repository.replaceType.mock.calls.map((call) => call[0]);
    expect(types).toContain('teacher_absences_high');
    expect(types).toContain('salary_pending');
    expect(types).toContain('validations_pending');
    expect(types).toContain('commission_overdue');

    // Priorités attendues
    const byType = new Map(
      repository.replaceType.mock.calls.map((call) => [call[0], call[1] as Array<Record<string, unknown>>]),
    );
    expect(byType.get('teacher_absences_high')![0]!.priority).toBe('high');
    expect(byType.get('validations_pending')![0]!.priority).toBe('high');
    expect(byType.get('salary_pending')![0]!.priority).toBe('medium');
    expect(byType.get('commission_overdue')![0]!.priority).toBe('medium');
  });

  it("résout automatiquement un item dont la condition source disparaît", async () => {
    const service = new DashboardActionsService(repository);
    // Aucune absence cette semaine : le type est régénéré à vide → resolved.
    await service.generateAll({ ...sources, weeklyAbsenceCount: 2 });

    const call = repository.replaceType.mock.calls.find((call) => call[0] === 'teacher_absences_high');
    expect(call).toBeDefined();
    expect(call![1]).toHaveLength(0);
  });

  it('utilise le seuil > 3 repris du bloc remplacé', async () => {
    const service = new DashboardActionsService(repository);
    await service.generateAll({ ...sources, weeklyAbsenceCount: 3 });
    let call = repository.replaceType.mock.calls.find((call) => call[0] === 'teacher_absences_high');
    expect(call![1]).toHaveLength(0); // 3 = pas au-dessus du seuil

    vi.clearAllMocks();
    repository.countRiskByLevel.mockResolvedValue({});
    repository.listBlockedClasses.mockResolvedValue([]);
    await service.generateAll({ ...sources, weeklyAbsenceCount: 4 });
    call = repository.replaceType.mock.calls.find((call) => call[0] === 'teacher_absences_high');
    expect(call![1]).toHaveLength(1);
  });

  it('génère student_at_risk / teacher_at_risk depuis les niveaux de risque', async () => {
    const service = new DashboardActionsService(repository);
    repository.countRiskByLevel.mockResolvedValue({ warning: 6, critical: 2 });
    await service.generateAll({});

    const calls = repository.replaceType.mock.calls;
    const studentCall = calls.find((call) => call[0] === 'student_at_risk')!;
    const teacherCall = calls.find((call) => call[0] === 'teacher_at_risk')!;
    expect(studentCall[1][0]!.message).toContain('8 élève(s)');
    expect(studentCall[1][0]!.priority).toBe('high'); // >= 5
    expect(teacherCall[1][0]!.message).toContain('2 prof(s)');
  });

  it('génère report_cards_blocked par classe avec référence', async () => {
    const service = new DashboardActionsService(repository);
    repository.listBlockedClasses.mockResolvedValue([
      { classId: 'class-9', className: '5ème B', incomplete: 3 },
    ]);
    await service.generateAll({});

    const call = repository.replaceType.mock.calls.find((call) => call[0] === 'report_cards_blocked')!;
    expect(call[1]).toHaveLength(1);
    expect(call[1][0]).toMatchObject({
      referenceId: 'class-9',
      priority: 'medium',
      message: expect.stringContaining('5ème B'),
    });
  });
});
