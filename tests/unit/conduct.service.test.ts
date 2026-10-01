import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConductRepository } from '../../src/modules/conduct/conduct.repository.js';
import { ConductService } from '../../src/modules/conduct/conduct.service.js';

const repository = {
  listEducatorAssignments: vi.fn(),
  findEducatorAssignmentById: vi.fn(),
  administrativeUserExists: vi.fn(),
  educatorTargetExists: vi.fn(),
  userHoldsConductFinalize: vi.fn(),
  insertEducatorAssignment: vi.fn(),
  deleteEducatorAssignment: vi.fn(),
  findStudentContext: vi.fn(),
  findTeacherByUserId: vi.fn(),
  teacherTeachesClass: vi.fn(),
  teacherHasAverageCalculation: vi.fn(),
  gradingPeriodExists: vi.fn(),
  isGradingPeriodCompleted: vi.fn(),
  isConductReviewOpen: vi.fn(),
  gradingPeriodMatchesClass: vi.fn(),
  studentsBelongToClass: vi.fn(),
  listTeacherConductScope: vi.fn(),
  gradingPeriodLabel: vi.fn(),
  insertTeacherConductInput: vi.fn(),
  listConductInputsForStudent: vi.fn(),
  listSpontaneousEvaluationsForStudent: vi.fn(),
  findFinalGrade: vi.fn(),
  findPolicyForPeriod: vi.fn(),
  canDecideClass: vi.fn(),
  upsertConductGrade: vi.fn(),
} as unknown as ConductRepository;

const studentContext = {
  studentId: 'student-1',
  fullName: 'Awa Koné',
  classId: 'class-1',
  className: '6ème A',
  levelId: 'level-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  repository.isGradingPeriodCompleted.mockResolvedValue(false);
  repository.isConductReviewOpen.mockResolvedValue(true);
  repository.educatorTargetExists.mockResolvedValue(true);
  repository.findFinalGrade.mockResolvedValue(null);
  repository.findPolicyForPeriod.mockResolvedValue({ mode: 'homeroom', coefficient: 1 });
  repository.canDecideClass.mockResolvedValue(true);
  repository.teacherHasAverageCalculation.mockResolvedValue(true);
  repository.listConductInputsForStudent.mockResolvedValue([
    { teacherId: 'teacher-1', isSubmitted: true, note: 16 },
  ]);
});

describe('conduct.service createEducatorAssignment', () => {
  it('refuse un utilisateur ne détenant pas conduct.finalize', async () => {
    const service = new ConductService(repository);
    repository.administrativeUserExists.mockResolvedValue(true);
    repository.userHoldsConductFinalize.mockResolvedValue(false);

    await expect(
      service.createEducatorAssignment(
        { user_id: 'user-staff', class_id: 'class-1' },
        { assignedBy: 'director-1' }
      )
    ).rejects.toMatchObject({
      code: 'CONDUCT_FINALIZE_PERMISSION_MISSING',
      statusCode: 400,
    });

    expect(repository.insertEducatorAssignment).not.toHaveBeenCalled();
  });

  it('refuse un utilisateur inexistant ou inactif', async () => {
    const service = new ConductService(repository);
    repository.administrativeUserExists.mockResolvedValue(false);
    repository.userHoldsConductFinalize.mockResolvedValue(true);

    await expect(
      service.createEducatorAssignment(
        { user_id: 'ghost', level_id: 'level-1' },
        { assignedBy: 'director-1' }
      )
    ).rejects.toMatchObject({ code: 'INVALID_ASSIGNMENT_TARGET', statusCode: 400 });
  });

  it('assigne un utilisateur détenant effectivement la permission', async () => {
    const service = new ConductService(repository);
    repository.administrativeUserExists.mockResolvedValue(true);
    repository.userHoldsConductFinalize.mockResolvedValue(true);
    repository.insertEducatorAssignment.mockResolvedValue(undefined);

    await expect(
      service.createEducatorAssignment(
        { user_id: 'user-staff', class_id: 'class-1' },
        { assignedBy: 'director-1' }
      )
    ).resolves.toEqual({ assignment: { id: null } });

    expect(repository.insertEducatorAssignment).toHaveBeenCalledWith({
      classId: 'class-1',
      levelId: undefined,
      userId: 'user-staff',
      assignedBy: 'director-1',
    });
  });
});

