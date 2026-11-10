import { describe, expect, it, vi } from 'vitest';

import { SubscriptionsService } from '../../src/modules/subscriptions/subscriptions.service.js';

const buildRepositoryMock = () => ({
  getTenantIdBySchemaName: vi.fn(),
  getSmsFeatureByTenantId: vi.fn(),
  getEnrollmentParentContext: vi.fn(),
  updateParentAlertSettingsByTenantId: vi.fn(),
  getActiveSubscriptionLinkByStudent: vi.fn(),
  getUsageByStudentMonth: vi.fn(),
  computeStartsAndEnds: vi.fn(),
  computeRenewalStartsAndEnds: vi.fn(),
  getStudentsByIds: vi.fn(),
  findParentByPhone: vi.fn(),
  createParentWithSubscriptionTx: vi.fn(),
  renewSubscriptionTx: vi.fn(),
  createParent: vi.fn(),
  createSubscription: vi.fn(),
  createParentStudentLinks: vi.fn(),
  createPayment: vi.fn(),
  getParentById: vi.fn(),
  getLatestSubscription: vi.fn(),
  getSubscriptionStudents: vi.fn(),
  getSubscriptionById: vi.fn(),
  updateSubscriptionStatus: vi.fn(),
  auditSubscriptionCancellation: vi.fn(),
  updateParentPassword: vi.fn(),
  getRevenueSummary: vi.fn(),
  listRevenueHistory: vi.fn(),
  upsertCommissionPayment: vi.fn(),
  expireOutdatedSubscriptions: vi.fn(),
  listRenewalAlertsInSevenDays: vi.fn(),
  insertSubscriptionExpiryAlertLog: vi.fn(),
  resolveActorUserId: vi.fn().mockResolvedValue('resolved-actor-1'),
  // Année active qui se termine très loin dans le futur : la règle « fin d'année » n'interfère pas avec les autres cas.
  getActiveSchoolYearWindow: vi.fn().mockResolvedValue({ id: 'year-1', label: '2099-2100', endDate: '2100-12-31' }),
  listEnrolledParents: vi.fn(),
});

