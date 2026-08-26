import { ConductRepository } from './conduct.repository.js';
import type {
  ConductGradeBody,
  ConductInputBody,
  ConductOverview,
  EducatorAssignmentBody,
  EducatorAssignmentItem,
} from './conduct.types.js';

export class ConductModuleError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string
  ) {
    super(message);
    this.name = 'ConductModuleError';
  }
}

export class ConductService {
  constructor(private readonly repository: ConductRepository) {}

  async listEducatorAssignments(): Promise<{ assignments: EducatorAssignmentItem[] }> {
    return { assignments: await this.repository.listEducatorAssignments() };
  }

  async createEducatorAssignment(
    input: EducatorAssignmentBody,
    context: { assignedBy: string }
  ): Promise<{ assignment: { id: string | null } }> {
    const [targetHoldsPermission, targetIsAdministrative] = await Promise.all([
      this.repository.userHoldsConductFinalize(input.user_id),
      this.repository.administrativeUserExists(input.user_id),
    ]);

    if (!targetIsAdministrative) {
      throw new ConductModuleError(
        "L'utilisateur cible doit être un utilisateur actif de l'école",
        400,
        'INVALID_ASSIGNMENT_TARGET'
      );
    }

    // Règle métier : on ne peut assigner qu'un utilisateur détenant
    // effectivement la permission conduct.finalize.
    if (!targetHoldsPermission) {
      throw new ConductModuleError(
        "Cet utilisateur ne détient pas la permission conduct.finalize : attribuez-la d'abord à son poste",
        400,
        'CONDUCT_FINALIZE_PERMISSION_MISSING'
      );
    }

    await this.repository.insertEducatorAssignment({
      classId: input.class_id,
      levelId: input.level_id,
      userId: input.user_id,
      assignedBy: context.assignedBy,
    });

    return { assignment: { id: null } };
  }

  async deleteEducatorAssignment(id: string): Promise<{ deleted: boolean }> {
    const existing = await this.repository.findEducatorAssignmentById(id);
    if (!existing) {
      throw new ConductModuleError('Assignation introuvable', 404, 'EDUCATOR_ASSIGNMENT_NOT_FOUND');
    }
    const deleted = await this.repository.deleteEducatorAssignment(id);
    return { deleted };
  }

  async submitTeacherConductInput(input: ConductInputBody, context: { userId: string }): Promise<void> {
    const teacher = await this.repository.findTeacherByUserId(context.userId);
    if (!teacher) {
      throw new ConductModuleError('Profil professeur introuvable', 403, 'TEACHER_PROFILE_NOT_FOUND');
    }

    const student = await this.repository.findStudentContext(input.student_id);
    if (!student) {
      throw new ConductModuleError('Élève introuvable', 404, 'STUDENT_NOT_FOUND');
    }

    if (!(await this.repository.gradingPeriodExists(input.grading_period_id))) {
      throw new ConductModuleError('Période d\u2019évaluation introuvable', 404, 'GRADING_PERIOD_NOT_FOUND');
    }

    // Un prof ne saisit la conduite que pour les élèves de ses classes.
    const teachesClass = await this.repository.teacherTeachesClass(teacher.id, student.classId);
    if (!teachesClass) {
      throw new ConductModuleError(
        'Cet élève n\u2019est pas dans une de vos classes',
        403,
        'STUDENT_NOT_IN_TEACHER_CLASSES'
      );
    }

    await this.repository.insertTeacherConductInput({ ...input, teacherId: teacher.id });
  }

  async getConductOverview(studentId: string, gradingPeriodId: string): Promise<ConductOverview> {
    const student = await this.repository.findStudentContext(studentId);
    if (!student) {
      throw new ConductModuleError('Élève introuvable', 404, 'STUDENT_NOT_FOUND');
    }

    const periodRow = await this.repository.gradingPeriodLabel(gradingPeriodId);
    if (!periodRow) {
      throw new ConductModuleError('Période d\u2019évaluation introuvable', 404, 'GRADING_PERIOD_NOT_FOUND');
    }

    const [teacherInputs, spontaneousEvaluations, finalGrade] = await Promise.all([
      this.repository.listConductInputsForStudent(studentId, gradingPeriodId),
      this.repository.listSpontaneousEvaluationsForStudent(studentId, gradingPeriodId),
      this.repository.findFinalGrade(studentId, gradingPeriodId),
    ]);

    return {
      student: {
        id: student.studentId,
        fullName: student.fullName,
        className: student.className,
      },
      gradingPeriod: {
        id: periodRow.id,
        label: periodRow.label,
      },
      teacherInputs,
      spontaneousEvaluations,
      finalGrade,
    };
  }

  async decideConductGrade(input: ConductGradeBody, context: { userId: string }): Promise<void> {
    const student = await this.repository.findStudentContext(input.student_id);
    if (!student) {
      throw new ConductModuleError('Élève introuvable', 404, 'STUDENT_NOT_FOUND');
    }

    if (!(await this.repository.gradingPeriodExists(input.grading_period_id))) {
      throw new ConductModuleError('Période d\u2019évaluation introuvable', 404, 'GRADING_PERIOD_NOT_FOUND');
    }

    const isEducatorOfStudent = await this.repository.isAssignedEducatorForStudent(
      context.userId,
      input.student_id
    );
    if (!isEducatorOfStudent) {
      throw new ConductModuleError(
        'Vous n\u2019êtes pas l\u2019éducateur assigné à la classe ou au niveau de cet élève',
        403,
        'NOT_ASSIGNED_EDUCATOR'
      );
    }

    await this.repository.upsertConductGrade({
      ...input,
      coefficient: input.coefficient ?? 1,
      decidedByUserId: context.userId,
    });
  }
}

export const buildConductService = (db: ConstructorParameters<typeof ConductRepository>[0]) =>
  new ConductService(new ConductRepository(db));
