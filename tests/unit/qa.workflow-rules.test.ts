import { describe, expect, it, vi } from 'vitest';

import type { EnrollmentsRepository, StudentDocumentRow } from '../../src/modules/enrollments/enrollments.repository.js';
import { EnrollmentsService, canTransitionEnrollment } from '../../src/modules/enrollments/enrollments.service.js';
import { calculateStudentTotalDue, isValidCumulativeSchedule, resolveIndividualFinancialStatus } from '../../src/modules/finance/finance.calculations.js';
import { ConductService } from '../../src/modules/conduct/conduct.service.js';
import type { ConductRepository } from '../../src/modules/conduct/conduct.repository.js';

const document = (overrides: Partial<StudentDocumentRow> = {}): StudentDocumentRow => ({
  id: 'document', student_id: 'student', document_type_id: 'birth', document_type_name: 'Extrait',
  is_mandatory: true, is_active: true, status: 'missing', file_url: null, r2_key: null,
  provided_at: null, notes: null, ...overrides,
});

describe('F11 — règles de dossier documentaire', () => {
  it.each([
    { label: 'pièce archivée', value: document({ is_active: false }), complete: true },
    { label: 'pièce facultative', value: document({ is_mandatory: false }), complete: true },
    { label: 'pièce fournie', value: document({ status: 'provided', file_url: 'https://files.example.test/extrait.pdf' }), complete: true },
    { label: 'pièce obligatoire manquante', value: document(), complete: false },
  ])('$label : dossier complet = $complete, sans faux avertissement', async ({ value, complete }) => {
    const repository = {
      syncActiveRequiredDocumentsForStudent: vi.fn(),
      getStudentNotificationContext: vi.fn().mockResolvedValue({ first_name: 'Aya', parent_phone: null, parent_phone_2: null }),
      listStudentDocuments: vi.fn().mockResolvedValue([value]),
    };
    const result = await new EnrollmentsService(repository as unknown as EnrollmentsRepository).verifyStudentDocuments('student');
    expect(result.dossierComplete).toBe(complete);
    expect(result.missingMandatoryDocuments).toHaveLength(complete ? 0 : 1);
    expect(result.notification).toBeNull();
    expect(repository.syncActiveRequiredDocumentsForStudent).toHaveBeenCalledWith('student');
  });

  it('retient la dernière version fournie sans notifier une ancienne pièce manquante', async () => {
    const repository = {
      syncActiveRequiredDocumentsForStudent: vi.fn(),
      getStudentNotificationContext: vi.fn().mockResolvedValue({ first_name: 'Aya', parent_phone: '2250700000001' }),
      listStudentDocuments: vi.fn().mockResolvedValue([document(), document({ id: 'provided', status: 'provided' })]),
    };
    const result = await new EnrollmentsService(repository as unknown as EnrollmentsRepository).verifyStudentDocuments('student');
    expect(result.documents).toHaveLength(1);
    expect(result.dossierComplete).toBe(true);
    expect(result.notification).toBeNull();
  });

  it('refuse une pièce fournie sans référence de fichier et ne persiste rien', async () => {
    const repository = { findStudentDocument: vi.fn().mockResolvedValue(document()), updateStudentDocument: vi.fn() };
    await expect(new EnrollmentsService(repository as unknown as EnrollmentsRepository)
      .updateStudentDocument('document', { status: 'provided' }))
      .rejects.toMatchObject({ code: 'DOCUMENT_FILE_REQUIRED', statusCode: 400 });
    expect(repository.updateStudentDocument).not.toHaveBeenCalled();
  });

  it('conserve la référence existante lors du passage à fourni', async () => {
    const current = document({ r2_key: 'school/documents/extrait.pdf' });
    const repository = {
      findStudentDocument: vi.fn().mockResolvedValue(current),
      updateStudentDocument: vi.fn().mockResolvedValue({ ...current, status: 'provided' }),
    };
    const result = await new EnrollmentsService(repository as unknown as EnrollmentsRepository)
      .updateStudentDocument('document', { status: 'provided' });
    expect(result).toMatchObject({ status: 'provided', r2Key: current.r2_key });
  });
});

