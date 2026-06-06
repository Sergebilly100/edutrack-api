import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BillingModuleError, BillingService } from '../../src/modules/billing/billing.service.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const makeMetricRow = (overrides: Record<string, unknown> = {}) => ({
  teacher_id: 'teacher-1',
  teacher_name: 'M. Koné',
  teacher_type: 'vacataire' as const,
  hourly_rate: 5000,
  monthly_salary: null,
  hours_planned: '20',
  hours_done: '10',
  total_fcfa: '50000',
  salary_record_id: 'record-1',
  salary_status: 'pending' as const,
  paid_at: null,
  paid_by: null,
  paid_by_name: null,
  hours_done_since_paid: '0',
  paid_hours: '0',
  paid_amount: '0',
  paid_hours_before_paid_at: '0',
  paid_amount_before_paid_at: '0',
  paid_hours_after_paid_at: '0',
  paid_amount_after_paid_at: '0',
  notes: null,
  ...overrides,
});

const makePermanentMetricRow = (overrides: Record<string, unknown> = {}) =>
  makeMetricRow({
    teacher_type: 'permanent' as const,
    hourly_rate: null,
    monthly_salary: 350000,
    total_fcfa: '350000',
    ...overrides,
  });

const makeSalaryRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 'record-1',
  teacher_id: 'teacher-1',
  teacher_type: 'vacataire' as const,
  period_month: '2026-04-01',
  hours_planned: '20',
  hours_done: '10',
  hourly_rate: 5000,
  total_fcfa: 50000,
  status: 'pending' as const,
  paid_at: null,
  paid_by: null,
  notes: null,
  created_at: '2026-04-15T10:00:00.000Z',
  ...overrides,
});

const makePaymentSummary = (overrides: Record<string, unknown> = {}) => ({
  paid_hours: '0',
  paid_amount: '0',
  payments_count: '0',
  last_paid_at: null,
  ...overrides,
});

const makeSalaryPayment = (overrides: Record<string, unknown> = {}) => ({
  id: 'payment-1',
  salary_record_id: 'record-1',
  hours_paid: '5',
  amount_fcfa: 25000,
  paid_at: '2026-04-15T10:00:00.000Z',
  paid_by: 'director-1',
  paid_by_name: null,
  paid_by_role: null,
  notes: null,
  ...overrides,
});

