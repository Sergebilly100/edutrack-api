import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ValidationModuleError, ValidationsService } from '../../src/modules/validations/validations.service.js';

// ── Repository mock ───────────────────────────────────────────────────────────

const makeContextRow = (overrides: Record<string, unknown> = {}) => ({
  attendance_id: 'att-uuid-1',
  teacher_id: 'teacher-uuid-1',
  teacher_user_id: 'user-uuid-1',
  teacher_name: 'M. Koné',
  teacher_phone: null,
  teacher_email: 'kone@school.ci',
  course_name: 'Mathématiques',
  class_name: '3ème A',
  date: '2026-05-01',
  checked_in_at: '2026-05-01T08:00:00',
  checked_out_at: null,
  geo_status: null,
  checkin_distance: null,
  actual_minutes: 40,
  schedule_duration_minutes: '60',
  validation_reason: null,
  hourly_rate: 5000,
  kind: 'short_hours' as const,
  slot_label: '8h-9h',
  room_name: 'Salle A1',
  period_month: '2026-05-01',
  ...overrides,
});

const makeEndScanRecord = (overrides: Record<string, unknown> = {}) => ({
  attendance_id: 'att-uuid-1',
  teacher_id: 'teacher-uuid-1',
  teacher_user_id: 'user-uuid-1',
  teacher_name: 'M. Koné',
  teacher_phone: null,
  teacher_email: 'kone@school.ci',
  course_name: 'Mathématiques',
  date: '2026-05-01',
  end_scan_action: null,
  end_scan_action_cancelled_at: null,
  validation_status: 'pending',
  ...overrides,
});

const repository = {
  transaction: vi.fn(),
  findValidationContext: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  insertRejectedTeacherNotification: vi.fn(),
  recomputeForAttendanceDate: vi.fn(),
  auditValidation: vi.fn(),
  listPending: vi.fn(),
  countPending: vi.fn(),
  listMissingEndScans: vi.fn(),
  getTeacherUserInfo: vi.fn(),
  insertEndScanWarningNotification: vi.fn(),
  invalidateSession: vi.fn(),
  findAttendanceForEndScanAction: vi.fn(),
  applyEndScanAction: vi.fn(),
  setSanctionedAttendanceRejected: vi.fn(),
  revertSanctionedAttendance: vi.fn(),
  cancelEndScanSanction: vi.fn(),
  insertEndScanActionNotification: vi.fn(),
  insertSanctionCancelledNotification: vi.fn(),
  listTeacherNotifications: vi.fn(),
  findTeacherNotification: vi.fn(),
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
};

