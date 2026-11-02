import { EnrollmentsRepository, type EnrollmentRow, type ReEnrollmentCandidateRow, type StudentAcademicSummaryRow, type StudentDocumentRow } from './enrollments.repository.js';
import type { EnrollmentStatus, EnrollmentType, StudentDocumentStatus } from './enrollments.types.js';
import { buildFinanceService } from '../finance/finance.service.js';
import type { PaymentMethod } from '../finance/finance.types.js';

export class EnrollmentsModuleError extends Error {
  constructor(message: string, public readonly statusCode: number, public readonly code: string) {
    super(message);
    this.name = 'EnrollmentsModuleError';
  }
}

const iso = (value: Date | string | null): string | null => value ? new Date(value).toISOString() : null;
const mapEnrollment = (row: EnrollmentRow) => ({
  id: row.id,
  studentId: row.student_id,
  classId: row.class_id,
  className: row.class_name,
  studentFirstName: row.student_first_name,
  studentLastName: row.student_last_name,
  schoolYearId: row.school_year_id,
  schoolYearLabel: row.school_year_label,
  type: row.type,
  status: row.status,
  enrolledAt: iso(row.enrolled_at),
  confirmedByUserId: row.confirmed_by_user_id,
  documentStatus: Number(row.required_document_count ?? 0) === 0
    ? 'not_configured' as const
    : Number(row.missing_mandatory_document_count ?? 0) === 0
      ? 'complete' as const
      : 'incomplete' as const,
  missingMandatoryDocumentCount: Number(row.missing_mandatory_document_count ?? 0),
});
const mapDocument = (row: StudentDocumentRow) => ({
  id: row.id,
  studentId: row.student_id,
  documentTypeId: row.document_type_id,
  documentTypeName: row.document_type_name,
  isMandatory: row.is_mandatory,
  isActive: row.is_active,
  status: row.status,
  fileUrl: row.file_url,
  r2Key: row.r2_key,
  providedAt: iso(row.provided_at),
  notes: row.notes,
});
const mapReEnrollmentCandidate = (row: ReEnrollmentCandidateRow) => ({
  studentId: row.student_id,
  studentFirstName: row.student_first_name,
  studentLastName: row.student_last_name,
  studentMatricule: row.student_matricule,
  currentClassName: row.current_class_name,
  currentSchoolYearId: row.current_school_year_id,
  currentSchoolYearLabel: row.current_school_year_label,
  finalDecision: row.final_decision,
  nextLevelId: row.next_level_id,
  nextLevelName: row.next_level_name,
  sourceSchoolYearStatus: row.source_school_year_status,
  isHistoricalSource: row.is_historical_source,
  enrollment: row.enrollment_id && row.enrollment_status
    ? {
        id: row.enrollment_id,
        status: row.enrollment_status,
        className: row.enrollment_class_name ?? row.current_class_name,
      }
    : null,
});

const mapDecisionLabel = (decision: StudentAcademicSummaryRow['final_decision']): string => {
  if (decision === 'promoted') return 'Admis(e)';
  if (decision === 'repeat') return 'Redouble';
  if (decision === 'expelled') return 'Exclu(e)';
  return 'Non renseignée';
};

export const deduplicateRequiredDocuments = (documents: StudentDocumentRow[]): StudentDocumentRow[] => {
  const byType = new Map<string, StudentDocumentRow>();
  for (const document of documents) byType.set(document.document_type_id, document);
  return [...byType.values()];
};

export const resolveInitialEnrollmentStatus = (
  type: EnrollmentType,
  hasPreviousYearUnpaid: boolean
): EnrollmentStatus => type === 're_registration' && hasPreviousYearUnpaid
  ? 'blocked_unpaid'
  : 'pending_cashier';

export const canTransitionEnrollment = (from: EnrollmentStatus, to: EnrollmentStatus): boolean => {
  if (from === to) return true;
  if (from === 'confirmed' || from === 'blocked_unpaid') return false;
  return to === 'pending_cashier' || to === 'pending_dossier' || to === 'confirmed';
};

