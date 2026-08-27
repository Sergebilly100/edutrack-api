import { describe, expect, it, vi } from 'vitest';

import type { StudentDocumentRow } from '../../src/modules/enrollments/enrollments.repository.js';
import {
  canTransitionEnrollment,
  deduplicateRequiredDocuments,
  EnrollmentsService,
  resolveInitialEnrollmentStatus,
} from '../../src/modules/enrollments/enrollments.service.js';

describe('enrollment workflow rules', () => {
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
    const result = await service.confirmPayment('enrollment', 'user', { method: 'cash' });
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