const repository = {
  listTeacherMonthlyMetrics: vi.fn(),
  getLastComputedDate: vi.fn(),
  findTeacherById: vi.fn(),
  listTeacherDailyBreakdown: vi.fn(),
  getSalaryRecordById: vi.fn(),
  listPaymentsForRecord: vi.fn(),
  getSalaryPaymentsSummary: vi.fn(),
  upsertSalaryRecord: vi.fn(),
  batchUpsertSalaryRecords: vi.fn(),
  hasSalaryStatusValue: vi.fn(),
  updateSalaryStatus: vi.fn(),
  updateSalaryRecordAfterPayment: vi.fn(),
  createSalaryPayment: vi.fn(),
  createVacatairePartialPaymentAtomic: vi.fn(),
  auditSalaryAction: vi.fn(),
  listTeacherPaymentHistory: vi.fn(),
  listTeacherSalaryRecordsInRange: vi.fn(),
  listPastUnpaidSalaryAlerts: vi.fn(),
  countPaidRecords: vi.fn(),
  findJobRecordExists: vi.fn(),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BillingService', () => {
  let service: BillingService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new BillingService(repository as never);
  });

  // ── getMonthBounds ────────────────────────────────────────────────────────

  describe('getMonthBounds', () => {
    it('calcule correctement les bornes de janvier', () => {
      const { monthStart, monthEnd } = service.getMonthBounds('2026-01');
      expect(monthStart).toBe('2026-01-01');
      expect(monthEnd).toBe('2026-01-31');
    });

    it('calcule correctement les bornes de février en année bissextile', () => {
      const { monthStart, monthEnd } = service.getMonthBounds('2024-02');
      expect(monthStart).toBe('2024-02-01');
      expect(monthEnd).toBe('2024-02-29');
    });

    it("calcule correctement les bornes d'avril", () => {
      const { monthStart, monthEnd } = service.getMonthBounds('2026-04');
      expect(monthStart).toBe('2026-04-01');
      expect(monthEnd).toBe('2026-04-30');
    });

    it('rejette un format de mois invalide', () => {
      expect(() => service.getMonthBounds('2026-13')).toThrow(BillingModuleError);
      expect(() => service.getMonthBounds('abcd-01')).toThrow(BillingModuleError);
      expect(() => service.getMonthBounds('2026-00')).toThrow(BillingModuleError);
    });

    it('rejette une année hors plage (2000-2100)', () => {
      expect(() => service.getMonthBounds('1999-01')).toThrow(BillingModuleError);
      expect(() => service.getMonthBounds('2101-01')).toThrow(BillingModuleError);
    });
  });

  // ── getSalarySummary ──────────────────────────────────────────────────────

  describe('getSalarySummary', () => {
    it('retourne les items triés par totalFcfa décroissant', async () => {
      repository.listTeacherMonthlyMetrics.mockResolvedValue([
        makeMetricRow({ teacher_id: 'a', total_fcfa: '10000', hours_done: '2' }),
        makeMetricRow({ teacher_id: 'b', total_fcfa: '50000', hours_done: '10' }),
        makeMetricRow({ teacher_id: 'c', total_fcfa: '25000', hours_done: '5' }),
      ]);
      repository.getLastComputedDate.mockResolvedValue(null);

      const result = await service.getSalarySummary('2026-04');

      expect(result.items.map((i) => i.totalFcfa)).toEqual([50000, 25000, 10000]);
    });

    it('calcule correctement le statut paid pour un vacataire entièrement payé', async () => {
      repository.listTeacherMonthlyMetrics.mockResolvedValue([
        makeMetricRow({
          salary_status: 'paid',
          paid_hours: '10',
          paid_amount: '50000',
          hours_done: '10',
          total_fcfa: '50000',
        }),
      ]);
      repository.getLastComputedDate.mockResolvedValue('2026-04-01T10:00:00Z');

      const result = await service.getSalarySummary('2026-04');

      expect(result.items[0]?.status).toBe('paid');
      expect(result.items[0]?.amountAlreadyPaid).toBe(50000);
    });

    it('expose lastComputedAt depuis le repository', async () => {
      repository.listTeacherMonthlyMetrics.mockResolvedValue([]);
      repository.getLastComputedDate.mockResolvedValue('2026-04-30T14:00:00.000Z');

      const result = await service.getSalarySummary('2026-04');

      expect(result.lastComputedAt).toBe('2026-04-30T14:00:00.000Z');
    });

    it('retourne nothing_to_pay pour un vacataire sans heures', async () => {
      repository.listTeacherMonthlyMetrics.mockResolvedValue([
        makeMetricRow({ hours_done: '0', total_fcfa: '0', salary_status: 'pending', paid_hours: '0' }),
      ]);
      repository.getLastComputedDate.mockResolvedValue(null);

      const result = await service.getSalarySummary('2026-04');

      expect(result.items[0]?.status).toBe('nothing_to_pay');
    });
  });

  // ── computeSalaryRecords ──────────────────────────────────────────────────

  describe('computeSalaryRecords', () => {
    it('ne recalcule pas un vacataire sans heures et sans planification', async () => {
      repository.listTeacherMonthlyMetrics.mockResolvedValue([
        makeMetricRow({ hours_planned: '0', hours_done: '0' }),
      ]);
      repository.hasSalaryStatusValue.mockResolvedValue(true);
      repository.batchUpsertSalaryRecords.mockResolvedValue(0);

      await service.computeSalaryRecords('2026-04');

      expect(repository.batchUpsertSalaryRecords).toHaveBeenCalledWith([]);
    });

    it('ignore un vacataire sans taux horaire', async () => {
      repository.listTeacherMonthlyMetrics.mockResolvedValue([
        makeMetricRow({ hourly_rate: null }),
      ]);
      repository.hasSalaryStatusValue.mockResolvedValue(true);
      repository.batchUpsertSalaryRecords.mockResolvedValue(0);

      await service.computeSalaryRecords('2026-04');

      expect(repository.batchUpsertSalaryRecords).toHaveBeenCalledWith([]);
    });

    it('préserve le statut paid lors du recalcul (bug 1)', async () => {
      // Simule un enregistrement déjà payé : paidHours couvre toutes les heures faites
      repository.listTeacherMonthlyMetrics.mockResolvedValue([
        makeMetricRow({
          salary_status: 'paid',
          paid_hours: '10',
          paid_amount: '50000',
          paid_at: '2026-04-15T10:00:00Z',
          hours_done: '10',
          total_fcfa: '50000',
        }),
      ]);
      repository.hasSalaryStatusValue.mockResolvedValue(true);
      repository.batchUpsertSalaryRecords.mockResolvedValue(1);

      await service.computeSalaryRecords('2026-04');

      const upsertCall = repository.batchUpsertSalaryRecords.mock.calls[0]?.[0];
      expect(upsertCall).toHaveLength(1);
      expect(upsertCall[0].status).toBe('paid');
    });

    it('calcule status=pending quand des heures restent à payer (vacataire)', async () => {
      repository.listTeacherMonthlyMetrics.mockResolvedValue([
        makeMetricRow({
          salary_status: 'pending',
          paid_hours: '5',
          paid_amount: '25000',
          hours_done: '10',
          total_fcfa: '50000',
        }),
      ]);
      repository.hasSalaryStatusValue.mockResolvedValue(true);
      repository.batchUpsertSalaryRecords.mockResolvedValue(1);

      await service.computeSalaryRecords('2026-04');

      const upsertCall = repository.batchUpsertSalaryRecords.mock.calls[0]?.[0];
      expect(upsertCall[0].status).toBe('pending');
    });

    it('calcule status=paid pour un permanent dont le montant est couvert', async () => {
      repository.listTeacherMonthlyMetrics.mockResolvedValue([
        makePermanentMetricRow({
          salary_status: 'pending',
          paid_amount: '350000',
          paid_at: '2026-04-15T10:00:00Z',
          hours_done: '80',
        }),
      ]);
      repository.hasSalaryStatusValue.mockResolvedValue(true);
      repository.batchUpsertSalaryRecords.mockResolvedValue(1);

      await service.computeSalaryRecords('2026-04');

      const upsertCall = repository.batchUpsertSalaryRecords.mock.calls[0]?.[0];
      expect(upsertCall[0].status).toBe('paid');
      expect(upsertCall[0].totalFcfa).toBe(350000);
    });

    it('ne touche pas au statut disputed lors du recalcul', async () => {
      repository.listTeacherMonthlyMetrics.mockResolvedValue([
        makeMetricRow({ salary_status: 'disputed', paid_hours: '0', hours_done: '10' }),
      ]);
      repository.hasSalaryStatusValue.mockResolvedValue(true);
      repository.batchUpsertSalaryRecords.mockResolvedValue(1);

      await service.computeSalaryRecords('2026-04');

      const upsertCall = repository.batchUpsertSalaryRecords.mock.calls[0]?.[0];
      expect(upsertCall[0].status).toBe('disputed');
    });
  });

  // ── updateSalaryRecordStatus - permanent ─────────────────────────────────

  describe('updateSalaryRecordStatus - permanent', () => {
    const actor = { userId: 'director-1', role: 'director' as const };

    it('rejette si acteur non director', async () => {
      await expect(
        service.updateSalaryRecordStatus({
          recordId: 'record-1',
          status: 'paid',
          actor: { userId: 'staff-1', role: 'staff' },
        })
      ).rejects.toMatchObject({ code: 'DIRECTOR_REQUIRED_FOR_PAID', statusCode: 403 });
    });

    it("rejette si le record n'existe pas", async () => {
      repository.getSalaryRecordById.mockResolvedValue(null);

      await expect(
        service.updateSalaryRecordStatus({ recordId: 'missing', status: 'paid', actor })
      ).rejects.toMatchObject({ code: 'SALARY_RECORD_NOT_FOUND', statusCode: 404 });
    });

    it('rejette un double paiement mensuel permanent (409)', async () => {
      repository.getSalaryRecordById.mockResolvedValue(
        makeSalaryRecord({ teacher_type: 'permanent', total_fcfa: 350000, paid_at: '2026-04-15T10:00:00Z' })
      );
      repository.getSalaryPaymentsSummary.mockResolvedValue(makePaymentSummary({ paid_amount: '350000' }));

      await expect(
        service.updateSalaryRecordStatus({ recordId: 'record-1', status: 'paid', actor })
      ).rejects.toMatchObject({ code: 'SALARY_ALREADY_PAID_FOR_MONTH', statusCode: 409 });
    });

    it('marque un permanent comme payé avec succès', async () => {
      repository.getSalaryRecordById.mockResolvedValue(
        makeSalaryRecord({ teacher_type: 'permanent', total_fcfa: 350000 })
      );
      repository.getSalaryPaymentsSummary.mockResolvedValue(makePaymentSummary());
      repository.createSalaryPayment.mockResolvedValue({ id: 'pay-1' });
      repository.updateSalaryRecordAfterPayment.mockResolvedValue(
        makeSalaryRecord({ teacher_type: 'permanent', status: 'paid', total_fcfa: 350000 })
      );

      const result = await service.updateSalaryRecordStatus({
        recordId: 'record-1',
        status: 'paid',
        actor,
      });

      expect(result.record.status).toBe('paid');
      expect(repository.createSalaryPayment).toHaveBeenCalledWith(
        expect.objectContaining({ amountFcfa: 350000, hoursPaid: null })
      );
    });
  });

  // ── updateSalaryRecordStatus - vacataire ──────────────────────────────────

  describe('updateSalaryRecordStatus - vacataire', () => {
    const actor = { userId: 'director-1', role: 'director' as const, schemaName: 'school_test' };

    it('rejette si hoursToPay manquant pour vacataire', async () => {
      repository.getSalaryRecordById.mockResolvedValue(makeSalaryRecord());
      repository.getSalaryPaymentsSummary.mockResolvedValue(makePaymentSummary());

      await expect(
        service.updateSalaryRecordStatus({ recordId: 'record-1', status: 'paid', actor })
      ).rejects.toMatchObject({ code: 'HOURS_TO_PAY_REQUIRED', statusCode: 400 });
    });

    it('rejette si hoursToPay dépasse les heures restantes', async () => {
      repository.getSalaryRecordById.mockResolvedValue(
        makeSalaryRecord({ hours_done: '10', hourly_rate: 5000, total_fcfa: 50000 })
      );
      repository.getSalaryPaymentsSummary.mockResolvedValue(makePaymentSummary({ paid_hours: '8' }));
      repository.createVacatairePartialPaymentAtomic.mockRejectedValue(
        new Error('insufficient remaining hours')
      );

      await expect(
        service.updateSalaryRecordStatus({
          recordId: 'record-1',
          status: 'paid',
          actor,
          hoursToPay: 5,
        })
      ).rejects.toMatchObject({ code: 'HOURS_TO_PAY_EXCEEDS_REMAINING', statusCode: 400 });
    });

    it('enregistre un paiement partiel et status reste pending', async () => {
      const partialRecord = makeSalaryRecord({ status: 'pending', hours_done: '10', hourly_rate: 5000, total_fcfa: 50000 });
      repository.getSalaryRecordById.mockResolvedValue(
        makeSalaryRecord({ hours_done: '10', hourly_rate: 5000, total_fcfa: 50000 })
      );
      repository.getSalaryPaymentsSummary.mockResolvedValue(makePaymentSummary());
      repository.createVacatairePartialPaymentAtomic.mockResolvedValue({
        record: partialRecord,
        payment: makeSalaryPayment({ hours_paid: '5', amount_fcfa: 25000 }),
      });
      repository.auditSalaryAction.mockResolvedValue(undefined);

      const result = await service.updateSalaryRecordStatus({
        recordId: 'record-1',
        status: 'paid',
        actor,
        hoursToPay: 5,
      });

      expect(repository.createVacatairePartialPaymentAtomic).toHaveBeenCalledWith(
        expect.objectContaining({ requestedHours: 5, hourlyRate: 5000 })
      );
      expect(result.record.status).toBe('pending');
    });

    it('enregistre un paiement complet et status passe à paid', async () => {
      const paidRecord = makeSalaryRecord({ status: 'paid', hours_done: '10', hourly_rate: 5000, total_fcfa: 50000 });
      repository.getSalaryRecordById.mockResolvedValue(
        makeSalaryRecord({ hours_done: '10', hourly_rate: 5000, total_fcfa: 50000 })
      );
      repository.getSalaryPaymentsSummary.mockResolvedValue(makePaymentSummary());
      repository.createVacatairePartialPaymentAtomic.mockResolvedValue({
        record: paidRecord,
        payment: makeSalaryPayment({ hours_paid: '10', amount_fcfa: 50000 }),
      });
      repository.auditSalaryAction.mockResolvedValue(undefined);

      const result = await service.updateSalaryRecordStatus({
        recordId: 'record-1',
        status: 'paid',
        actor,
        hoursToPay: 10,
      });

      expect(result.record.status).toBe('paid');
    });

    it('rejette le doublon (toutes les heures déjà payées)', async () => {
      repository.getSalaryRecordById.mockResolvedValue(
        makeSalaryRecord({ hours_done: '10', hourly_rate: 5000, total_fcfa: 50000 })
      );
      repository.getSalaryPaymentsSummary.mockResolvedValue(makePaymentSummary({ paid_hours: '10' }));
      repository.createVacatairePartialPaymentAtomic.mockRejectedValue(
        new Error('insufficient remaining hours')
      );

      await expect(
        service.updateSalaryRecordStatus({
          recordId: 'record-1',
          status: 'paid',
          actor,
          hoursToPay: 1,
        })
      ).rejects.toMatchObject({ code: 'HOURS_TO_PAY_EXCEEDS_REMAINING', statusCode: 400 });
    });
  });

  // ── getPastUnpaidSalaryAlerts ─────────────────────────────────────────────

  describe('getPastUnpaidSalaryAlerts', () => {
    it('agrège correctement les alertes', async () => {
      repository.listPastUnpaidSalaryAlerts.mockResolvedValue([
        { period_month: '2026-02-01', records_count: '3', total_remaining_fcfa: '90000' },
        { period_month: '2026-03-01', records_count: '2', total_remaining_fcfa: '50000' },
      ]);

      const result = await service.getPastUnpaidSalaryAlerts('2026-04');

      expect(result.count).toBe(5);
      expect(result.totalRemainingFcfa).toBe(140000);
      expect(result.months).toHaveLength(2);
      expect(result.months[0]?.month).toBe('2026-02');
    });
  });
});
