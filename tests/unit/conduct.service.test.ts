import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConductRepository } from '../../src/modules/conduct/conduct.repository.js';
import { ConductService } from '../../src/modules/conduct/conduct.service.js';

const repository = {
  listEducatorAssignments: vi.fn(),
  findEducatorAssignmentById: vi.fn(),
  administrativeUserExists: vi.fn(),
  userHoldsConductFinalize: vi.fn(),
  insertEducatorAssignment: vi.fn(),
  deleteEducatorAssignment: vi.fn(),
  findStudentContext: vi.fn(),
  findTeacherByUserId: vi.fn(),
  teacherTeachesClass: vi.fn(),
  gradingPeriodExists: vi.fn(),
  gradingPeriodLabel: vi.fn(),
  insertTeacherConductInput: vi.fn(),
  listConductInputsForStudent: vi.fn(),
  listSpontaneousEvaluationsForStudent: vi.fn(),
  findFinalGrade: vi.fn(),
  upsertConductGrade: vi.fn(),
  isAssignedEducatorForStudent: vi.fn(),
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
    repository.insertTeacherConductInput.mockResolvedValue(undefined);

    await expect(service.submitTeacherConductInput(baseInput, { userId: 'user-teacher' })).resolves.toBeUndefined();

    expect(repository.insertTeacherConductInput).toHaveBeenCalledWith({
      ...baseInput,
      teacherId: 'teacher-1',
    });
  });
});

describe('conduct.service decideConductGrade', () => {
  const gradeBody = {
    student_id: 'student-1',
    grading_period_id: 'period-1',
    note: 17,
  };

  it('applique le coefficient par défaut de 1 quand absent', async () => {
    const service = new ConductService(repository);
    repository.findStudentContext.mockResolvedValue(studentContext);
    repository.gradingPeriodExists.mockResolvedValue(true);
    repository.isAssignedEducatorForStudent.mockResolvedValue(true);
    repository.upsertConductGrade.mockResolvedValue(undefined);

    await service.decideConductGrade(gradeBody, { userId: 'educator-user' });

    expect(repository.upsertConductGrade).toHaveBeenCalledWith(
      expect.objectContaining({ coefficient: 1, decidedByUserId: 'educator-user' })
    );
  });

  it('conserve le coefficient fourni', async () => {
    const service = new ConductService(repository);
    repository.findStudentContext.mockResolvedValue(studentContext);
    repository.gradingPeriodExists.mockResolvedValue(true);
    repository.isAssignedEducatorForStudent.mockResolvedValue(true);
    repository.upsertConductGrade.mockResolvedValue(undefined);

    await service.decideConductGrade({ ...gradeBody, coefficient: 2 }, { userId: 'educator-user' });

    expect(repository.upsertConductGrade).toHaveBeenCalledWith(
      expect.objectContaining({ coefficient: 2 })
    );
  });

  it("refuse l'utilisateur non assigné à la classe ou au niveau de l'élève", async () => {
    const service = new ConductService(repository);
    repository.findStudentContext.mockResolvedValue(studentContext);
    repository.gradingPeriodExists.mockResolvedValue(true);
    repository.isAssignedEducatorForStudent.mockResolvedValue(false);

    await expect(service.decideConductGrade(gradeBody, { userId: 'other-educator' })).rejects.toMatchObject({
      code: 'NOT_ASSIGNED_EDUCATOR',
      statusCode: 403,
    });

    expect(repository.upsertConductGrade).not.toHaveBeenCalled();
  });
});