const context = {
  schemaName: 'school_test',
  tenantId: 'tenant-uuid-1',
  userId: 'director-uuid-1',
  role: 'director',
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ValidationsService', () => {
  let service: ValidationsService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ValidationsService(repository as never);

    // Par défaut, transaction() exécute directement le callback avec le repo comme tx
    repository.transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(repository));
    repository.recomputeForAttendanceDate.mockResolvedValue(undefined);
    repository.auditValidation.mockResolvedValue(undefined);
    repository.insertRejectedTeacherNotification.mockResolvedValue(undefined);
    repository.insertEndScanActionNotification.mockResolvedValue(undefined);
    repository.insertSanctionCancelledNotification.mockResolvedValue(undefined);
  });

  // ── approve ───────────────────────────────────────────────────────────────

  describe('approve', () => {
    it('approuve avec les heures planifiées quand validatedHours absent', async () => {
      const ctx = makeContextRow({ schedule_duration_minutes: '60' });
      repository.findValidationContext.mockResolvedValue(ctx);
      repository.approve.mockResolvedValue(undefined);

      const result = await service.approve({ attendanceId: 'att-uuid-1' }, context);

      expect(result).toEqual({ success: true });
      expect(repository.approve).toHaveBeenCalledWith(
        expect.objectContaining({ validatedHours: 1 }),
        repository
      );
    });

    it('approuve avec les heures fournies quand validatedHours présent', async () => {
      const ctx = makeContextRow({ schedule_duration_minutes: '60' });
      repository.findValidationContext.mockResolvedValue(ctx);
      repository.approve.mockResolvedValue(undefined);

      await service.approve({ attendanceId: 'att-uuid-1', validatedHours: 0.75 }, context);

      expect(repository.approve).toHaveBeenCalledWith(
        expect.objectContaining({ validatedHours: 0.75 }),
        repository
      );
    });

    it('lève VALIDATION_NOT_FOUND si la présence est introuvable', async () => {
      repository.findValidationContext.mockResolvedValue(null);

      await expect(service.approve({ attendanceId: 'att-uuid-1' }, context)).rejects.toThrow(
        ValidationModuleError
      );
      await expect(service.approve({ attendanceId: 'att-uuid-1' }, context)).rejects.toMatchObject({
        code: 'VALIDATION_NOT_FOUND',
        statusCode: 404,
      });
    });

    it('déclenche un audit après approbation', async () => {
      const ctx = makeContextRow();
      repository.findValidationContext.mockResolvedValue(ctx);
      repository.approve.mockResolvedValue(undefined);

      await service.approve({ attendanceId: 'att-uuid-1' }, context);

      expect(repository.auditValidation).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'attendance_validation_approved' })
      );
    });

    it('recalcule le salaire après approbation', async () => {
      const ctx = makeContextRow();
      repository.findValidationContext.mockResolvedValue(ctx);
      repository.approve.mockResolvedValue(undefined);

      await service.approve({ attendanceId: 'att-uuid-1' }, context);

      expect(repository.recomputeForAttendanceDate).toHaveBeenCalledWith(
        ctx.teacher_id,
        ctx.date
      );
    });
  });

  // ── reject ────────────────────────────────────────────────────────────────

  describe('reject', () => {
    it('rejette avec le motif fourni', async () => {
      const ctx = makeContextRow();
      repository.findValidationContext.mockResolvedValue(ctx);
      repository.reject.mockResolvedValue(undefined);

      const result = await service.reject({ attendanceId: 'att-uuid-1', reason: 'Absent' }, context);

      expect(result).toEqual({ success: true });
      expect(repository.reject).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'Absent' }),
        repository
      );
    });

    it('lève VALIDATION_NOT_FOUND si la présence est introuvable', async () => {
      repository.findValidationContext.mockResolvedValue(null);

      await expect(
        service.reject({ attendanceId: 'att-uuid-1', reason: 'Absent' }, context)
      ).rejects.toMatchObject({ code: 'VALIDATION_NOT_FOUND', statusCode: 404 });
    });

    it('insère une notification de rejet', async () => {
      const ctx = makeContextRow();
      repository.findValidationContext.mockResolvedValue(ctx);
      repository.reject.mockResolvedValue(undefined);

      await service.reject({ attendanceId: 'att-uuid-1', reason: 'Fraude' }, context);

      expect(repository.insertRejectedTeacherNotification).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'Fraude' })
      );
    });
  });

  // ── applyEndScanAction ────────────────────────────────────────────────────

  describe('applyEndScanAction', () => {
    it('applique un avertissement et envoie une notification', async () => {
      repository.findAttendanceForEndScanAction.mockResolvedValue(makeEndScanRecord());
      repository.applyEndScanAction.mockResolvedValue(undefined);

      const result = await service.applyEndScanAction(
        { attendanceId: 'att-uuid-1', action: 'warned', reason: 'Scan oublié' },
        context
      );

      expect(result).toEqual({ success: true });
      expect(repository.applyEndScanAction).toHaveBeenCalled();
      expect(repository.setSanctionedAttendanceRejected).not.toHaveBeenCalled();
      expect(repository.insertEndScanActionNotification).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'warned' })
      );
    });

    it('applique une sanction et rejette la présence', async () => {
      repository.findAttendanceForEndScanAction.mockResolvedValue(makeEndScanRecord());
      repository.applyEndScanAction.mockResolvedValue(undefined);
      repository.setSanctionedAttendanceRejected.mockResolvedValue(undefined);

      await service.applyEndScanAction(
        { attendanceId: 'att-uuid-1', action: 'sanctioned', reason: 'Absent confirmé' },
        context
      );

      expect(repository.setSanctionedAttendanceRejected).toHaveBeenCalled();
      expect(repository.recomputeForAttendanceDate).toHaveBeenCalled();
    });

    it('lève ATTENDANCE_NOT_FOUND si la présence est introuvable', async () => {
      repository.findAttendanceForEndScanAction.mockResolvedValue(null);

      await expect(
        service.applyEndScanAction({ attendanceId: 'x', action: 'warned', reason: 'r' }, context)
      ).rejects.toMatchObject({ code: 'ATTENDANCE_NOT_FOUND', statusCode: 404 });
    });

    it('lève END_SCAN_ACTION_ALREADY_SET si une action active existe déjà', async () => {
      repository.findAttendanceForEndScanAction.mockResolvedValue(
        makeEndScanRecord({ end_scan_action: 'warned', end_scan_action_cancelled_at: null })
      );

      await expect(
        service.applyEndScanAction({ attendanceId: 'att-uuid-1', action: 'sanctioned', reason: 'r' }, context)
      ).rejects.toMatchObject({ code: 'END_SCAN_ACTION_ALREADY_SET', statusCode: 409 });
    });

    it("permet d'appliquer une action si la précédente est annulée", async () => {
      repository.findAttendanceForEndScanAction.mockResolvedValue(
        makeEndScanRecord({
          end_scan_action: 'warned',
          end_scan_action_cancelled_at: '2026-05-01T10:00:00',
        })
      );
      repository.applyEndScanAction.mockResolvedValue(undefined);

      await expect(
        service.applyEndScanAction({ attendanceId: 'att-uuid-1', action: 'sanctioned', reason: 'r' }, context)
      ).resolves.toEqual({ success: true });
    });

    it('lève SESSION_ALREADY_APPROVED si la session est déjà approuvée', async () => {
      repository.findAttendanceForEndScanAction.mockResolvedValue(
        makeEndScanRecord({ validation_status: 'approved' })
      );

      await expect(
        service.applyEndScanAction({ attendanceId: 'att-uuid-1', action: 'warned', reason: 'r' }, context)
      ).rejects.toMatchObject({ code: 'SESSION_ALREADY_APPROVED', statusCode: 409 });
    });
  });

  // ── cancelEndScanSanction ─────────────────────────────────────────────────

  describe('cancelEndScanSanction', () => {
    it('annule la sanction et recalcule le salaire', async () => {
      repository.findAttendanceForEndScanAction.mockResolvedValue(
        makeEndScanRecord({ end_scan_action: 'sanctioned', end_scan_action_cancelled_at: null })
      );
      repository.cancelEndScanSanction.mockResolvedValue(undefined);
      repository.revertSanctionedAttendance.mockResolvedValue(undefined);

      const result = await service.cancelEndScanSanction(
        { attendanceId: 'att-uuid-1', reason: 'Erreur de saisie' },
        context
      );

      expect(result).toEqual({ success: true });
      expect(repository.revertSanctionedAttendance).toHaveBeenCalledWith('att-uuid-1');
      expect(repository.recomputeForAttendanceDate).toHaveBeenCalled();
      expect(repository.insertSanctionCancelledNotification).toHaveBeenCalled();
    });

    it("lève NO_ACTIVE_SANCTION si l'action n'est pas une sanction active", async () => {
      repository.findAttendanceForEndScanAction.mockResolvedValue(
        makeEndScanRecord({ end_scan_action: 'warned', end_scan_action_cancelled_at: null })
      );

      await expect(
        service.cancelEndScanSanction({ attendanceId: 'att-uuid-1', reason: 'r' }, context)
      ).rejects.toMatchObject({ code: 'NO_ACTIVE_SANCTION', statusCode: 409 });
    });

    it("lève NO_ACTIVE_SANCTION si la sanction est déjà annulée", async () => {
      repository.findAttendanceForEndScanAction.mockResolvedValue(
        makeEndScanRecord({
          end_scan_action: 'sanctioned',
          end_scan_action_cancelled_at: '2026-05-01T10:00:00',
        })
      );

      await expect(
        service.cancelEndScanSanction({ attendanceId: 'att-uuid-1', reason: 'r' }, context)
      ).rejects.toMatchObject({ code: 'NO_ACTIVE_SANCTION', statusCode: 409 });
    });

    it('lève ATTENDANCE_NOT_FOUND si la présence est introuvable', async () => {
      repository.findAttendanceForEndScanAction.mockResolvedValue(null);

      await expect(
        service.cancelEndScanSanction({ attendanceId: 'att-uuid-1', reason: 'r' }, context)
      ).rejects.toMatchObject({ code: 'ATTENDANCE_NOT_FOUND', statusCode: 404 });
    });
  });

  // ── sendEndScanWarnings ───────────────────────────────────────────────────

  describe('sendEndScanWarnings', () => {
    it('envoie les avertissements uniquement aux profs avec des scans manquants', async () => {
      repository.getTeacherUserInfo.mockResolvedValue([
        { teacher_id: 'teacher-1', user_id: 'user-1', teacher_name: 'M. Koné', phone: null, email: null },
        { teacher_id: 'teacher-2', user_id: 'user-2', teacher_name: 'Mme Bah', phone: null, email: null },
      ]);
      repository.listMissingEndScans.mockResolvedValue([
        { teacherId: 'teacher-1', missingEndScanCount: 2, sessions: [] },
        { teacherId: 'teacher-2', missingEndScanCount: 0, sessions: [] },
      ]);
      repository.insertEndScanWarningNotification.mockResolvedValue(undefined);

      const result = await service.sendEndScanWarnings(['teacher-1', 'teacher-2'], '2026-05', context);

      expect(result).toEqual({ sentCount: 1 });
      expect(repository.insertEndScanWarningNotification).toHaveBeenCalledTimes(1);
    });

    it('lève TEACHERS_NOT_FOUND si aucun prof trouvé', async () => {
      repository.getTeacherUserInfo.mockResolvedValue([]);

      await expect(
        service.sendEndScanWarnings(['teacher-1'], '2026-05', context)
      ).rejects.toMatchObject({ code: 'TEACHERS_NOT_FOUND', statusCode: 404 });
    });
  });

  // ── markTeacherNotificationRead ───────────────────────────────────────────

  describe('markTeacherNotificationRead', () => {
    it('marque la notification comme lue', async () => {
      repository.findTeacherNotification.mockResolvedValue({ id: 'notif-1' });
      repository.markNotificationRead.mockResolvedValue(undefined);

      const result = await service.markTeacherNotificationRead('notif-1', 'user-1');

      expect(result).toEqual({ success: true });
      expect(repository.markNotificationRead).toHaveBeenCalledWith('notif-1');
    });

    it('lève NOTIFICATION_NOT_FOUND si la notification est introuvable', async () => {
      repository.findTeacherNotification.mockResolvedValue(null);

      await expect(
        service.markTeacherNotificationRead('notif-x', 'user-1')
      ).rejects.toMatchObject({ code: 'NOTIFICATION_NOT_FOUND', statusCode: 404 });
    });
  });
});