export class EnrollmentsService {
  constructor(
    private readonly repository: EnrollmentsRepository,
    private readonly finance?: {
      recordEnrollmentPayment(input: {
        enrollmentId: string;
        actorUserId: string;
        amount: number;
        method: PaymentMethod;
        providerReference?: string;
        schoolReceiptReference: string;
      }): Promise<{ payment: { id: string } & Record<string, unknown> }>;
      getFinancialStatus(studentId: string, schoolYearId: string): Promise<{
        remainingDue: number;
        currency?: string;
        totalDue?: number;
        confirmedPaid?: number;
        standing?: 'up_to_date' | 'late';
      }>;
      getHistoricalFinancialStatus?(studentId: string, schoolYearId: string): Promise<{
        remainingDue: number;
        currency?: string;
        totalDue?: number;
        confirmedPaid?: number;
      }>;
      listReEnrollmentBalances?(schoolYearId: string): Promise<Map<string, number | null>>;
      getEnrollmentPaymentPreview(studentId: string, schoolYearId: string): Promise<{
        remainingDue: number; currency: string; totalDue: number; confirmedPaid: number;
      }>;
    }
  ) {}

  async listEnrollments(filters: { schoolYearId?: string; levelId?: string; classId?: string; status?: EnrollmentStatus; type?: EnrollmentType; search?: string; page: number; limit: number }) {
    const result = await this.repository.listEnrollments(filters);
    return {
      enrollments: result.rows.map(mapEnrollment),
      pagination: {
        page: filters.page,
        limit: filters.limit,
        total: result.total,
        totalPages: Math.max(1, Math.ceil(result.total / filters.limit)),
      },
    };
  }

  async listReEnrollmentCandidates(input: { schoolYearId?: string; campaignStatus: 'decision_pending' | 'ready' | 'to_process' | 'awaiting_cashier' | 'awaiting_documents' | 'blocked_unpaid' | 'confirmed' | 're_enrolled' | 'excluded' | 'financial_unavailable' | 'all'; sourceSchoolYearId?: string; sourceSchoolYearLabel?: string; levelId?: string; classId?: string; search?: string; page: number; limit: number }) {
    if (!input.sourceSchoolYearLabel && !this.finance?.listReEnrollmentBalances) {
      throw new EnrollmentsModuleError('Financial module is unavailable', 503, 'FINANCE_MODULE_UNAVAILABLE');
    }
    const rows = await this.repository.listReEnrollmentCandidates(input);
    const sourceYearId = input.sourceSchoolYearId ?? rows[0]?.current_school_year_id;
    const targetSchoolYear = input.sourceSchoolYearLabel
      ? input.schoolYearId ? await this.repository.getSchoolYear(input.schoolYearId) : null
      : sourceYearId ? await this.repository.getFollowingSchoolYear(sourceYearId) : null;
    const balancesByYear = new Map<string, Map<string, number | null>>();
    for (const row of rows) {
      if (!row.is_historical_source && row.current_school_year_id && !balancesByYear.has(row.current_school_year_id)) {
        if (!this.finance?.listReEnrollmentBalances) {
          throw new EnrollmentsModuleError('Financial module is unavailable', 503, 'FINANCE_MODULE_UNAVAILABLE');
        }
        balancesByYear.set(row.current_school_year_id, await this.finance.listReEnrollmentBalances(row.current_school_year_id));
      }
    }
    const candidates = rows.map((row) => {
      const remainingDue = row.current_school_year_id
        ? balancesByYear.get(row.current_school_year_id)?.get(row.student_id)
        : 0;
      const status = row.enrollment_status === 'confirmed' ? 're_enrolled'
        : row.enrollment_status === 'blocked_unpaid' ? 'blocked_unpaid'
        : row.enrollment_status === 'pending_dossier' ? 'awaiting_documents'
        : row.enrollment_status === 'pending_cashier' ? 'awaiting_cashier'
        : row.final_decision === 'expelled' ? 'excluded'
        : row.is_historical_source ? 'ready'
        : !row.final_decision || !row.next_level_id ? 'decision_pending'
        : remainingDue === undefined || remainingDue === null ? 'financial_unavailable'
        : remainingDue > 0 ? 'blocked_unpaid' : 'ready';
      return { ...mapReEnrollmentCandidate(row), status };
    });
    const counts = {
      decisionPending: candidates.filter((candidate) => candidate.status === 'decision_pending').length,
      ready: candidates.filter((candidate) => candidate.status === 'ready').length,
      awaitingCashier: candidates.filter((candidate) => candidate.status === 'awaiting_cashier').length,
      awaitingDocuments: candidates.filter((candidate) => candidate.status === 'awaiting_documents').length,
      blockedUnpaid: candidates.filter((candidate) => candidate.status === 'blocked_unpaid').length,
      reEnrolled: candidates.filter((candidate) => candidate.status === 're_enrolled').length,
      excluded: candidates.filter((candidate) => candidate.status === 'excluded').length,
      financialUnavailable: candidates.filter((candidate) => candidate.status === 'financial_unavailable').length,
      toProcess: candidates.filter((candidate) => !candidate.enrollment).length,
      confirmed: candidates.filter((candidate) => candidate.status === 're_enrolled').length,
      all: candidates.length,
    };
    const matching = candidates.filter((candidate) => input.campaignStatus === 'all'
      || (input.campaignStatus === 'to_process' && !candidate.enrollment)
      || (input.campaignStatus === 'confirmed' && candidate.status === 're_enrolled')
      || candidate.status === input.campaignStatus);
    const offset = (input.page - 1) * input.limit;
    return {
      candidates: matching.slice(offset, offset + input.limit),
      targetSchoolYear,
      counts,
      pagination: {
        page: input.page,
        limit: input.limit,
        total: matching.length,
        totalPages: Math.max(1, Math.ceil(matching.length / input.limit)),
      },
    };
  }