describe('subscriptions.service', () => {
  describe('canSendNotification', () => {
    it('retourne feature_disabled si feature inactive', async () => {
      const repository = buildRepositoryMock();
      repository.getTenantIdBySchemaName.mockResolvedValue('tenant-1');
      repository.getSmsFeatureByTenantId.mockResolvedValue({ is_enabled: false, sms_cap_per_student: 60 });

      const service = new SubscriptionsService(repository as never);
      const result = await service.canSendNotification({ studentId: 'student-1', schemaName: 'school_test', type: 'sms' });

      expect(result).toEqual({ allowed: false, reason: 'feature_disabled' });
    });

    it('retourne feature_disabled si tenant introuvable', async () => {
      const repository = buildRepositoryMock();
      repository.getTenantIdBySchemaName.mockResolvedValue(null);

      const service = new SubscriptionsService(repository as never);
      const result = await service.canSendNotification({ studentId: 'student-1', schemaName: 'school_test', type: 'sms' });

      expect(result).toEqual({ allowed: false, reason: 'feature_disabled' });
    });

    it('ne fait pas de requête tenant si tenantId fourni directement', async () => {
      const repository = buildRepositoryMock();
      repository.getSmsFeatureByTenantId.mockResolvedValue({ is_enabled: false, sms_cap_per_student: 60 });

      const service = new SubscriptionsService(repository as never);
      const result = await service.canSendNotification({
        studentId: 'student-1',
        tenantId: 'tenant-direct',
        schemaName: 'school_test',
        type: 'sms',
      });

      expect(repository.getTenantIdBySchemaName).not.toHaveBeenCalled();
      expect(repository.getSmsFeatureByTenantId).toHaveBeenCalledWith('tenant-direct');
      expect(result).toEqual({ allowed: false, reason: 'feature_disabled' });
    });

    it('retourne no_active_subscription sans lien actif', async () => {
      const repository = buildRepositoryMock();
      repository.getTenantIdBySchemaName.mockResolvedValue('tenant-1');
      repository.getSmsFeatureByTenantId.mockResolvedValue({ is_enabled: true, sms_cap_per_student: 60 });
      repository.getActiveSubscriptionLinkByStudent.mockResolvedValue(null);

      const service = new SubscriptionsService(repository as never);
      const result = await service.canSendNotification({ studentId: 'student-1', schemaName: 'school_test', type: 'sms' });

      expect(result).toEqual({ allowed: false, reason: 'no_active_subscription' });
    });

    it('retourne subscription_expired si souscription expirée', async () => {
      const repository = buildRepositoryMock();
      repository.getTenantIdBySchemaName.mockResolvedValue('tenant-1');
      repository.getSmsFeatureByTenantId.mockResolvedValue({ is_enabled: true, sms_cap_per_student: 60 });
      repository.getActiveSubscriptionLinkByStudent.mockResolvedValue({
        subscription_id: 'sub-1', parent_phone: '2250700000001', parent_email: null, ends_at: '2000-01-01',
      });

      const service = new SubscriptionsService(repository as never);
      const result = await service.canSendNotification({ studentId: 'student-1', schemaName: 'school_test', type: 'sms' });

      expect(result).toEqual({ allowed: false, reason: 'subscription_expired' });
    });

    it('retourne allowed=true si actif et cap non atteint', async () => {
      const repository = buildRepositoryMock();
      repository.getTenantIdBySchemaName.mockResolvedValue('tenant-1');
      repository.getSmsFeatureByTenantId.mockResolvedValue({ is_enabled: true, sms_cap_per_student: 60 });
      repository.getActiveSubscriptionLinkByStudent.mockResolvedValue({
        subscription_id: 'sub-1', parent_phone: '2250700000001', parent_email: null, ends_at: '2099-12-31',
      });
      repository.getUsageByStudentMonth.mockResolvedValue({ sms: 12, email: 0 });

      const service = new SubscriptionsService(repository as never);
      const result = await service.canSendNotification({ studentId: 'student-1', schemaName: 'school_test', type: 'sms' });

      expect(result).toMatchObject({ allowed: true, subscriptionId: 'sub-1' });
    });

    it('retourne cap_reached si cap atteint', async () => {
      const repository = buildRepositoryMock();
      repository.getTenantIdBySchemaName.mockResolvedValue('tenant-1');
      repository.getSmsFeatureByTenantId.mockResolvedValue({ is_enabled: true, sms_cap_per_student: 60 });
      repository.getActiveSubscriptionLinkByStudent.mockResolvedValue({
        subscription_id: 'sub-1', parent_phone: '2250700000001', parent_email: null, ends_at: '2099-12-31',
      });
      repository.getUsageByStudentMonth.mockResolvedValue({ sms: 60, email: 0 });

      const service = new SubscriptionsService(repository as never);
      const result = await service.canSendNotification({ studentId: 'student-1', schemaName: 'school_test', type: 'sms' });

      expect(result).toEqual({ allowed: false, reason: 'cap_reached' });
    });
  });

  describe('createParentSubscription', () => {
    it('refuse d’activer une souscription avant encaissement', async () => {
      const repository = buildRepositoryMock();
      const service = new SubscriptionsService(repository as never);

      await expect(service.createParentSubscription({
        schemaName: 'school_test',
        actorUserId: 'user-1',
        payload: {
          full_name: 'P',
          phone: '2250709990001',
          student_ids: ['s1'],
          duration_months: 1,
          payment_method: 'cash',
          paid_now: false,
        },
      })).rejects.toMatchObject({ code: 'SUBSCRIPTION_PAYMENT_REQUIRED' });
      expect(repository.getTenantIdBySchemaName).not.toHaveBeenCalled();
    });

    it('calcule 2 élèves × 1000 × 1 = 2000 et appelle la transaction', async () => {
      const repository = buildRepositoryMock();
      repository.getTenantIdBySchemaName.mockResolvedValue('tenant-1');
      repository.getSmsFeatureByTenantId.mockResolvedValue({ is_enabled: true, monetize_parent_alerts: true, sms_unit_price_fcfa: 1000, commission_pct: 15, sms_cap_per_student: 60 });
      repository.getStudentsByIds.mockResolvedValue([{ id: 'student-1' }, { id: 'student-2' }]);
      repository.findParentByPhone.mockResolvedValue(null);
      repository.computeStartsAndEnds.mockReturnValue({ startsAt: '2026-04-15', endsAt: '2026-05-15' });
      repository.createParentWithSubscriptionTx.mockResolvedValue({ parentId: 'parent-1', subscriptionId: 'sub-1', parentCreated: true });

      const service = new SubscriptionsService(repository as never);
      const result = await service.createParentSubscription({
        schemaName: 'school_test',
        actorUserId: 'user-1',
        payload: { full_name: 'Parent Test', phone: '2250709990001', student_ids: ['student-1', 'student-2'], duration_months: 1, payment_method: 'cash', paid_now: true },
      });

      expect(result.subscription.total_amount_fcfa).toBe(2000);
      expect(repository.createParentWithSubscriptionTx).toHaveBeenCalledWith(
        expect.objectContaining({ totalAmountFcfa: 2000, paidNow: true })
      );
    });

    it('calcule 2 élèves × 1000 × 3 = 6000', async () => {
      const repository = buildRepositoryMock();
      repository.getTenantIdBySchemaName.mockResolvedValue('tenant-1');
      repository.getSmsFeatureByTenantId.mockResolvedValue({ is_enabled: true, monetize_parent_alerts: true, sms_unit_price_fcfa: 1000, commission_pct: 15, sms_cap_per_student: 60 });
      repository.getStudentsByIds.mockResolvedValue([{ id: 'student-1' }, { id: 'student-2' }]);
      repository.findParentByPhone.mockResolvedValue(null);
      repository.computeStartsAndEnds.mockReturnValue({ startsAt: '2026-04-15', endsAt: '2026-07-15' });
      repository.createParentWithSubscriptionTx.mockResolvedValue({ parentId: 'parent-1', subscriptionId: 'sub-1', parentCreated: true });

      const service = new SubscriptionsService(repository as never);
      const result = await service.createParentSubscription({
        schemaName: 'school_test',
        actorUserId: 'user-1',
        payload: { full_name: 'Parent Test', phone: '2250709990001', student_ids: ['student-1', 'student-2'], duration_months: 3, payment_method: 'cash', paid_now: true },
      });

      expect(result.subscription.total_amount_fcfa).toBe(6000);
    });

    it('ajoute un abonnement au parent existant sans recréer ses accès', async () => {
      const repository = buildRepositoryMock();
      repository.getTenantIdBySchemaName.mockResolvedValue('tenant-1');
      repository.getSmsFeatureByTenantId.mockResolvedValue({ is_enabled: true, monetize_parent_alerts: true, sms_unit_price_fcfa: 1000, sms_cap_per_student: 60 });
      repository.getStudentsByIds.mockResolvedValue([{ id: 'student-1' }]);
      repository.findParentByPhone.mockResolvedValue({ id: 'existing-parent' });
      repository.computeStartsAndEnds.mockReturnValue({ startsAt: '2026-04-15', endsAt: '2026-05-15' });
      repository.createParentWithSubscriptionTx.mockResolvedValue({
        parentId: 'existing-parent',
        subscriptionId: 'sub-1',
        parentCreated: false,
      });

      const service = new SubscriptionsService(repository as never);
      const result = await service.createParentSubscription({
        schemaName: 'school_test',
        actorUserId: 'user-1',
        payload: { full_name: 'Dup Parent', phone: '2250709990001', student_ids: ['student-1'], duration_months: 1, payment_method: 'cash', paid_now: true },
      });

      expect(result.parent.id).toBe('existing-parent');
      expect(result.credentials).toBeNull();
      expect(result.subscription.id).toBe('sub-1');
    });

    it('lève SMS_FEATURE_NOT_ENABLED si feature désactivée', async () => {
      const repository = buildRepositoryMock();
      repository.getTenantIdBySchemaName.mockResolvedValue('tenant-1');
      repository.getSmsFeatureByTenantId.mockResolvedValue({ is_enabled: false, sms_unit_price_fcfa: 1000, sms_cap_per_student: 60 });

      const service = new SubscriptionsService(repository as never);
      await expect(
        service.createParentSubscription({
          schemaName: 'school_test',
          actorUserId: 'user-1',
          payload: { full_name: 'P', phone: '2250709990001', student_ids: ['s1'], duration_months: 1, payment_method: 'cash', paid_now: true },
        })
      ).rejects.toMatchObject({ code: 'SMS_FEATURE_NOT_ENABLED' });
    });

    it('refuse la souscription payante lorsque la monétisation est désactivée', async () => {
      const repository = buildRepositoryMock();
      repository.getTenantIdBySchemaName.mockResolvedValue('tenant-1');
      repository.getSmsFeatureByTenantId.mockResolvedValue({
        is_enabled: true,
        monetize_parent_alerts: false,
        sms_unit_price_fcfa: 1000,
      });

      const service = new SubscriptionsService(repository as never);
      await expect(service.createParentSubscription({
        schemaName: 'school_test',
        actorUserId: 'user-1',
        payload: {
          full_name: 'P',
          phone: '2250709990001',
          student_ids: ['s1'],
          duration_months: 1,
          payment_method: 'cash',
          paid_now: true,
        },
      })).rejects.toMatchObject({ code: 'SMS_FEATURE_NOT_ENABLED' });
    });
  });

  describe('renewParentSubscription', () => {
    it('renouvelle une souscription expirée à partir du jour courant', async () => {
      const repository = buildRepositoryMock();
      repository.getParentById.mockResolvedValue({ id: 'parent-1' });
      repository.getLatestSubscription.mockResolvedValue({ id: 'sub-old', status: 'expired', ends_at: '2020-02-15', auto_renew_alert: false });
      repository.getSubscriptionStudents.mockResolvedValue([{ id: 'student-1' }]);
      repository.getTenantIdBySchemaName.mockResolvedValue('tenant-1');
      repository.getSmsFeatureByTenantId.mockResolvedValue({ sms_unit_price_fcfa: 1000, is_enabled: true, monetize_parent_alerts: true, sms_cap_per_student: 60 });
      const today = new Date().toISOString().slice(0, 10);
      repository.computeRenewalStartsAndEnds.mockReturnValue({ startsAt: today, endsAt: '2026-12-01' });
      repository.renewSubscriptionTx.mockResolvedValue({ subscriptionId: 'sub-new' });

      const service = new SubscriptionsService(repository as never);
      const result = await service.renewParentSubscription({
        parentId: 'parent-1', actorUserId: 'user-1', schemaName: 'school_test',
        payload: { duration_months: 1, payment_method: 'cash', paid_now: true },
      });

      expect(repository.computeRenewalStartsAndEnds).toHaveBeenCalledWith('2020-02-15', 1);
      expect(result.starts_at).toBe(today);
    });

    it('starts_at = today si abonnement expiré depuis longtemps', async () => {
      const repository = buildRepositoryMock();
      repository.getParentById.mockResolvedValue({ id: 'parent-1' });
      repository.getLatestSubscription.mockResolvedValue({ id: 'sub-old', status: 'expired', ends_at: '2020-01-01', auto_renew_alert: false });
      repository.getSubscriptionStudents.mockResolvedValue([{ id: 'student-1' }]);
      repository.getTenantIdBySchemaName.mockResolvedValue('tenant-1');
      repository.getSmsFeatureByTenantId.mockResolvedValue({ sms_unit_price_fcfa: 1000, is_enabled: true, monetize_parent_alerts: true, sms_cap_per_student: 60 });
      const today = new Date().toISOString().slice(0, 10);
      repository.computeRenewalStartsAndEnds.mockReturnValue({ startsAt: today, endsAt: '2026-12-01' });
      repository.renewSubscriptionTx.mockResolvedValue({ subscriptionId: 'sub-new' });

      const service = new SubscriptionsService(repository as never);
      const result = await service.renewParentSubscription({
        parentId: 'parent-1', actorUserId: 'user-1', schemaName: 'school_test',
        payload: { duration_months: 1, payment_method: 'cash', paid_now: true },
      });

      expect(result.starts_at).toBe(today);
    });

    it('refuse le renouvellement avant expiration', async () => {
      const repository = buildRepositoryMock();
      repository.getParentById.mockResolvedValue({ id: 'parent-1' });
      repository.getLatestSubscription.mockResolvedValue({ id: 'sub-active', status: 'active', ends_at: '2099-02-15' });
      const service = new SubscriptionsService(repository as never);

      await expect(service.renewParentSubscription({
        parentId: 'parent-1', actorUserId: 'user-1', schemaName: 'school_test',
        payload: { duration_months: 1, payment_method: 'cash', paid_now: true },
      })).rejects.toMatchObject({ code: 'SUBSCRIPTION_RENEWAL_NOT_ELIGIBLE' });
      expect(repository.renewSubscriptionTx).not.toHaveBeenCalled();
    });
  });

  describe('cancelSubscription', () => {
    const recentCreatedAt = new Date().toISOString();
    const oldCreatedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const baseInput = {
      subscriptionId: 'sub-1',
      parentId: 'parent-1',
      actorUserId: 'actor-1',
      actorRole: 'staff',
      schemaName: 'school_test',
      reason: "Erreur de saisie",
    };

    it('lève SUBSCRIPTION_NOT_FOUND si abonnement inexistant', async () => {
      const repository = buildRepositoryMock();
      repository.getSubscriptionById.mockResolvedValue(null);

      const service = new SubscriptionsService(repository as never);
      await expect(
        service.cancelSubscription({ ...baseInput, subscriptionId: 'unknown-sub-id' })
      ).rejects.toMatchObject({ code: 'SUBSCRIPTION_NOT_FOUND' });
    });

    it('lève SUBSCRIPTION_OWNERSHIP_MISMATCH si parentId ne correspond pas', async () => {
      const repository = buildRepositoryMock();
      repository.getSubscriptionById.mockResolvedValue({
        id: 'sub-1', parent_id: 'other-parent', status: 'active',
        created_at: recentCreatedAt, total_amount_fcfa: 4000,
      });

      const service = new SubscriptionsService(repository as never);
      await expect(
        service.cancelSubscription({ ...baseInput, parentId: 'wrong-parent' })
      ).rejects.toMatchObject({ code: 'SUBSCRIPTION_OWNERSHIP_MISMATCH' });
    });

    it('lève SUBSCRIPTION_ALREADY_CANCELLED si déjà annulée', async () => {
      const repository = buildRepositoryMock();
      repository.getSubscriptionById.mockResolvedValue({
        id: 'sub-1', parent_id: 'parent-1', status: 'cancelled',
        created_at: recentCreatedAt, total_amount_fcfa: 4000,
      });

      const service = new SubscriptionsService(repository as never);
      await expect(
        service.cancelSubscription(baseInput)
      ).rejects.toMatchObject({ code: 'SUBSCRIPTION_ALREADY_CANCELLED' });
    });

    it('lève CANCELLATION_WINDOW_CLOSED au-delà de 7 jours', async () => {
      const repository = buildRepositoryMock();
      repository.getSubscriptionById.mockResolvedValue({
        id: 'sub-1', parent_id: 'parent-1', status: 'active',
        created_at: oldCreatedAt, total_amount_fcfa: 4000,
      });

      const service = new SubscriptionsService(repository as never);
      await expect(
        service.cancelSubscription(baseInput)
      ).rejects.toMatchObject({ code: 'CANCELLATION_WINDOW_CLOSED', statusCode: 409 });
      expect(repository.updateSubscriptionStatus).not.toHaveBeenCalled();
    });

    it('annule + audite dans la fenêtre de 7 jours', async () => {
      const repository = buildRepositoryMock();
      repository.getSubscriptionById.mockResolvedValue({
        id: 'sub-1', parent_id: 'parent-1', status: 'active',
        created_at: recentCreatedAt, total_amount_fcfa: 4000,
      });
      repository.updateSubscriptionStatus.mockResolvedValue(undefined);
      repository.auditSubscriptionCancellation.mockResolvedValue(undefined);

      const service = new SubscriptionsService(repository as never);
      await service.cancelSubscription(baseInput);

      expect(repository.updateSubscriptionStatus).toHaveBeenCalledWith('sub-1', 'cancelled', 'resolved-actor-1');
      expect(repository.auditSubscriptionCancellation).toHaveBeenCalledWith(
        expect.objectContaining({
          subscriptionId: 'sub-1',
          reason: 'Erreur de saisie',
          refundedAmountFcfa: 4000,
          withinWindow: true,
        })
      );
    });
  });

  describe('revenueSummary', () => {
    it('calcule commission due (15% de 4000 = 600)', async () => {
      const repository = buildRepositoryMock();
      repository.getTenantIdBySchemaName.mockResolvedValue('tenant-1');
      repository.getSmsFeatureByTenantId.mockResolvedValue({ commission_pct: 15 });
      repository.getRevenueSummary.mockResolvedValue({
        monthly_revenue_prorated_fcfa: 4000, total_collected_fcfa: 4000,
        commission_due_fcfa: 600,
        commission_paid_fcfa: 0, subscriptions_count: 2, active_subscriptions_count: 2,
        subscriptions_active_count: 2, subscriptions_new_this_month: 0,
      });

      const service = new SubscriptionsService(repository as never);
      const result = await service.revenueSummary('school_test', '2026-04');

      expect(result.commission_due_fcfa).toBe(600);
    });

    it('commission_remaining_fcfa = 0 si tout versé', async () => {
      const repository = buildRepositoryMock();
      repository.getTenantIdBySchemaName.mockResolvedValue('tenant-1');
      repository.getSmsFeatureByTenantId.mockResolvedValue({ commission_pct: 15 });
      repository.getRevenueSummary.mockResolvedValue({
        monthly_revenue_prorated_fcfa: 4000, total_collected_fcfa: 4000,
        commission_due_fcfa: 600,
        commission_paid_fcfa: 600, subscriptions_active_count: 2, subscriptions_new_this_month: 0,
      });

      const service = new SubscriptionsService(repository as never);
      const result = await service.revenueSummary('school_test', '2026-04');

      expect(result.commission_remaining_fcfa).toBe(0);
    });
  });

  describe('runDailyMaintenance', () => {
    it('expire les abonnements et log les alertes de renouvellement', async () => {
      const repository = buildRepositoryMock();
      repository.expireOutdatedSubscriptions.mockResolvedValue(3);
      repository.listRenewalAlertsInSevenDays.mockResolvedValue([
        { subscriptionId: 'sub-1', studentName: 'Awa', parentPhone: '2250700000001', parentName: 'Parent', endsAt: '2026-05-10' },
        { subscriptionId: 'sub-2', studentName: 'Koffi', parentPhone: '2250700000002', parentName: 'Parent 2', endsAt: '2026-05-10' },
      ]);

      const service = new SubscriptionsService(repository as never);
      const result = await service.runDailyMaintenance();

      expect(result).toMatchObject({ expired: 3, alerts: 2, reminders: expect.any(Array) });
      expect(repository.insertSubscriptionExpiryAlertLog).toHaveBeenCalledTimes(2);
    });

    it('retourne 0 alerts si aucune expiration imminente', async () => {
      const repository = buildRepositoryMock();
      repository.expireOutdatedSubscriptions.mockResolvedValue(0);
      repository.listRenewalAlertsInSevenDays.mockResolvedValue([]);

      const service = new SubscriptionsService(repository as never);
      const result = await service.runDailyMaintenance();

      expect(result).toMatchObject({ expired: 0, alerts: 0, reminders: [] });
      expect(repository.insertSubscriptionExpiryAlertLog).not.toHaveBeenCalled();
    });

    describe('getEnrollmentAlertRequirement', () => {
      it('requires payment for the configured period only when the paid service is active', async () => {
        const repository = buildRepositoryMock();
        repository.getTenantIdBySchemaName.mockResolvedValue('tenant-1');
        repository.getSmsFeatureByTenantId.mockResolvedValue({
          is_enabled: true,
          monetize_parent_alerts: true,
          mandatory_at_enrollment: true,
          imposed_duration_months: 3,
          sms_unit_price_fcfa: 2000,
          commission_pct: 12,
          show_on_school_receipt: true,
        });
        repository.getEnrollmentParentContext.mockResolvedValue({
          student_id: 'student-1',
          student_name: 'Awa Koné',
          parent_id: 'parent-1',
          parent_name: 'Mariam Koné',
          parent_phone: '2250700000001',
          parent_email: null,
        });

        const result = await new SubscriptionsService(repository as never)
          .getEnrollmentAlertRequirement('school_test', 'student-1');

        expect(result).toMatchObject({
          studentId: 'student-1',
          required: true,
          monthlyPriceFcfa: 2000,
          durationMonths: 3,
          amountFcfa: 6000,
          platformSharePct: 12,
          parentContactMissing: false,
        });
      });

      it('does not create an automatic requirement when the paid service is disabled', async () => {
        const repository = buildRepositoryMock();
        repository.getTenantIdBySchemaName.mockResolvedValue('tenant-1');
        repository.getSmsFeatureByTenantId.mockResolvedValue({
          is_enabled: false,
          monetize_parent_alerts: true,
          mandatory_at_enrollment: true,
          imposed_duration_months: 3,
        });

        const result = await new SubscriptionsService(repository as never)
          .getEnrollmentAlertRequirement('school_test', 'student-1');

        expect(result).toMatchObject({ required: false, amountFcfa: 0, parentContactMissing: false });
        expect(repository.getEnrollmentParentContext).not.toHaveBeenCalled();
      });
    });
  });

  describe('règle fin d’année', () => {
    const payload = { full_name: 'Awa Koné', phone: '2250700000001', student_ids: ['s1'], duration_months: 1, payment_method: 'cash' as const, paid_now: true };

    it('refuse une création quand l’année scolaire est terminée, sans rien écrire', async () => {
      const repository = buildRepositoryMock();
      repository.getActiveSchoolYearWindow.mockResolvedValue({ id: 'y', label: '2024-2025', endDate: '2025-06-30' });
      const service = new SubscriptionsService(repository as never);
      await expect(service.createParentSubscription({ schemaName: 'school_test', actorUserId: 'u1', payload }))
        .rejects.toMatchObject({ code: 'SCHOOL_YEAR_ENDED', statusCode: 409 });
      expect(repository.createParentWithSubscriptionTx).not.toHaveBeenCalled();
    });

    it('refuse un renouvellement après la fin de l’année', async () => {
      const repository = buildRepositoryMock();
      repository.getActiveSchoolYearWindow.mockResolvedValue({ id: 'y', label: '2024-2025', endDate: '2025-06-30' });
      const service = new SubscriptionsService(repository as never);
      await expect(service.renewParentSubscription({ parentId: 'p1', actorUserId: 'u1', schemaName: 'school_test', payload: { duration_months: 1, payment_method: 'cash', paid_now: true } }))
        .rejects.toMatchObject({ code: 'SCHOOL_YEAR_ENDED' });
      expect(repository.renewSubscriptionTx).not.toHaveBeenCalled();
    });

    it('refuse une durée qui dépasse les mois restants de l’année', async () => {
      const repository = buildRepositoryMock();
      const now = new Date();
      const endDate = `${now.getUTCFullYear() + 1}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-28`; // 13 mois restants au plus ; on en demande 120
      repository.getActiveSchoolYearWindow.mockResolvedValue({ id: 'y', label: 'courante', endDate });
      const service = new SubscriptionsService(repository as never);
      await expect(service.createParentSubscription({ schemaName: 'school_test', actorUserId: 'u1', payload: { ...payload, duration_months: 120 } }))
        .rejects.toMatchObject({ code: 'DURATION_EXCEEDS_SCHOOL_YEAR', statusCode: 422 });
    });

    it('expose la disponibilité (année terminée)', async () => {
      const repository = buildRepositoryMock();
      repository.getActiveSchoolYearWindow.mockResolvedValue({ id: 'y', label: '2024-2025', endDate: '2025-06-30' });
      const service = new SubscriptionsService(repository as never);
      await expect(service.getAvailability()).resolves.toMatchObject({ canSubscribe: false, reason: 'SCHOOL_YEAR_ENDED' });
    });
  });

  describe('parents des élèves inscrits', () => {
    it('ajoute le statut d’abonnement et préfixe le téléphone', async () => {
      const repository = buildRepositoryMock();
      repository.listEnrolledParents.mockResolvedValue({ total: 2, rows: [
        { phone_key: '0700000001', parent_name: 'Koné Awa', parent_email: null, students: [{ id: 's1', full_name: 'A', class_name: '6e A', matricule: 'M1' }, { id: 's2', full_name: 'B', class_name: '4e B', matricule: null }], parent_id: null, subscription_id: null, subscription_status: null, subscription_ends_at: null },
        { phone_key: '0700000002', parent_name: 'Yao', parent_email: null, students: [], parent_id: 'p2', subscription_id: 'sub2', subscription_status: 'active', subscription_ends_at: '2000-01-01' },
      ] });
      const service = new SubscriptionsService(repository as never);
      const result = await service.listEnrolledParents({ page: 1, limit: 20 });
      expect(result.data[0]).toMatchObject({ phone: '2250700000001', subscription: null });
      expect(result.data[0].students).toHaveLength(2);
      // « active » mais date dépassée → expiré
      expect(result.data[1].subscription).toMatchObject({ id: 'sub2', status: 'expired' });
      expect(result.pagination.total).toBe(2);
    });
  });
});