describe('conduct.service submitTeacherConductInput', () => {
  const baseInput = {
    student_id: 'student-1',
    grading_period_id: 'period-1',
    note: 15,
    observation: 'Comportement exemplaire',
  };

  it("refuse un élève qui n'est pas dans les classes du prof", async () => {
    const service = new ConductService(repository);
    repository.findTeacherByUserId.mockResolvedValue({ id: 'teacher-1', name: 'Ibrahim Diallo' });
    repository.findStudentContext.mockResolvedValue(studentContext);
    repository.gradingPeriodExists.mockResolvedValue(true);
    repository.teacherTeachesClass.mockResolvedValue(false);

    await expect(service.submitTeacherConductInput(baseInput, { userId: 'user-teacher' })).rejects.toMatchObject({
      code: 'STUDENT_NOT_IN_TEACHER_CLASSES',
      statusCode: 403,
    });

    expect(repository.insertTeacherConductInput).not.toHaveBeenCalled();
  });

  it('refuse un prof sans profil enseignant', async () => {
    const service = new ConductService(repository);
    repository.findTeacherByUserId.mockResolvedValue(null);

    await expect(service.submitTeacherConductInput(baseInput, { userId: 'user-staff' })).rejects.toMatchObject({
      code: 'TEACHER_PROFILE_NOT_FOUND',
      statusCode: 403,
    });
  });

  it('insère la saisie pour un élève des classes du prof', async () => {
    const service = new ConductService(repository);
    repository.findTeacherByUserId.mockResolvedValue({ id: 'teacher-1', name: 'Ibrahim Diallo' });
    repository.findStudentContext.mockResolvedValue(studentContext);
    repository.gradingPeriodExists.mockResolvedValue(true);
    repository.teacherTeachesClass.mockResolvedValue(true);
    repository.teacherHasAverageCalculation.mockResolvedValue(true);
    repository.insertTeacherConductInput.mockResolvedValue(undefined);

    await expect(service.submitTeacherConductInput(baseInput, { userId: 'user-teacher' })).resolves.toBeUndefined();

    expect(repository.insertTeacherConductInput).toHaveBeenCalledWith({
      ...baseInput,
      teacherId: 'teacher-1',
    });
    expect(repository.isGradingPeriodCompleted).toHaveBeenCalledWith(baseInput.grading_period_id, studentContext.classId);
  });

  it('refuse uniquement la classe dont les bulletins sont déjà générés', async () => {
    const service = new ConductService(repository);
    repository.findTeacherByUserId.mockResolvedValue({ id: 'teacher-1' });
    repository.findStudentContext.mockResolvedValue(studentContext);
    repository.gradingPeriodExists.mockResolvedValue(true);
    repository.isGradingPeriodCompleted.mockResolvedValue(true);
    await expect(service.submitTeacherConductInput(baseInput, { userId: 'user-teacher' }))
      .rejects.toMatchObject({ code: 'GRADING_PERIOD_COMPLETED', statusCode: 409 });
    expect(repository.isGradingPeriodCompleted).toHaveBeenCalledWith(baseInput.grading_period_id, studentContext.classId);
    expect(repository.insertTeacherConductInput).not.toHaveBeenCalled();
  });

  it('accepte un avis pendant la revue avant le calcul des moyennes', async () => {
    const service = new ConductService(repository);
    repository.findTeacherByUserId.mockResolvedValue({ id: 'teacher-1', name: 'Ibrahim Diallo' });
    repository.findStudentContext.mockResolvedValue(studentContext);
    repository.gradingPeriodExists.mockResolvedValue(true);
    repository.teacherTeachesClass.mockResolvedValue(true);
    repository.teacherHasAverageCalculation.mockResolvedValue(false);

    await expect(service.submitTeacherConductInput(baseInput, { userId: 'user-teacher' })).resolves.toBeUndefined();
  });

});