  listHistoricalSourceYears() {
    return this.repository.listHistoricalSourceYears();
  }

  async getStudentAcademicSummary(studentId: string, includeFinance = true) {
    const profile = await this.repository.getStudentSummaryProfile(studentId);
    if (!profile) throw new EnrollmentsModuleError('Student not found', 404, 'STUDENT_NOT_FOUND');
    const history = await this.repository.listStudentAcademicSummary(studentId);
    const years = await Promise.all(history.map(async (row) => {
      if (!includeFinance || !this.finance) {
        return {
          schoolYearId: row.school_year_id,
          schoolYearLabel: row.school_year_label,
          schoolYearStatus: row.school_year_status,
          startDate: row.school_year_start_date,
          endDate: row.school_year_end_date,
          className: row.class_name,
          enrollmentStatus: row.enrollment_status,
          decision: mapDecisionLabel(row.final_decision),
          financialStatus: 'unavailable' as const,
          remainingDue: null,
          totalDue: null,
          confirmedPaid: null,
          currency: 'FCFA',
        };
      }
      try {
        const financial = row.enrollment_status === 'confirmed' && row.school_year_status === 'closed' && this.finance.getHistoricalFinancialStatus
          ? await this.finance.getHistoricalFinancialStatus(studentId, row.school_year_id)
          : await this.finance.getFinancialStatus(studentId, row.school_year_id);
        return {
          schoolYearId: row.school_year_id,
          schoolYearLabel: row.school_year_label,
          schoolYearStatus: row.school_year_status,
          startDate: row.school_year_start_date,
          endDate: row.school_year_end_date,
          className: row.class_name,
          enrollmentStatus: row.enrollment_status,
          decision: mapDecisionLabel(row.final_decision),
          financialStatus: financial.remainingDue > 0 ? 'remaining_due' as const : 'settled' as const,
          remainingDue: financial.remainingDue,
          totalDue: financial.totalDue ?? null,
          confirmedPaid: financial.confirmedPaid ?? null,
          currency: financial.currency ?? 'FCFA',
        };
      } catch (error) {
        if ((error as { code?: string }).code === 'CONFIRMED_ENROLLMENT_REQUIRED') {
          return {
            schoolYearId: row.school_year_id,
            schoolYearLabel: row.school_year_label,
            schoolYearStatus: row.school_year_status,
            startDate: row.school_year_start_date,
            endDate: row.school_year_end_date,
            className: row.class_name,
            enrollmentStatus: row.enrollment_status,
            decision: mapDecisionLabel(row.final_decision),
            financialStatus: 'unavailable' as const,
            remainingDue: null,
            totalDue: null,
            confirmedPaid: null,
            currency: 'FCFA',
          };
        }
        if ((error as { code?: string }).code === 'TUITION_PLAN_REQUIRED') {
          return {
            schoolYearId: row.school_year_id,
            schoolYearLabel: row.school_year_label,
            schoolYearStatus: row.school_year_status,
            startDate: row.school_year_start_date,
            endDate: row.school_year_end_date,
            className: row.class_name,
            enrollmentStatus: row.enrollment_status,
            decision: mapDecisionLabel(row.final_decision),
            financialStatus: 'not_configured' as const,
            remainingDue: null,
            totalDue: null,
            confirmedPaid: null,
            currency: 'FCFA',
          };
        }
        throw error;
      }
    }));
    return {
      student: { id: profile.id, firstName: profile.first_name, lastName: profile.last_name, matricule: profile.matricule },
      years,
    };
  }

