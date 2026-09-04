import { EnrollmentsRepository, type EnrollmentRow, type StudentDocumentRow } from './enrollments.repository.js';
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
      }>;
    }
  ) {}

  async listEnrollments(filters: { schoolYearId?: string; status?: EnrollmentStatus; type?: EnrollmentType; page: number; limit: number }) {
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
    const status = await this.finance.getFinancialStatus(enrollment.student_id, enrollment.school_year_id);
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

    if (input.type === 're_registration') {
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

    let hasPreviousYearUnpaid = false;
    if (input.type === 're_registration') {
      if (!student.current_school_year_id || !this.finance) {
        throw new EnrollmentsModuleError(
          'Previous-year financial status is unavailable',
          409,
          'PREVIOUS_FINANCIAL_STATUS_UNAVAILABLE'
        );
      }
      const financialStatus = await this.finance.getFinancialStatus(
        input.studentId,
        student.current_school_year_id
      );
      hasPreviousYearUnpaid = financialStatus.remainingDue > 0;
    }
    const status = resolveInitialEnrollmentStatus(input.type, hasPreviousYearUnpaid);
    try {
      const created = await this.repository.createEnrollment({ ...input, status });
      if (!created) throw new Error('Failed to create enrollment');
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

  async updateEnrollment(id: string, input: { classId?: string; status?: 'pending_cashier' | 'pending_dossier' }) {
    const current = await this.repository.findEnrollment(id);
    if (!current) throw new EnrollmentsModuleError('Enrollment not found', 404, 'ENROLLMENT_NOT_FOUND');
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
      targetLevelId = targetClass.level_id;
    }
    await this.repository.updateEnrollment(id, input);
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
