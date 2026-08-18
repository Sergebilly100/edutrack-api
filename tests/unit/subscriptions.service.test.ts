import { describe, expect, it, vi } from 'vitest';

import { SubscriptionsService } from '../../src/modules/subscriptions/subscriptions.service.js';

const buildRepositoryMock = () => ({
  getTenantIdBySchemaName: vi.fn(),
  getSmsFeatureByTenantId: vi.fn(),
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
    it('calcule 2 élèves × 1000 × 1 = 2000 et appelle la transaction', async () => {
      const repository = buildRepositoryMock();
      repository.getTenantIdBySchemaName.mockResolvedValue('tenant-1');
      repository.getSmsFeatureByTenantId.mockResolvedValue({ is_enabled: true, sms_unit_price_fcfa: 1000, commission_pct: 15, sms_cap_per_student: 60 });
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
      repository.getSmsFeatureByTenantId.mockResolvedValue({ is_enabled: true, sms_unit_price_fcfa: 1000, commission_pct: 15, sms_cap_per_student: 60 });
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
      repository.getSmsFeatureByTenantId.mockResolvedValue({ is_enabled: true, sms_unit_price_fcfa: 1000, sms_cap_per_student: 60 });
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
  });

  describe('renewParentSubscription', () => {
    it('utilise starts_at = ancien ends_at + 1 jour (abonnement récent)', async () => {
      const repository = buildRepositoryMock();
      repository.getParentById.mockResolvedValue({ id: 'parent-1' });
      repository.getLatestSubscription.mockResolvedValue({ id: 'sub-old', ends_at: '2099-02-15', auto_renew_alert: false });
      repository.getSubscriptionStudents.mockResolvedValue([{ id: 'student-1' }]);
      repository.getTenantIdBySchemaName.mockResolvedValue('tenant-1');
      repository.getSmsFeatureByTenantId.mockResolvedValue({ sms_unit_price_fcfa: 1000, is_enabled: true, sms_cap_per_student: 60 });
      repository.computeRenewalStartsAndEnds.mockReturnValue({ startsAt: '2099-02-16', endsAt: '2099-03-16' });
      repository.renewSubscriptionTx.mockResolvedValue({ subscriptionId: 'sub-new' });

      const service = new SubscriptionsService(repository as never);
      const result = await service.renewParentSubscription({
        parentId: 'parent-1', actorUserId: 'user-1', schemaName: 'school_test',
        payload: { duration_months: 1, payment_method: 'cash', paid_now: true },
      });

      expect(repository.computeRenewalStartsAndEnds).toHaveBeenCalledWith('2099-02-15', 1);
      expect(result.starts_at).toBe('2099-02-16');
    });

    it('starts_at = today si abonnement expiré depuis longtemps', async () => {
      const repository = buildRepositoryMock();
      repository.getParentById.mockResolvedValue({ id: 'parent-1' });
      repository.getLatestSubscription.mockResolvedValue({ id: 'sub-old', ends_at: '2020-01-01', auto_renew_alert: false });
      repository.getSubscriptionStudents.mockResolvedValue([{ id: 'student-1' }]);
      repository.getTenantIdBySchemaName.mockResolvedValue('tenant-1');
      repository.getSmsFeatureByTenantId.mockResolvedValue({ sms_unit_price_fcfa: 1000, is_enabled: true, sms_cap_per_student: 60 });
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
        { parentPhone: '2250700000001', parentName: 'Parent', endsAt: '2026-05-10' },
        { parentPhone: '2250700000002', parentName: 'Parent 2', endsAt: '2026-05-10' },
      ]);

      const service = new SubscriptionsService(repository as never);
      const result = await service.runDailyMaintenance();

      expect(result).toEqual({ expired: 3, alerts: 2 });
      expect(repository.insertSubscriptionExpiryAlertLog).toHaveBeenCalledTimes(2);
    });

    it('retourne 0 alerts si aucune expiration imminente', async () => {
      const repository = buildRepositoryMock();
      repository.expireOutdatedSubscriptions.mockResolvedValue(0);
      repository.listRenewalAlertsInSevenDays.mockResolvedValue([]);

      const service = new SubscriptionsService(repository as never);
      const result = await service.runDailyMaintenance();

      expect(result).toEqual({ expired: 0, alerts: 0 });
      expect(repository.insertSubscriptionExpiryAlertLog).not.toHaveBeenCalled();
    });
  });
});
