import { ConductRepository } from './conduct.repository.js';
import type {
  ConductGradeBody,
  ConductInputBody,
  BulkConductInputBody,
  ConductOverview,
  EducatorAssignmentBody,
  EducatorAssignmentItem,
  ConductPolicyMode,
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

  private async assertConductReviewOpen(gradingPeriodId: string): Promise<void> {
    const state = await this.repository.getConductReviewState(gradingPeriodId);
    if (state === 'open') return;
    if (state === 'before') {
      throw new ConductModuleError('La revue de conduite de cette période n’est pas encore ouverte', 409, 'CONDUCT_REVIEW_NOT_OPEN');
    }
    throw new ConductModuleError('La fenêtre de revue de conduite est terminée', 409, 'CONDUCT_REVIEW_CLOSED');
  }

  async getPolicy(schoolYearId: string) {
    const policy = await this.repository.findPolicy(schoolYearId);
    if (!policy) throw new ConductModuleError('Année scolaire introuvable', 404, 'SCHOOL_YEAR_NOT_FOUND');
    return { policy };
  }

  async updatePolicy(schoolYearId: string, mode: ConductPolicyMode, coefficient: number, userId: string) {
    const updated = await this.repository.updatePolicy(schoolYearId, mode, coefficient, userId);
    if (!updated) throw new ConductModuleError('Année scolaire introuvable', 404, 'SCHOOL_YEAR_NOT_FOUND');
    return this.getPolicy(schoolYearId);
  }

  async listEligibleEducators() { return { users: await this.repository.listEligibleEducators() }; }

  async listDecisionClasses(context: { userId: string; canFinalize: boolean }) {
    const classes = await this.repository.listDecisionClasses(context.userId, context.canFinalize);
    return { classes, gradingPeriods: await this.repository.listDecisionPeriods(classes.map(klass => klass.id)) };
  }

  async listDecisionStudents(classId: string, gradingPeriodId: string, context: { userId: string; canFinalize: boolean }) {
    const { classes, gradingPeriods } = await this.listDecisionClasses(context);
    const klass = classes.find(item => item.id === classId);
    if (!klass || !gradingPeriods.some(period => period.id === gradingPeriodId && period.schoolYearId === klass.schoolYearId)) {
      throw new ConductModuleError('Classe ou période non autorisée', 403, 'NOT_CONDUCT_DECIDER');
    }
    return { students: await this.repository.listDecisionStudents(classId, gradingPeriodId) };
  }

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

    if (!(await this.repository.educatorTargetExists(input.class_id, input.level_id))) {
      throw new ConductModuleError('Classe ou niveau introuvable', 400, 'INVALID_ASSIGNMENT_SCOPE');
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

    const student = await this.repository.findStudentContext(input.student_id, input.grading_period_id);
    if (!student) {
      throw new ConductModuleError('Élève introuvable', 404, 'STUDENT_NOT_FOUND');
    }

    if (!(await this.repository.gradingPeriodExists(input.grading_period_id))) {
      throw new ConductModuleError('Période d\u2019évaluation introuvable', 404, 'GRADING_PERIOD_NOT_FOUND');
    }
    await this.assertConductReviewOpen(input.grading_period_id);
    if (await this.repository.isGradingPeriodCompleted(input.grading_period_id, student.classId)) {
      throw new ConductModuleError('Cette période est finalisée : ses bulletins ont déjà été générés', 409, 'GRADING_PERIOD_COMPLETED');
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

    if (await this.repository.findFinalGrade(input.student_id, input.grading_period_id)) {
      throw new ConductModuleError('La note finale verrouille les avis enseignants', 409, 'CONDUCT_INPUT_LOCKED');
    }

    await this.repository.insertTeacherConductInput({ ...input, teacherId: teacher.id });
  }

  async getTeacherConductScope(
    classId: string,
    gradingPeriodId: string,
    context: { userId: string }
  ) {
    const teacher = await this.repository.findTeacherByUserId(context.userId);
    if (!teacher) {
      throw new ConductModuleError('Profil professeur introuvable', 403, 'TEACHER_PROFILE_NOT_FOUND');
    }
    if (!(await this.repository.teacherTeachesClass(teacher.id, classId))) {
      throw new ConductModuleError('Cette classe ne fait pas partie de vos cours', 403, 'CLASS_NOT_IN_TEACHER_SCOPE');
    }
    if (!(await this.repository.gradingPeriodMatchesClass(gradingPeriodId, classId))) {
      throw new ConductModuleError('La période ne correspond pas à la classe', 400, 'CONDUCT_SCOPE_MISMATCH');
    }
    return {
      isAvailable: true,
      students: await this.repository.listTeacherConductScope(teacher.id, classId, gradingPeriodId),
    };
  }

  async submitBulkTeacherConductInputs(
    input: BulkConductInputBody,
    context: { userId: string }
  ): Promise<{ savedCount: number }> {
    const teacher = await this.repository.findTeacherByUserId(context.userId);
    if (!teacher) {
      throw new ConductModuleError('Profil professeur introuvable', 403, 'TEACHER_PROFILE_NOT_FOUND');
    }
    if (!(await this.repository.teacherTeachesClass(teacher.id, input.class_id))) {
      throw new ConductModuleError('Cette classe ne fait pas partie de vos cours', 403, 'CLASS_NOT_IN_TEACHER_SCOPE');
    }
    if (!(await this.repository.gradingPeriodMatchesClass(input.grading_period_id, input.class_id))) {
      throw new ConductModuleError('La période ne correspond pas à la classe', 400, 'CONDUCT_SCOPE_MISMATCH');
    }
    await this.assertConductReviewOpen(input.grading_period_id);
    if (await this.repository.isGradingPeriodCompleted(input.grading_period_id, input.class_id)) {
      throw new ConductModuleError('Cette période est finalisée : ses bulletins ont déjà été générés', 409, 'GRADING_PERIOD_COMPLETED');
    }
    const locked = await Promise.all(input.student_ids.map(studentId => this.repository.findFinalGrade(studentId, input.grading_period_id)));
    if (locked.some(Boolean)) {
      throw new ConductModuleError('Une note finale verrouille les avis sélectionnés', 409, 'CONDUCT_INPUT_LOCKED');
    }
    if (!(await this.repository.studentsBelongToClass(input.student_ids, input.class_id))) {
      throw new ConductModuleError('Un élève sélectionné ne fait pas partie de la classe', 400, 'STUDENT_CLASS_MISMATCH');
    }
    for (const studentId of input.student_ids) {
      await this.repository.insertTeacherConductInput({
        student_id: studentId,
        grading_period_id: input.grading_period_id,
        note: input.note,
        observation: input.observation,
        teacherId: teacher.id,
      });
    }
    return { savedCount: input.student_ids.length };
  }

  private async assertCanManageFinalConduct(
    classId: string,
    gradingPeriodId: string,
    context: { userId: string; canFinalize: boolean }
  ): Promise<void> {
    if (await this.repository.canDecideClass(context.userId, context.canFinalize, classId, gradingPeriodId)) return;

    throw new ConductModuleError(
      'Vous ne pouvez pas décider la conduite de cette classe selon la politique de l’année',
      403,
      'NOT_CONDUCT_DECIDER'
    );
  }

  async getConductOverview(
    studentId: string,
    gradingPeriodId: string,
    context: { userId: string; canFinalize: boolean }
  ): Promise<ConductOverview> {
    const student = await this.repository.findStudentContext(studentId, gradingPeriodId);
    if (!student) {
      throw new ConductModuleError('Élève introuvable', 404, 'STUDENT_NOT_FOUND');
    }

    const periodRow = await this.repository.gradingPeriodLabel(gradingPeriodId);
    if (!periodRow) {
      throw new ConductModuleError('Période d\u2019évaluation introuvable', 404, 'GRADING_PERIOD_NOT_FOUND');
    }
    await this.assertCanManageFinalConduct(student.classId, gradingPeriodId, context);

    const [teacherInputs, spontaneousEvaluations, finalGrade] = await Promise.all([
      this.repository.listConductInputsForStudent(studentId, gradingPeriodId),
      this.repository.listSpontaneousEvaluationsForStudent(studentId, gradingPeriodId),
      this.repository.findFinalGrade(studentId, gradingPeriodId),
    ]);
    const submittedCount = teacherInputs.filter((input) => input.isSubmitted).length;
    const inputSummary = {
      expectedCount: teacherInputs.length,
      submittedCount,
      isComplete: teacherInputs.length > 0 && submittedCount === teacherInputs.length,
    };

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
      inputSummary,
      spontaneousEvaluations,
      finalGrade,
    };
  }

  async decideConductGrade(
    input: ConductGradeBody,
    context: { userId: string; canFinalize: boolean }
  ): Promise<void> {
    const student = await this.repository.findStudentContext(input.student_id, input.grading_period_id);
    if (!student) {
      throw new ConductModuleError('Élève introuvable', 404, 'STUDENT_NOT_FOUND');
    }

    if (!(await this.repository.gradingPeriodExists(input.grading_period_id))) {
      throw new ConductModuleError('Période d\u2019évaluation introuvable', 404, 'GRADING_PERIOD_NOT_FOUND');
    }
    await this.assertConductReviewOpen(input.grading_period_id);
    if (await this.repository.isGradingPeriodCompleted(input.grading_period_id, student.classId)) {
      throw new ConductModuleError('Cette période est finalisée : ses bulletins ont déjà été générés', 409, 'GRADING_PERIOD_COMPLETED');
    }

    await this.assertCanManageFinalConduct(student.classId, input.grading_period_id, context);

    const policy = await this.repository.findPolicyForPeriod(input.grading_period_id);
    if (!policy) throw new ConductModuleError('Période introuvable', 404, 'GRADING_PERIOD_NOT_FOUND');

    await this.repository.upsertConductGrade({
      ...input,
      coefficient: policy.coefficient,
      decidedByUserId: context.userId,
      canFinalize: context.canFinalize,
    });
  }
}

export const buildConductService = (db: ConstructorParameters<typeof ConductRepository>[0]) =>
  new ConductService(new ConductRepository(db));