describe('F10/F12 — transitions protégées', () => {
  it.each(['pending_dossier', 'pending_cashier', 'blocked_unpaid'] as const)(
    'une inscription confirmée ne revient pas à %s', (status) => expect(canTransitionEnrollment('confirmed', status)).toBe(false),
  );
  it.each(['pending_dossier', 'pending_cashier', 'confirmed'] as const)(
    'une dette ne se contourne pas en passant manuellement à %s', (status) => expect(canTransitionEnrollment('blocked_unpaid', status)).toBe(false),
  );
});

describe('F15/F20 — frontières des calculs financiers', () => {
  it.each([
    { paid: 39_999, remaining: 60_001, standing: 'late', cache: 'late' },
    { paid: 40_000, remaining: 60_000, standing: 'late', cache: 'late' },
    { paid: 50_000, remaining: 50_000, standing: 'up_to_date', cache: 'up_to_date' },
    { paid: 120_000, remaining: 0, standing: 'up_to_date', cache: 'up_to_date' },
  ])('encaissé $paid : reste $remaining, statut $standing', ({ paid, remaining, standing, cache }) => {
    expect(resolveIndividualFinancialStatus({ totalDue: 100_000, cumulativeExpectedAtDate: 50_000, confirmedPaid: paid }))
      .toEqual({ coveredAmount: paid, remainingDue: remaining, standing, cacheStatus: cache });
  });
  it('un montant personnalisé nul ne retombe pas sur les frais du niveau ni les alertes parents', () => {
    expect(calculateStudentTotalDue({ planTotalAmount: 100_000, overrideTotalAmount: 0 })).toBe(0);
    expect(calculateStudentTotalDue({ planTotalAmount: 100_000, discountAmount: 150_000 })).toBe(0);
  });
  it('refuse les dates identiques et les cumuls décroissants, accepte un palier', () => {
    const first = { dueDate: '2026-10-01', cumulativeAmountExpected: 30_000 };
    expect(isValidCumulativeSchedule([first, { ...first, cumulativeAmountExpected: 40_000 }], 100_000)).toBe(false);
    expect(isValidCumulativeSchedule([first, { dueDate: '2026-11-01', cumulativeAmountExpected: 20_000 }], 100_000)).toBe(false);
    expect(isValidCumulativeSchedule([first, { dueDate: '2026-11-01', cumulativeAmountExpected: 100_000 }], 100_000)).toBe(true);
    expect(isValidCumulativeSchedule([], 100_000)).toBe(false);
  });
});

describe('F28 — conduite verrouillée', () => {
  it.each([
    { completed: true, current: true, code: 'GRADING_PERIOD_COMPLETED' },
    { completed: false, current: false, code: 'CONDUCT_REVIEW_NOT_OPEN' },
  ])('refuse la décision finale : $code même pour le professeur principal', async ({ completed, current, code }) => {
    const repository = {
      findStudentContext: vi.fn().mockResolvedValue({ studentId: 'student', classId: 'class' }),
      gradingPeriodExists: vi.fn().mockResolvedValue(true),
      isGradingPeriodCompleted: vi.fn().mockResolvedValue(completed),
      getConductReviewState: vi.fn().mockResolvedValue(current ? 'open' : 'before'),
      isHomeroomTeacherForStudent: vi.fn().mockResolvedValue(true),
      upsertConductGrade: vi.fn(),
    };
    await expect(new ConductService(repository as unknown as ConductRepository)
      .decideConductGrade({ student_id: 'student', grading_period_id: 'period', note: 18 }, { userId: 'teacher', canFinalize: true }))
      .rejects.toMatchObject({ code, statusCode: 409 });
    expect(repository.upsertConductGrade).not.toHaveBeenCalled();
  });
});