describe('conduct.service submitBulkTeacherConductInputs', () => {
  it('valide le périmètre puis crée une saisie pour chaque élève sélectionné', async () => {
    const service = new ConductService(repository);
    repository.findTeacherByUserId.mockResolvedValue({ id: 'teacher-1', name: 'Ibrahim Diallo' });
    repository.teacherTeachesClass.mockResolvedValue(true);
    repository.teacherHasAverageCalculation.mockResolvedValue(true);
    repository.gradingPeriodMatchesClass.mockResolvedValue(true);
    repository.studentsBelongToClass.mockResolvedValue(true);
    repository.insertTeacherConductInput.mockResolvedValue(undefined);

    await expect(service.submitBulkTeacherConductInputs({
      class_id: 'class-1',
      student_ids: ['student-1', 'student-2'],
      grading_period_id: 'period-1',
      note: 16,
      observation: 'Sérieux',
    }, { userId: 'user-teacher' })).resolves.toEqual({ savedCount: 2 });

    expect(repository.insertTeacherConductInput).toHaveBeenCalledTimes(2);
  });

  it('refuse le lot si un élève est hors de la classe', async () => {
    const service = new ConductService(repository);
    repository.findTeacherByUserId.mockResolvedValue({ id: 'teacher-1', name: 'Ibrahim Diallo' });
    repository.teacherTeachesClass.mockResolvedValue(true);
    repository.teacherHasAverageCalculation.mockResolvedValue(true);
    repository.gradingPeriodMatchesClass.mockResolvedValue(true);
    repository.studentsBelongToClass.mockResolvedValue(false);

    await expect(service.submitBulkTeacherConductInputs({
      class_id: 'class-1',
      student_ids: ['student-outside'],
      grading_period_id: 'period-1',
      note: 16,
    }, { userId: 'user-teacher' })).rejects.toMatchObject({ code: 'STUDENT_CLASS_MISMATCH' });
    expect(repository.insertTeacherConductInput).not.toHaveBeenCalled();
  });
});

describe('conduct.service getTeacherConductScope', () => {
  it('conserve les notes de conduite consultables après validation des moyennes', async () => {
    const service = new ConductService(repository);
    repository.findTeacherByUserId.mockResolvedValue({ id: 'teacher-1', name: 'Ibrahim Diallo' });
    repository.teacherTeachesClass.mockResolvedValue(true);
    repository.gradingPeriodMatchesClass.mockResolvedValue(true);
    repository.teacherHasAverageCalculation.mockResolvedValue(true);
    repository.listTeacherConductScope.mockResolvedValue([{ studentId: 'student-1', input: { note: 16 } }]);

    await expect(service.getTeacherConductScope('class-1', 'period-1', { userId: 'user-teacher' })).resolves.toEqual({
      isAvailable: true,
      students: [{ studentId: 'student-1', input: { note: 16 } }],
    });
  });
});

