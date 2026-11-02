import { describe, expect, it, vi } from 'vitest';

import type { ReEnrollmentCandidateRow, StudentDocumentRow } from '../../src/modules/enrollments/enrollments.repository.js';
import { FinanceService } from '../../src/modules/finance/finance.service.js';
import {
  canTransitionEnrollment,
  deduplicateRequiredDocuments,
  EnrollmentsService,
  EnrollmentsModuleError,
  resolveInitialEnrollmentStatus,
} from '../../src/modules/enrollments/enrollments.service.js';
import { enrollmentListQuerySchema } from '../../src/modules/enrollments/enrollments.types.js';

describe('enrollment workflow rules', () => {
  it('valide puis transmet la recherche des inscriptions avec les filtres annuels', async () => {
    const repository = { listEnrollments: vi.fn().mockResolvedValue({ rows: [], total: 0 }) };
    const filters = enrollmentListQuerySchema.parse({ school_year_id: '11f746a0-1222-4444-8888-8a0aba160c29', search: '  Koné Aya  ' });
    await new EnrollmentsService(repository as never).listEnrollments({
      schoolYearId: filters.school_year_id,
      search: filters.search,
      page: filters.page,
      limit: filters.limit,
    });
    expect(repository.listEnrollments).toHaveBeenCalledWith(expect.objectContaining({ search: 'Koné Aya' }));
    expect(() => enrollmentListQuerySchema.parse({ search: ' '.repeat(101) })).toThrow();
  });
  it('masque les montants de chaque année sans permission finance', async () => {
    const repository = {
      getStudentSummaryProfile: vi.fn().mockResolvedValue({ id: 'student', first_name: 'Awa', last_name: 'Koné', matricule: 'MAT-1' }),
      listStudentAcademicSummary: vi.fn().mockResolvedValue([{ school_year_id: 'year-1', school_year_label: '2025-2026', school_year_start_date: '2025-09-01', school_year_end_date: '2026-06-30', school_year_status: 'closed', class_name: '6e A', final_decision: 'promoted', enrollment_status: 'confirmed' }]),
    };
    const finance = { getFinancialStatus: vi.fn(), getHistoricalFinancialStatus: vi.fn() };
    const summary = await new EnrollmentsService(repository as never, finance as never).getStudentAcademicSummary('student', false);
    expect(summary.years).toEqual([expect.objectContaining({ schoolYearId: 'year-1', financialStatus: 'unavailable', remainingDue: null, totalDue: null, confirmedPaid: null })]);
    expect(finance.getFinancialStatus).not.toHaveBeenCalled();
    expect(finance.getHistoricalFinancialStatus).not.toHaveBeenCalled();
  });

  it('borne les résultats à une année présente dans le dossier', async () => {
    const repository = {
      getStudentSummaryProfile: vi.fn().mockResolvedValue({ id: 'student' }),
      listStudentAcademicSummary: vi.fn().mockResolvedValue([{ school_year_id: 'year-1' }]),
      listStudentYearResults: vi.fn().mockResolvedValue({
        periods: [{
          id: 'period-1', label: 'Trimestre 1', start_date: '2026-09-01', end_date: '2026-10-31',
          is_current: true, is_future: false,
        }],
        evaluations: [{
          id: 'grade-1', grading_period_id: 'period-1', period_label: 'Trimestre 1',
          subject_name: 'Mathématiques', label: 'Devoir', evaluation_date: '2026-10-05',
          teacher_name: 'Kouamé Aya', score: 15, max_score: 20, coefficient: 2,
        }],
        averages: [{ id: 'average-1', grading_period_id: 'period-1', period_label: 'Trimestre 1', subject_name: null, average: 14, rank: 3 }],
        conduct: [{ id: 'conduct-1', grading_period_id: 'period-1', period_label: 'Trimestre 1', note: 16, coefficient: 1 }],
      }),
    };
    const service = new EnrollmentsService(repository as never);
    await expect(service.getStudentYearResults('student', 'year-2')).rejects.toMatchObject({ code: 'STUDENT_YEAR_NOT_FOUND', statusCode: 404 });
    expect(repository.listStudentYearResults).not.toHaveBeenCalled();
    await expect(service.getStudentYearResults('student', 'year-1')).resolves.toMatchObject({
      schoolYearId: 'year-1',
      periods: [{ id: 'period-1', startDate: '2026-09-01', endDate: '2026-10-31', isCurrent: true, isFuture: false }],
      evaluations: [{
        periodLabel: 'Trimestre 1', gradingPeriodId: 'period-1', evaluationDate: '2026-10-05',
        teacherName: 'Kouamé Aya', score: 15,
      }],
      averages: [{ periodLabel: 'Trimestre 1', gradingPeriodId: 'period-1', average: 14 }],
      conduct: [{ periodLabel: 'Trimestre 1', gradingPeriodId: 'period-1', note: 16 }],
    });
    expect(repository.listStudentYearResults).toHaveBeenCalledWith('student', 'year-1');
  });

  it('distingue l’année confirmée du dossier courant dans la fiche de réinscription', async () => {
    const repository = {
      getStudentSummaryProfile: vi.fn().mockResolvedValue({ id: 'student', first_name: 'Awa', last_name: 'Koné', matricule: 'MAT-1' }),
      listStudentAcademicSummary: vi.fn().mockResolvedValue([
        { school_year_id: 'year-active', school_year_label: '2026-2027', school_year_start_date: '2026-09-01', class_name: '5e A', final_decision: null, enrollment_status: 'pending_cashier' },
        { school_year_id: 'year-prior', school_year_label: '2025-2026', school_year_start_date: '2025-09-01', school_year_status: 'closed', class_name: '6e A', final_decision: 'promoted', enrollment_status: 'confirmed' },
      ]),
    };
    const finance = {
      getFinancialStatus: vi.fn().mockRejectedValue({ code: 'CONFIRMED_ENROLLMENT_REQUIRED' }),
      getHistoricalFinancialStatus: vi.fn().mockResolvedValue({ remainingDue: 25000, totalDue: 100000, confirmedPaid: 65000, currency: 'FCFA' }),
    };
    const summary = await new EnrollmentsService(repository as never, finance as never).getStudentAcademicSummary('student');
    expect(summary.years).toEqual([
      expect.objectContaining({ schoolYearId: 'year-active', enrollmentStatus: 'pending_cashier', financialStatus: 'unavailable', remainingDue: null }),
      expect.objectContaining({ schoolYearId: 'year-prior', enrollmentStatus: 'confirmed', financialStatus: 'remaining_due', remainingDue: 25000, totalDue: 100000, confirmedPaid: 65000 }),
    ]);
    expect(finance.getHistoricalFinancialStatus).toHaveBeenCalledWith('student', 'year-prior');
  });

  it.each([
    [{ levelId: 'other-level' }, 'CLASS_LEVEL_MISMATCH'],
    [{ expectedActiveSchoolYearId: 'other-year' }, 'ACTIVE_SCHOOL_YEAR_CHANGED'],
  ])('valide le contexte de sélection avant toute inscription', async (selection, code) => {
    const repository = {
      getStudentContext: vi.fn().mockResolvedValue({ id: 'student', is_active: true, lifecycle_status: 'active' }),
      getClassContext: vi.fn().mockResolvedValue({ id: 'class', is_active: true, level_id: 'level', school_year_id: 'year', school_year_status: 'active' }),
      createEnrollment: vi.fn(),
    };
    const service = new EnrollmentsService(repository as never);
    await expect(service.createEnrollment({ studentId: 'student', classId: 'class', schoolYearId: 'year', type: 'new_registration', hasPreviousYearUnpaid: false, ...selection })).rejects.toMatchObject({ code });
    expect(repository.createEnrollment).not.toHaveBeenCalled();
  });

  it('refuse une inscription et une modification sur une année non ouverte par le support', async () => {
    const repository = {
      getStudentContext: vi.fn().mockResolvedValue({ id: 'student', is_active: true, lifecycle_status: 'active' }),
      getClassContext: vi.fn().mockResolvedValue({ id: 'class', is_active: true, level_id: 'level', school_year_id: 'year', school_year_status: 'draft' }),
      findEnrollment: vi.fn().mockResolvedValue({ id: 'enrollment', class_id: 'class', school_year_id: 'year', status: 'pending_cashier' }),
      createEnrollment: vi.fn(), updateEnrollment: vi.fn(),
    };
    const service = new EnrollmentsService(repository as never);
    await expect(service.createEnrollment({ studentId: 'student', classId: 'class', schoolYearId: 'year', type: 'new_registration', hasPreviousYearUnpaid: false }))
      .rejects.toMatchObject({ code: 'SCHOOL_YEAR_NOT_OPEN' });
    await expect(service.updateEnrollment('enrollment', { status: 'pending_dossier' }))
      .rejects.toMatchObject({ code: 'SCHOOL_YEAR_NOT_OPEN' });
    expect(repository.createEnrollment).not.toHaveBeenCalled();
    expect(repository.updateEnrollment).not.toHaveBeenCalled();
  });

  it('refuse un niveau modifié pendant le retour au dossier existant', async () => {
    const repository = {
      findEnrollment: vi.fn().mockResolvedValue({ id: 'enrollment', school_year_id: 'year', status: 'pending_cashier' }),
      getClassContext: vi.fn().mockResolvedValue({ id: 'class', is_active: true, level_id: 'other-level', school_year_id: 'year', school_year_status: 'active' }),
      updateEnrollment: vi.fn(),
    };
    await expect(new EnrollmentsService(repository as never).updateEnrollment('enrollment', { classId: 'class', levelId: 'level', expectedActiveSchoolYearId: 'year' })).rejects.toMatchObject({ code: 'CLASS_LEVEL_MISMATCH' });
    expect(repository.updateEnrollment).not.toHaveBeenCalled();
  });

  it('autorise uniquement les transitions modifiables puis la confirmation', () => {
    expect(canTransitionEnrollment('pending_cashier', 'confirmed')).toBe(true);
    expect(canTransitionEnrollment('pending_dossier', 'confirmed')).toBe(true);
    expect(canTransitionEnrollment('confirmed', 'pending_cashier')).toBe(false);
    expect(canTransitionEnrollment('blocked_unpaid', 'confirmed')).toBe(false);
  });

  it('bloque uniquement une réinscription avec impayé antérieur', () => {
    expect(resolveInitialEnrollmentStatus('re_registration', true)).toBe('blocked_unpaid');
    expect(resolveInitialEnrollmentStatus('re_registration', false)).toBe('pending_cashier');
    expect(resolveInitialEnrollmentStatus('new_registration', true)).toBe('pending_cashier');
  });

  it('calcule le solde de campagne avec remises, abonnements obligatoires et paiements validés', async () => {
    const repository = {
      listReEnrollmentBalanceContexts: vi.fn().mockResolvedValue([
        { student_id: 'student-paid', plan_total_amount: '100000', override_total_amount: null, discount_amount: '10000', confirmed_paid: '85000' },
        { student_id: 'student-unpaid', plan_total_amount: '100000', override_total_amount: null, discount_amount: null, confirmed_paid: '50000' },
        { student_id: 'student-no-plan', plan_total_amount: null, override_total_amount: null, discount_amount: null, confirmed_paid: '0' },
      ]),
      listMandatorySubscriptionPlans: vi.fn().mockResolvedValue([{ amount: '5000', period: 'annual', imposed_duration: 'annual' }]),
    };
    const balances = await new FinanceService(repository as never).listReEnrollmentBalances('origin-year');
    expect(balances.get('student-paid')).toBe(10_000);
    expect(balances.get('student-unpaid')).toBe(55000);
    expect(balances.get('student-no-plan')).toBeNull();
  });

  it('dérive chaque statut avant création et garde les compteurs cohérents avec les filtres', async () => {
    const candidate = (studentId: string, overrides: Partial<ReEnrollmentCandidateRow> = {}): ReEnrollmentCandidateRow => ({
      student_id: studentId, student_first_name: studentId, student_last_name: 'Koné', student_matricule: studentId,
      current_class_name: '6e A', current_school_year_id: 'origin-year', current_school_year_label: '2025-2026',
      source_school_year_status: 'active', final_decision: 'promoted', next_level_id: 'level-2', next_level_name: '5e',
      enrollment_id: null, enrollment_status: null, enrollment_class_name: null, is_historical_source: false, ...overrides,
    });
    const repository = { getFollowingSchoolYear: vi.fn().mockResolvedValue(null), listReEnrollmentCandidates: vi.fn().mockResolvedValue([
      candidate('pending', { final_decision: null, next_level_id: null }),
      candidate('ready'), candidate('unpaid'),
      candidate('awaiting', { enrollment_id: 'e-1', enrollment_status: 'pending_cashier' }),
      candidate('documents', { enrollment_id: 'e-3', enrollment_status: 'pending_dossier' }),
      candidate('confirmed', { enrollment_id: 'e-2', enrollment_status: 'confirmed' }),
      candidate('excluded', { final_decision: 'expelled', next_level_id: null }),
      candidate('unknown'),
    ]) };
    const finance = { listReEnrollmentBalances: vi.fn().mockResolvedValue(new Map([
      ['pending', 0], ['ready', 0], ['unpaid', 1000], ['awaiting', 0], ['documents', 0], ['confirmed', 0], ['excluded', 0], ['unknown', null],
    ])) };
    const service = new EnrollmentsService(repository as never, finance as never);
    const input = { sourceSchoolYearId: 'origin-year', campaignStatus: 'all' as const, page: 1, limit: 20 };
    const all = await service.listReEnrollmentCandidates(input);
    expect(all.candidates.map((item) => item.status)).toEqual([
      'decision_pending', 'ready', 'blocked_unpaid', 'awaiting_cashier', 'awaiting_documents', 're_enrolled', 'excluded', 'financial_unavailable',
    ]);
    expect(all.counts).toMatchObject({ decisionPending: 1, ready: 1, blockedUnpaid: 1, awaitingCashier: 1, awaitingDocuments: 1, reEnrolled: 1, excluded: 1, financialUnavailable: 1, all: 8 });
    const blocked = await service.listReEnrollmentCandidates({ ...input, campaignStatus: 'blocked_unpaid' });
    expect(blocked.candidates.map((item) => item.studentId)).toEqual(['unpaid']);
    expect(blocked.counts).toEqual(all.counts);
    const documents = await service.listReEnrollmentCandidates({ ...input, campaignStatus: 'awaiting_documents' });
    expect(documents.candidates.map((item) => item.studentId)).toEqual(['documents']);
    expect(finance.listReEnrollmentBalances).toHaveBeenCalledWith('origin-year');
  });

  it('rend les profils historiques importés réinscriptibles sans consulter la finance historique', async () => {
    const repository = {
      listReEnrollmentCandidates: vi.fn().mockResolvedValue([{
        student_id: 'historical-student', student_first_name: 'Aya', student_last_name: 'Koné',
        student_matricule: 'H-1', current_class_name: '6e A', current_school_year_id: null,
        current_school_year_label: '2024-2025', source_school_year_status: 'historical',
        final_decision: null, next_level_id: null, next_level_name: null, enrollment_id: null,
        enrollment_status: null, enrollment_class_name: null, is_historical_source: true,
      }]),
      getSchoolYear: vi.fn().mockResolvedValue({ id: 'target-year', label: '2026-2027', status: 'active' }),
    };
    const finance = { listReEnrollmentBalances: vi.fn() };
    const result = await new EnrollmentsService(repository as never, finance as never).listReEnrollmentCandidates({
      schoolYearId: 'target-year', sourceSchoolYearLabel: '2024-2025',
      campaignStatus: 'all', page: 1, limit: 20,
    });

    expect(result.candidates).toEqual([expect.objectContaining({ studentId: 'historical-student', status: 'ready', isHistoricalSource: true })]);
    expect(result.targetSchoolYear).toEqual({ id: 'target-year', label: '2026-2027', status: 'active' });
    expect(finance.listReEnrollmentBalances).not.toHaveBeenCalled();
  });

  it('refuse une réinscription tant que l’année source n’est pas clôturée et la cible active', async () => {
    const repository = {
      getStudentContext: vi.fn().mockResolvedValue({
        id: 'student', is_active: true, lifecycle_status: 'active', current_school_year_id: 'year-current',
        current_level_id: 'level-current', final_decision: 'promoted', next_level_id: 'level-target',
      }),
      getClassContext: vi.fn().mockResolvedValue({ id: 'class-target', level_id: 'level-target', school_year_id: 'year-target', school_year_status: 'active', is_active: true }),
      getReEnrollmentYearContext: vi.fn().mockResolvedValue({
        source_school_year_id: 'year-current', source_school_year_status: 'active', source_school_year_end_date: '2027-06-30',
        target_school_year_id: 'year-target', target_school_year_status: 'draft', target_school_year_start_date: '2027-09-01',
      }),
    };
    const service = new EnrollmentsService(repository as never, { getFinancialStatus: vi.fn() } as never);

    await expect(service.createEnrollment({
      studentId: 'student', classId: 'class-target', schoolYearId: 'year-target', type: 're_registration', hasPreviousYearUnpaid: false,
    })).rejects.toEqual(expect.objectContaining<Partial<EnrollmentsModuleError>>({
      code: 'RE_ENROLLMENT_YEAR_TRANSITION_REQUIRED', statusCode: 409,
    }));
  });

  it('vérifie la première année suivante et relit le solde historique lors de la création', async () => {
    const enrollment = {
      id: 'enrollment', student_id: 'student', class_id: 'class-target', school_year_id: 'year-target',
      type: 're_registration' as const, status: 'pending_cashier' as const,
      enrolled_at: new Date('2027-09-01T00:00:00Z'), confirmed_by_user_id: null,
      class_name: '5e A', school_year_label: '2027-2028', student_first_name: 'Aya', student_last_name: 'Koné',
      required_document_count: 0, missing_mandatory_document_count: 0,
    };
    const repository = {
      getStudentContext: vi.fn().mockResolvedValue({ id: 'student', is_active: true, lifecycle_status: 'active', current_school_year_id: 'year-source', current_level_id: 'level-source', final_decision: 'promoted', next_level_id: 'level-target' }),
      getClassContext: vi.fn().mockResolvedValue({ id: 'class-target', is_active: true, level_id: 'level-target', school_year_id: 'year-target', school_year_status: 'active' }),
      getReEnrollmentYearContext: vi.fn().mockResolvedValue({ source_school_year_id: 'year-source', source_school_year_status: 'closed', source_school_year_end_date: '2027-06-30', target_school_year_id: 'year-target', target_school_year_status: 'active', target_school_year_start_date: '2027-09-01' }),
      getFollowingSchoolYear: vi.fn().mockResolvedValue({ id: 'year-target', status: 'active' }),
      createEnrollment: vi.fn().mockResolvedValue(enrollment), ensureRequiredDocuments: vi.fn(),
      findEnrollment: vi.fn().mockResolvedValue(enrollment), listStudentDocuments: vi.fn().mockResolvedValue([]),
    };
    const finance = { getFinancialStatus: vi.fn(), getHistoricalFinancialStatus: vi.fn().mockResolvedValue({ remainingDue: 0 }) };
    const service = new EnrollmentsService(repository as never, finance as never);
    await service.createEnrollment({ studentId: 'student', classId: 'class-target', schoolYearId: 'year-target', type: 're_registration', hasPreviousYearUnpaid: false });
    expect(finance.getHistoricalFinancialStatus).toHaveBeenCalledWith('student', 'year-source');
    expect(finance.getFinancialStatus).not.toHaveBeenCalled();
    repository.getFollowingSchoolYear.mockResolvedValue({ id: 'year-other', status: 'closed' });
    await expect(service.createEnrollment({ studentId: 'student', classId: 'class-target', schoolYearId: 'year-target', type: 're_registration', hasPreviousYearUnpaid: false }))
      .rejects.toMatchObject({ code: 'RE_ENROLLMENT_NEXT_YEAR_REQUIRED' });
  });

  it('autorise la réinscription historique avec choix manuel de classe et solde importé nul', async () => {
    const enrollment = {
      id: 'enrollment', student_id: 'student', class_id: 'class-target', school_year_id: 'year-target',
      type: 're_registration' as const, status: 'pending_cashier' as const,
      enrolled_at: new Date('2027-09-01T00:00:00Z'), confirmed_by_user_id: null,
      class_name: '5e A', school_year_label: '2027-2028', student_first_name: 'Aya', student_last_name: 'Koné',
      required_document_count: 0, missing_mandatory_document_count: 0,
    };
    const repository = {
      getStudentContext: vi.fn().mockResolvedValue({
        id: 'student', is_active: true, lifecycle_status: 'active', current_school_year_id: null,
        current_level_id: null, final_decision: null, next_level_id: null,
      }),
      getClassContext: vi.fn().mockResolvedValue({
        id: 'class-target', is_active: true, level_id: 'level-target',
        school_year_id: 'year-target', school_year_status: 'active',
      }),
      hasHistoricalSourceBeforeTarget: vi.fn().mockResolvedValue(true),
      createEnrollment: vi.fn().mockResolvedValue(enrollment),
      ensureRequiredDocuments: vi.fn(),
      findEnrollment: vi.fn().mockResolvedValue(enrollment),
      listStudentDocuments: vi.fn().mockResolvedValue([]),
    };
    const finance = { getHistoricalFinancialStatus: vi.fn() };
    const result = await new EnrollmentsService(repository as never, finance as never).createEnrollment({
      studentId: 'student', classId: 'class-target', schoolYearId: 'year-target',
      type: 're_registration', hasPreviousYearUnpaid: false, sourceSchoolYearLabel: '2024-2025',
    });

    expect(result.enrollment.status).toBe('pending_cashier');
    expect(repository.hasHistoricalSourceBeforeTarget).toHaveBeenCalledWith('student', '2024-2025', 'year-target');
    expect(repository.createEnrollment).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending_cashier' }));
    expect(finance.getHistoricalFinancialStatus).not.toHaveBeenCalled();
  });

  it('dédoublonne les documents requis par type pour un niveau', () => {
    const base = {
      student_id: 'student', document_type_name: 'Extrait', is_mandatory: true,
      is_active: true,
      status: 'missing' as const, file_url: null, r2_key: null, provided_at: null, notes: null,
    };
    const documents = [
      { ...base, id: 'one', document_type_id: 'birth-certificate' },
      { ...base, id: 'two', document_type_id: 'birth-certificate' },
      { ...base, id: 'three', document_type_id: 'photo' },
    ] satisfies StudentDocumentRow[];
    expect(deduplicateRequiredDocuments(documents).map((item) => item.document_type_id)).toEqual([
      'birth-certificate', 'photo',
    ]);
  });

  it('conserve le paiement possible malgré un dossier incomplet', async () => {
    const enrollment = {
      id: 'enrollment', student_id: 'student', class_id: 'class', school_year_id: 'year',
      type: 're_registration' as const, status: 'pending_cashier' as const,
      enrolled_at: new Date('2026-08-01T00:00:00Z'), confirmed_by_user_id: null,
      class_name: '6e A', school_year_label: '2026-2027',
    };
    const repository = {
      findEnrollment: vi.fn()
        .mockResolvedValueOnce(enrollment)
        .mockResolvedValueOnce({ ...enrollment, status: 'confirmed', confirmed_by_user_id: 'user' }),
      getClassContext: vi.fn().mockResolvedValue({ id: 'class', school_year_status: 'active' }),
      listStudentDocuments: vi.fn().mockResolvedValue([{
        id: 'document', student_id: 'student', document_type_id: 'photo', document_type_name: 'Photo',
        is_mandatory: true, is_active: true, status: 'missing', file_url: null, r2_key: null, provided_at: null, notes: null,
      }]),
    };
    const paymentRecorder = {
      recordEnrollmentPayment: vi.fn().mockResolvedValue({ payment: { id: 'payment' } }),
      getFinancialStatus: vi.fn().mockResolvedValue({ remainingDue: 0 }),
    };
    const service = new EnrollmentsService(repository as never, paymentRecorder);
    const result = await service.confirmPayment('enrollment', 'user', {
      amount: 25_000, method: 'cash', schoolReceiptReference: 'RC-UNIT-001',
    });
    expect(paymentRecorder.recordEnrollmentPayment).toHaveBeenCalledWith({
      enrollmentId: 'enrollment', actorUserId: 'user', amount: 25_000, method: 'cash',
      schoolReceiptReference: 'RC-UNIT-001',
    });
    expect(result.enrollment.status).toBe('confirmed');
    expect(result.payment.id).toBe('payment');
    expect(result.missingMandatoryDocuments).toHaveLength(1);
    expect(result.documentWarning).toContain('Paiement confirmé');
  });

  it('prépare une notification unique avec les pièces obligatoires manquantes', async () => {
    const repository = {
      syncActiveRequiredDocumentsForStudent: vi.fn().mockResolvedValue(undefined),
      getStudentNotificationContext: vi.fn().mockResolvedValue({
        id: 'student', first_name: 'Mariam', parent_phone: '2250700000001', parent_phone_2: '2250700000001',
      }),
      listStudentDocuments: vi.fn().mockResolvedValue([
        { id: 'one', student_id: 'student', document_type_id: 'birth', document_type_name: 'Extrait', is_mandatory: true, is_active: true, status: 'missing', file_url: null, r2_key: null, provided_at: null, notes: null },
        { id: 'two', student_id: 'student', document_type_id: 'photo', document_type_name: 'Photo', is_mandatory: false, is_active: true, status: 'missing', file_url: null, r2_key: null, provided_at: null, notes: null },
      ] satisfies StudentDocumentRow[]),
    };
    const result = await new EnrollmentsService(repository as never).verifyStudentDocuments('student');

    expect(result.dossierComplete).toBe(false);
    expect(result.missingMandatoryDocuments).toHaveLength(1);
    expect(result.notification).toEqual({
      studentFirstName: 'Mariam',
      parentPhones: ['2250700000001'],
      missingDocumentNames: ['Extrait'],
    });
  });
});