  async getStudentYearResults(studentId: string, schoolYearId: string) {
    const profile = await this.repository.getStudentSummaryProfile(studentId);
    if (!profile) throw new EnrollmentsModuleError('Student not found', 404, 'STUDENT_NOT_FOUND');
    const history = await this.repository.listStudentAcademicSummary(studentId);
    if (!history.some((row) => row.school_year_id === schoolYearId)) {
      throw new EnrollmentsModuleError('School year is not part of this student history', 404, 'STUDENT_YEAR_NOT_FOUND');
    }
    const result = await this.repository.listStudentYearResults(studentId, schoolYearId);
    return {
      studentId, schoolYearId,
      periods: result.periods.map((row) => ({
        id: row.id, label: row.label, startDate: row.start_date, endDate: row.end_date,
        isCurrent: row.is_current, isFuture: row.is_future,
      })),
      evaluations: result.evaluations.map((row) => ({
        id: row.id, gradingPeriodId: row.grading_period_id, periodLabel: row.period_label,
        subjectName: row.subject_name, label: row.label, evaluationDate: row.evaluation_date,
        teacherName: row.teacher_name, score: row.score, maxScore: row.max_score, coefficient: row.coefficient,
      })),
      averages: result.averages.map((row) => ({
        id: row.id, gradingPeriodId: row.grading_period_id, periodLabel: row.period_label,
        subjectName: row.subject_name, average: row.average, rank: row.rank,
      })),
      conduct: result.conduct.map((row) => ({
        id: row.id, gradingPeriodId: row.grading_period_id, periodLabel: row.period_label,
        note: row.note, coefficient: row.coefficient,
      })),
    };
  }

  async getEnrollment(id: string) {
    const enrollment = await this.repository.findEnrollment(id);
    if (!enrollment) throw new EnrollmentsModuleError('Enrollment not found', 404, 'ENROLLMENT_NOT_FOUND');
    return mapEnrollment(enrollment);
  }

  async getPaymentSummary(id: string) {
    const enrollment = await this.repository.findEnrollment(id);
    if (!enrollment) throw new EnrollmentsModuleError('Enrollment not found', 404, 'ENROLLMENT_NOT_FOUND');
    if (!this.finance) {
      throw new EnrollmentsModuleError('Financial module is unavailable', 503, 'FINANCE_MODULE_UNAVAILABLE');
    }
    const status = enrollment.status === 'confirmed'
      ? await this.finance.getFinancialStatus(enrollment.student_id, enrollment.school_year_id)
      : await this.finance.getEnrollmentPaymentPreview(enrollment.student_id, enrollment.school_year_id);
    return {
      enrollment: mapEnrollment(enrollment),
      amountDue: status.remainingDue,
      currency: status.currency ?? 'FCFA',
      totalDue: status.totalDue ?? status.remainingDue,
      confirmedPaid: status.confirmedPaid ?? 0,
    };
  }