describe('conduct.service decideConductGrade', () => {
  const gradeBody = {
    student_id: 'student-1',
    grading_period_id: 'period-1',
    note: 17,
  };

  it('applique le coefficient annuel de 1', async () => {
    const service = new ConductService(repository);
    repository.findStudentContext.mockResolvedValue(studentContext);
    repository.gradingPeriodExists.mockResolvedValue(true);
    repository.findPolicyForPeriod.mockResolvedValue({ mode: 'delegated', coefficient: 1 });
    repository.upsertConductGrade.mockResolvedValue(undefined);

    await service.decideConductGrade(gradeBody, { userId: 'educator-user', canFinalize: true });

    expect(repository.upsertConductGrade).toHaveBeenCalledWith(
      expect.objectContaining({ coefficient: 1, decidedByUserId: 'educator-user' })
    );
  });

  it('utilise le coefficient annuel configuré', async () => {
    const service = new ConductService(repository);
    repository.findStudentContext.mockResolvedValue(studentContext);
    repository.gradingPeriodExists.mockResolvedValue(true);
    repository.findPolicyForPeriod.mockResolvedValue({ mode: 'delegated', coefficient: 2 });
    repository.upsertConductGrade.mockResolvedValue(undefined);

    await service.decideConductGrade(gradeBody, { userId: 'educator-user', canFinalize: true });

    expect(repository.upsertConductGrade).toHaveBeenCalledWith(
      expect.objectContaining({ coefficient: 2 })
    );
  });

  it("refuse l'utilisateur non assigné à la classe ou au niveau de l'élève", async () => {
    const service = new ConductService(repository);
    repository.findStudentContext.mockResolvedValue(studentContext);
    repository.gradingPeriodExists.mockResolvedValue(true);
    repository.canDecideClass.mockResolvedValue(false);
    repository.findPolicyForPeriod.mockResolvedValue({ mode: 'delegated', coefficient: 1 });

    await expect(service.decideConductGrade(gradeBody, { userId: 'other-educator', canFinalize: true })).rejects.toMatchObject({
      code: 'NOT_CONDUCT_DECIDER',
      statusCode: 403,
    });

    expect(repository.upsertConductGrade).not.toHaveBeenCalled();
  });

  it('autorise le professeur principal sans la permission conduct.finalize', async () => {
    const service = new ConductService(repository);
    repository.findStudentContext.mockResolvedValue(studentContext);
    repository.gradingPeriodExists.mockResolvedValue(true);
    repository.upsertConductGrade.mockResolvedValue(undefined);

    await service.decideConductGrade(gradeBody, { userId: 'homeroom-teacher', canFinalize: false });

    expect(repository.upsertConductGrade).toHaveBeenCalledWith(
      expect.objectContaining({ decidedByUserId: 'homeroom-teacher', coefficient: 1 })
    );
    expect(repository.canDecideClass).toHaveBeenCalledWith('homeroom-teacher', false, 'class-1', 'period-1');
  });

  it('décide malgré les avis manquants', async () => {
    const service = new ConductService(repository);
    repository.findStudentContext.mockResolvedValue(studentContext);
    repository.gradingPeriodExists.mockResolvedValue(true);
    repository.listConductInputsForStudent.mockResolvedValue([
      { teacherId: 'teacher-1', isSubmitted: true, note: 16 },
      { teacherId: 'teacher-2', isSubmitted: false, note: null },
    ]);

    await expect(service.decideConductGrade(gradeBody, { userId: 'homeroom-teacher', canFinalize: false })).resolves.toBeUndefined();
    expect(repository.upsertConductGrade).toHaveBeenCalled();
  });

  it('décide sans aucun avis', async () => {
    const service = new ConductService(repository);
    repository.findStudentContext.mockResolvedValue(studentContext);
    repository.gradingPeriodExists.mockResolvedValue(true);
    repository.listConductInputsForStudent.mockResolvedValue([]);
    await expect(service.decideConductGrade(gradeBody, { userId: 'homeroom-teacher', canFinalize: false })).resolves.toBeUndefined();
  });

  it('autorise seulement un directeur actif en mode direction', async () => {
    const service = new ConductService(repository);
    repository.findStudentContext.mockResolvedValue(studentContext);
    repository.gradingPeriodExists.mockResolvedValue(true);
    repository.findPolicyForPeriod.mockResolvedValue({ mode: 'direction', coefficient: 1 });
    repository.canDecideClass.mockResolvedValue(true);
    await expect(service.decideConductGrade(gradeBody, { userId: 'director', canFinalize: false })).resolves.toBeUndefined();
    repository.canDecideClass.mockResolvedValue(false);
    await expect(service.decideConductGrade(gradeBody, { userId: 'other', canFinalize: true }))
      .rejects.toMatchObject({ code: 'NOT_CONDUCT_DECIDER' });
  });
});