  async createEnrollment(input: {
    studentId: string; classId: string; schoolYearId: string; type: EnrollmentType;
    hasPreviousYearUnpaid: boolean;
    levelId?: string; expectedActiveSchoolYearId?: string; sourceSchoolYearLabel?: string;
  }) {
    const [student, targetClass] = await Promise.all([
      this.repository.getStudentContext(input.studentId),
      this.repository.getClassContext(input.classId),
    ]);
    if (!student || !student.is_active || student.lifecycle_status !== 'active') {
      throw new EnrollmentsModuleError('Active student not found', 404, 'ACTIVE_STUDENT_NOT_FOUND');
    }
    if (!targetClass || !targetClass.is_active || !targetClass.level_id || targetClass.school_year_id !== input.schoolYearId) {
      throw new EnrollmentsModuleError('Class does not belong to the selected school year', 400, 'CLASS_YEAR_MISMATCH');
    }
    if (targetClass.school_year_status !== 'active') {
      throw new EnrollmentsModuleError('L’année scolaire doit être ouverte par le support avant toute inscription.', 409, 'SCHOOL_YEAR_NOT_OPEN');
    }
    this.assertClassSelection(targetClass, input);

    let isHistoricalReEnrollment = false;
    if (input.type === 're_registration') {
      if (!student.current_school_year_id) {
        isHistoricalReEnrollment = Boolean(input.sourceSchoolYearLabel)
          && await this.repository.hasHistoricalSourceBeforeTarget(
            input.studentId,
            input.sourceSchoolYearLabel!,
            input.schoolYearId
          );
        if (!isHistoricalReEnrollment) {
          throw new EnrollmentsModuleError('No matching historical enrollment source was found', 409, 'HISTORICAL_SOURCE_REQUIRED');
        }
      } else {
        const yearContext = await this.repository.getReEnrollmentYearContext(input.studentId, input.schoolYearId);
        if (!yearContext || yearContext.target_school_year_id !== input.schoolYearId) {
          throw new EnrollmentsModuleError('Target school year not found', 404, 'TARGET_SCHOOL_YEAR_NOT_FOUND');
        }
        if (yearContext.source_school_year_id === input.schoolYearId) {
          throw new EnrollmentsModuleError('Re-enrollment cannot target the current school year', 409, 'RE_ENROLLMENT_CURRENT_YEAR_FORBIDDEN');
        }
        if (yearContext.source_school_year_status !== 'closed' || yearContext.target_school_year_status !== 'active' || !yearContext.target_school_year_start_date || yearContext.target_school_year_start_date <= yearContext.source_school_year_end_date) {
          throw new EnrollmentsModuleError(
            'Re-enrollment requires a closed school year and a new active school year opened by the super administrator',
            409,
            'RE_ENROLLMENT_YEAR_TRANSITION_REQUIRED'
          );
        }
        const followingYear = await this.repository.getFollowingSchoolYear(yearContext.source_school_year_id);
        if (followingYear?.id !== input.schoolYearId) {
          throw new EnrollmentsModuleError('Re-enrollment must target the next school year', 409, 'RE_ENROLLMENT_NEXT_YEAR_REQUIRED');
        }
        if (!student.final_decision) {
          throw new EnrollmentsModuleError('A validated class decision is required', 409, 'CLASS_DECISION_REQUIRED');
        }
        if (student.final_decision === 'expelled') {
          throw new EnrollmentsModuleError('An expelled student cannot be re-enrolled', 409, 'STUDENT_EXPELLED');
        }
        const expectedLevelId = student.final_decision === 'repeat'
          ? (student.next_level_id ?? student.current_level_id)
          : student.next_level_id;
        if (!expectedLevelId || targetClass.level_id !== expectedLevelId) {
          throw new EnrollmentsModuleError('Target class does not match the validated decision', 400, 'DECISION_CLASS_MISMATCH');
        }
      }
    }

    let hasPreviousYearUnpaid = false;
    if (input.type === 're_registration' && !isHistoricalReEnrollment) {
      if (!student.current_school_year_id || !this.finance) {
        throw new EnrollmentsModuleError(
          'Previous-year financial status is unavailable',
          409,
          'PREVIOUS_FINANCIAL_STATUS_UNAVAILABLE'
        );
      }
      const financialStatus = this.finance.getHistoricalFinancialStatus
        ? await this.finance.getHistoricalFinancialStatus(input.studentId, student.current_school_year_id)
        : await this.finance.getFinancialStatus(input.studentId, student.current_school_year_id);
      hasPreviousYearUnpaid = financialStatus.remainingDue > 0;
    }
    const status = resolveInitialEnrollmentStatus(input.type, hasPreviousYearUnpaid);
    try {
      const created = await this.repository.createEnrollment({ ...input, status });
      if (!created) throw new EnrollmentsModuleError('La classe, le niveau ou l’année a changé. Vérifiez la sélection avant de continuer.', 409, 'CLASS_SELECTION_CHANGED');
      await this.repository.ensureRequiredDocuments(input.studentId, targetClass.level_id);
      const enrollmentWithDocumentStatus = await this.repository.findEnrollment(created.id);
      if (!enrollmentWithDocumentStatus) throw new Error('Failed to reload enrollment');
      const documents = deduplicateRequiredDocuments(await this.repository.listStudentDocuments(input.studentId));
      const missingMandatoryDocuments = documents.filter((document) => document.is_active && document.is_mandatory && document.status !== 'provided').map(mapDocument);
      return {
        enrollment: mapEnrollment(enrollmentWithDocumentStatus),
        missingMandatoryDocuments,
        documentWarning: missingMandatoryDocuments.length > 0
          ? 'Des pièces obligatoires sont manquantes. Le paiement reste autorisé.'
          : null,
      };
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new EnrollmentsModuleError('Student is already enrolled for this school year', 409, 'ENROLLMENT_ALREADY_EXISTS');
      }
      throw error;
    }
  }

  private assertClassSelection(targetClass: { level_id: string | null; school_year_id: string | null; school_year_status: string | null }, input: { levelId?: string; expectedActiveSchoolYearId?: string }) {
    if (input.levelId && targetClass.level_id !== input.levelId) {
      throw new EnrollmentsModuleError('La classe ne correspond pas au niveau sélectionné.', 400, 'CLASS_LEVEL_MISMATCH');
    }
    if (input.expectedActiveSchoolYearId && (targetClass.school_year_id !== input.expectedActiveSchoolYearId || targetClass.school_year_status !== 'active')) {
      throw new EnrollmentsModuleError('L’année scolaire active a changé. Vérifiez le dossier avant de continuer.', 409, 'ACTIVE_SCHOOL_YEAR_CHANGED');
    }
  }

  async updateEnrollment(id: string, input: { classId?: string; status?: 'pending_cashier' | 'pending_dossier'; levelId?: string; expectedActiveSchoolYearId?: string }) {
    const current = await this.repository.findEnrollment(id);
    if (!current) throw new EnrollmentsModuleError('Enrollment not found', 404, 'ENROLLMENT_NOT_FOUND');
    const enrollmentClass = await this.repository.getClassContext(current.class_id);
    if (enrollmentClass?.school_year_status !== 'active') {
      throw new EnrollmentsModuleError('L’année scolaire doit être ouverte par le support avant toute modification d’inscription.', 409, 'SCHOOL_YEAR_NOT_OPEN');
    }
    if (current.status === 'confirmed') {
      throw new EnrollmentsModuleError('A confirmed enrollment cannot be edited', 409, 'CONFIRMED_ENROLLMENT_IMMUTABLE');
    }
    if (input.status && !canTransitionEnrollment(current.status, input.status)) {
      throw new EnrollmentsModuleError('Invalid enrollment status transition', 409, 'INVALID_ENROLLMENT_TRANSITION');
    }
    let targetLevelId: string | null = null;
    if (input.classId) {
      const targetClass = await this.repository.getClassContext(input.classId);
      if (!targetClass || !targetClass.is_active || !targetClass.level_id || targetClass.school_year_id !== current.school_year_id) {
        throw new EnrollmentsModuleError('Class does not belong to the enrollment school year', 400, 'CLASS_YEAR_MISMATCH');
      }
      if (targetClass.school_year_status !== 'active') {
        throw new EnrollmentsModuleError('L’année scolaire doit être ouverte par le support avant toute modification d’inscription.', 409, 'SCHOOL_YEAR_NOT_OPEN');
      }
      this.assertClassSelection(targetClass, input);
      targetLevelId = targetClass.level_id;
    }
    const saved = await this.repository.updateEnrollment(id, input);
    if (!saved) throw new EnrollmentsModuleError('La classe, le niveau ou l’année a changé. Vérifiez la sélection avant de continuer.', 409, 'CLASS_SELECTION_CHANGED');
    if (targetLevelId) await this.repository.ensureRequiredDocuments(current.student_id, targetLevelId);
    const updated = await this.repository.findEnrollment(id);
    if (!updated) throw new EnrollmentsModuleError('Enrollment not found', 404, 'ENROLLMENT_NOT_FOUND');
    return mapEnrollment(updated);
  }

  async confirmPayment(id: string, userId: string, input: {
    amount: number;
    method: PaymentMethod;
    providerReference?: string;
    schoolReceiptReference: string;
  }) {
    const current = await this.repository.findEnrollment(id);
    if (!current) throw new EnrollmentsModuleError('Enrollment not found', 404, 'ENROLLMENT_NOT_FOUND');
    const schoolClass = await this.repository.getClassContext(current.class_id);
    if (schoolClass?.school_year_status !== 'active') {
      throw new EnrollmentsModuleError('L’année scolaire doit être ouverte par le support avant toute confirmation d’inscription.', 409, 'SCHOOL_YEAR_NOT_OPEN');
    }
    if (!canTransitionEnrollment(current.status, 'confirmed')) {
      throw new EnrollmentsModuleError('Payment cannot be confirmed for this enrollment', 409, 'PAYMENT_CONFIRMATION_BLOCKED');
    }
    if (!this.finance) {
      throw new EnrollmentsModuleError('Financial module is unavailable', 503, 'FINANCE_MODULE_UNAVAILABLE');
    }
    const { payment } = await this.finance.recordEnrollmentPayment({
      enrollmentId: id,
      actorUserId: userId,
      ...input,
    });
    const enrollment = await this.repository.findEnrollment(id);
    if (!enrollment) throw new EnrollmentsModuleError('Enrollment not found', 404, 'ENROLLMENT_NOT_FOUND');
    const documents = await this.repository.listStudentDocuments(current.student_id);
    const missingMandatoryDocuments = documents.filter((document) => document.is_active && document.is_mandatory && document.status !== 'provided').map(mapDocument);
    return {
      enrollment: mapEnrollment(enrollment!),
      payment,
      missingMandatoryDocuments,
      documentWarning: missingMandatoryDocuments.length > 0
        ? 'Paiement confirmé. Des pièces obligatoires restent à fournir.'
        : null,
    };
  }

  async deleteEnrollment(id: string) {
    const current = await this.repository.findEnrollment(id);
    if (!current) throw new EnrollmentsModuleError('Enrollment not found', 404, 'ENROLLMENT_NOT_FOUND');
    const schoolClass = await this.repository.getClassContext(current.class_id);
    if (schoolClass?.school_year_status !== 'active') {
      throw new EnrollmentsModuleError('L’année scolaire doit être ouverte par le support avant toute modification d’inscription.', 409, 'SCHOOL_YEAR_NOT_OPEN');
    }
    if (current.status === 'confirmed') {
      throw new EnrollmentsModuleError('A confirmed enrollment cannot be deleted', 409, 'CONFIRMED_ENROLLMENT_IMMUTABLE');
    }
    await this.repository.deleteEnrollment(id);
    return { deleted: true };
  }

  listRequiredDocumentTypes(levelId?: string) { return this.repository.listRequiredDocumentTypes(levelId); }
  listRequiredDocumentLevels() { return this.repository.listRequiredDocumentLevels(); }
  async createRequiredDocumentTypes(input: { levelIds: string[]; name: string; isMandatory: boolean }) {
    if (!(await this.repository.levelsExist(input.levelIds))) {
      throw new EnrollmentsModuleError('One or more levels were not found', 404, 'LEVEL_NOT_FOUND');
    }
    return this.repository.createRequiredDocumentTypes(input.levelIds.map((levelId) => ({
      levelId,
      name: input.name,
      isMandatory: input.isMandatory,
    })));
  }
  async syncRequiredDocumentTypes(input: {
    documentTypeIds: string[]; levelIds: string[]; name: string; isMandatory: boolean;
  }) {
    if (!(await this.repository.levelsExist(input.levelIds))) {
      throw new EnrollmentsModuleError('One or more levels were not found', 404, 'LEVEL_NOT_FOUND');
    }
    if (!(await this.repository.requiredDocumentTypesExist(input.documentTypeIds))) {
      throw new EnrollmentsModuleError('One or more document rules were not found', 404, 'DOCUMENT_TYPE_NOT_FOUND');
    }
    return this.repository.syncRequiredDocumentTypes(input);
  }
  async createRequiredDocumentType(input: { levelId: string; name: string; isMandatory: boolean }) {
    if (!(await this.repository.levelExists(input.levelId))) throw new EnrollmentsModuleError('Level not found', 404, 'LEVEL_NOT_FOUND');
    try {
      const documentType = await this.repository.createRequiredDocumentType(input);
      if (!documentType) throw new Error('Failed to create required document type');
      await this.repository.syncRequiredDocumentToOpenEnrollments(documentType.id, input.levelId);
      return documentType;
    }
    catch (error) {
      if ((error as { code?: string }).code === '23505') throw new EnrollmentsModuleError('Document type already exists for this level', 409, 'DOCUMENT_TYPE_ALREADY_EXISTS');
      throw error;
    }
  }
  async updateRequiredDocumentType(id: string, input: { name?: string; isMandatory?: boolean; isActive?: boolean }) {
    const result = await this.repository.updateRequiredDocumentType(id, input);
    if (!result) throw new EnrollmentsModuleError('Document type not found', 404, 'DOCUMENT_TYPE_NOT_FOUND');
    if (result.is_active) await this.repository.syncRequiredDocumentToOpenEnrollments(result.id, result.level_id);
    return result;
  }
  async deleteRequiredDocumentType(id: string) {
    if (!(await this.repository.deleteRequiredDocumentType(id))) throw new EnrollmentsModuleError('Document type not found', 404, 'DOCUMENT_TYPE_NOT_FOUND');
    return { archived: true };
  }
  async listStudentDocuments(studentId: string) {
    await this.repository.syncActiveRequiredDocumentsForStudent(studentId);
    return (await this.repository.listStudentDocuments(studentId)).map(mapDocument);
  }
  async verifyStudentDocuments(studentId: string) {
    await this.repository.syncActiveRequiredDocumentsForStudent(studentId);
    const [student, documents] = await Promise.all([
      this.repository.getStudentNotificationContext(studentId),
      this.repository.listStudentDocuments(studentId),
    ]);
    if (!student) throw new EnrollmentsModuleError('Student not found', 404, 'STUDENT_NOT_FOUND');

    const mappedDocuments = deduplicateRequiredDocuments(documents).map(mapDocument);
    const missingMandatoryDocuments = mappedDocuments.filter(
      (document) => document.isActive && document.isMandatory && document.status !== 'provided'
    );
    const parentPhones = [...new Set([student.parent_phone, student.parent_phone_2].filter(
      (phone): phone is string => Boolean(phone)
    ))];

    return {
      documents: mappedDocuments,
      missingMandatoryDocuments,
      dossierComplete: missingMandatoryDocuments.length === 0,
      notification: missingMandatoryDocuments.length > 0 && parentPhones.length > 0
        ? {
            studentFirstName: student.first_name,
            parentPhones,
            missingDocumentNames: missingMandatoryDocuments.map((document) => document.documentTypeName),
          }
        : null,
    };
  }
  async getStudentDocument(id: string) {
    const document = await this.repository.findStudentDocument(id);
    if (!document) throw new EnrollmentsModuleError('Student document not found', 404, 'STUDENT_DOCUMENT_NOT_FOUND');
    return mapDocument(document);
  }
  async assertDocumentTypeAllowed(studentId: string, documentTypeId: string) {
    if (!(await this.repository.isDocumentTypeAllowedForStudent(studentId, documentTypeId))) {
      throw new EnrollmentsModuleError('Document type is not active for the student level', 400, 'DOCUMENT_TYPE_NOT_ALLOWED');
    }
  }
  async upsertStudentDocument(input: { studentId: string; documentTypeId: string; status: StudentDocumentStatus; r2Key?: string | null; fileUrl?: string | null; notes?: string | null }) {
    await this.assertDocumentTypeAllowed(input.studentId, input.documentTypeId);
    try { return mapDocument((await this.repository.upsertStudentDocument(input))!); }
    catch (error) {
      if ((error as { code?: string }).code === '23503') throw new EnrollmentsModuleError('Student or document type not found', 404, 'DOCUMENT_OWNER_NOT_FOUND');
      throw error;
    }
  }
  async updateStudentDocument(id: string, input: { status?: StudentDocumentStatus; r2Key?: string | null; fileUrl?: string | null; notes?: string | null }) {
    const current = await this.repository.findStudentDocument(id);
    if (!current) throw new EnrollmentsModuleError('Student document not found', 404, 'STUDENT_DOCUMENT_NOT_FOUND');
    const finalStatus = input.status ?? current.status;
    const finalR2Key = input.r2Key !== undefined ? input.r2Key : current.r2_key;
    const finalFileUrl = input.fileUrl !== undefined ? input.fileUrl : current.file_url;
    if (finalStatus === 'provided' && !finalR2Key && !finalFileUrl) {
      throw new EnrollmentsModuleError('A provided document requires a file reference', 400, 'DOCUMENT_FILE_REQUIRED');
    }
    return mapDocument((await this.repository.updateStudentDocument(id, input))!);
  }
  async deleteStudentDocument(id: string) {
    const deleted = await this.repository.deleteStudentDocument(id);
    if (!deleted) throw new EnrollmentsModuleError('Student document not found', 404, 'STUDENT_DOCUMENT_NOT_FOUND');
    return { deleted: true, r2Key: deleted.r2_key };
  }
}

export const buildEnrollmentsService = (db: ConstructorParameters<typeof EnrollmentsRepository>[0]) =>
  new EnrollmentsService(new EnrollmentsRepository(db), buildFinanceService(db));
