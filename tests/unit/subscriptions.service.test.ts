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
  createParent: vi.fn(),
  createSubscription: vi.fn(),
  createParentStudentLinks: vi.fn(),
  createPayment: vi.fn(),
  getParentById: vi.fn(),
  getLatestSubscription: vi.fn(),
  getSubscriptionStudents: vi.fn(),
  updateSubscriptionStatus: vi.fn(),
  updateParentPassword: vi.fn(),
  getRevenueSummary: vi.fn(),
  listRevenueHistory: vi.fn(),
  upsertCommissionPayment: vi.fn(),
  expireOutdatedSubscriptions: vi.fn(),
  listRenewalAlertsInSevenDays: vi.fn(),
  insertSubscriptionExpiryAlertLog: vi.fn(),
});

describe('subscriptions.service', () => {
  it('canSendNotification retourne feature_disabled si feature inactive', async () => {
    const repository = buildRepositoryMock();
    repository.getTenantIdBySchemaName.mockResolvedValue('tenant-1');
    repository.getSmsFeatureByTenantId.mockResolvedValue({ is_enabled: false, sms_cap_per_student: 60 });

    const service = new SubscriptionsService(repository as never);
    const result = await service.canSendNotification({
      studentId: 'student-1',
      schemaName: 'school_test',
      type: 'sms',
    });

    expect(result).toEqual({ allowed: false, reason: 'feature_disabled' });
  });

  it('canSendNotification retourne no_active_subscription sans lien actif', async () => {
    const repository = buildRepositoryMock();
    repository.getTenantIdBySchemaName.mockResolvedValue('tenant-1');
    repository.getSmsFeatureByTenantId.mockResolvedValue({ is_enabled: true, sms_cap_per_student: 60 });
    repository.getActiveSubscriptionLinkByStudent.mockResolvedValue(null);

    const service = new SubscriptionsService(repository as never);
    const result = await service.canSendNotification({
      studentId: 'student-1',
      schemaName: 'school_test',
      type: 'sms',
    });

    expect(result).toEqual({ allowed: false, reason: 'no_active_subscription' });
  });

  it('canSendNotification retourne subscription_expired si souscription expirée', async () => {
    const repository = buildRepositoryMock();
    repository.getTenantIdBySchemaName.mockResolvedValue('tenant-1');
    repository.getSmsFeatureByTenantId.mockResolvedValue({ is_enabled: true, sms_cap_per_student: 60 });
    repository.getActiveSubscriptionLinkByStudent.mockResolvedValue({
      subscription_id: 'sub-1',
      parent_phone: '2250700000001',
      parent_email: null,
      ends_at: '2000-01-01',
    });

    const service = new SubscriptionsService(repository as never);
    const result = await service.canSendNotification({
      studentId: 'student-1',
      schemaName: 'school_test',
      type: 'sms',
    });

    expect(result).toEqual({ allowed: false, reason: 'subscription_expired' });
  });

  it('canSendNotification retourne allowed=true si actif et cap non atteint', async () => {
    const repository = buildRepositoryMock();
    repository.getTenantIdBySchemaName.mockResolvedValue('tenant-1');
    repository.getSmsFeatureByTenantId.mockResolvedValue({ is_enabled: true, sms_cap_per_student: 60 });
    repository.getActiveSubscriptionLinkByStudent.mockResolvedValue({
      subscription_id: 'sub-1',
      parent_phone: '2250700000001',
      parent_email: null,
      ends_at: '2099-12-31',
    });
    repository.getUsageByStudentMonth.mockResolvedValue({ sms: 12, email: 0 });

    const service = new SubscriptionsService(repository as never);
    const result = await service.canSendNotification({
      studentId: 'student-1',
      schemaName: 'school_test',
      type: 'sms',
    });

    expect(result).toMatchObject({ allowed: true, subscriptionId: 'sub-1' });
  });

  it('canSendNotification retourne cap_reached si cap atteint', async () => {
    const repository = buildRepositoryMock();
    repository.getTenantIdBySchemaName.mockResolvedValue('tenant-1');
    repository.getSmsFeatureByTenantId.mockResolvedValue({ is_enabled: true, sms_cap_per_student: 60 });
    repository.getActiveSubscriptionLinkByStudent.mockResolvedValue({
      subscription_id: 'sub-1',
      parent_phone: '2250700000001',
      parent_email: null,
      ends_at: '2099-12-31',
    });
    repository.getUsageByStudentMonth.mockResolvedValue({ sms: 60, email: 0 });

    const service = new SubscriptionsService(repository as never);
    const result = await service.canSendNotification({
      studentId: 'student-1',
      schemaName: 'school_test',
      type: 'sms',
    });

    expect(result).toEqual({ allowed: false, reason: 'cap_reached' });
  });

  it('createParentSubscription calcule 2 élèves × 1000 × 1 = 2000', async () => {
    const repository = buildRepositoryMock();
    repository.getTenantIdBySchemaName.mockResolvedValue('tenant-1');
    repository.getSmsFeatureByTenantId.mockResolvedValue({
      is_enabled: true,
      sms_unit_price_fcfa: 1000,
      commission_pct: 15,
      sms_cap_per_student: 60,
    });
    repository.getStudentsByIds.mockResolvedValue([{ id: 'student-1' }, { id: 'student-2' }]);
    repository.createParent.mockResolvedValue('parent-1');
    repository.computeStartsAndEnds.mockReturnValue({ startsAt: '2026-04-15', endsAt: '2026-05-15' });
    repository.createSubscription.mockResolvedValue('sub-1');

    const service = new SubscriptionsService(repository as never);
    const result = await service.createParentSubscription({
      schemaName: 'school_test',
      actorUserId: 'user-1',
      payload: {
        full_name: 'Parent Test',
        phone: '2250709990001',
        student_ids: ['student-1', 'student-2'],
        duration_months: 1,
        payment_method: 'cash',
        paid_now: true,
      },
    });

    expect(result.subscription.total_amount_fcfa).toBe(2000);
  });

  it('createParentSubscription calcule 2 élèves × 1000 × 3 = 6000', async () => {
    const repository = buildRepositoryMock();
    repository.getTenantIdBySchemaName.mockResolvedValue('tenant-1');
    repository.getSmsFeatureByTenantId.mockResolvedValue({
      is_enabled: true,
      sms_unit_price_fcfa: 1000,
      commission_pct: 15,
      sms_cap_per_student: 60,
    });
    repository.getStudentsByIds.mockResolvedValue([{ id: 'student-1' }, { id: 'student-2' }]);
    repository.createParent.mockResolvedValue('parent-1');
    repository.computeStartsAndEnds.mockReturnValue({ startsAt: '2026-04-15', endsAt: '2026-07-15' });
    repository.createSubscription.mockResolvedValue('sub-1');

    const service = new SubscriptionsService(repository as never);
    const result = await service.createParentSubscription({
      schemaName: 'school_test',
      actorUserId: 'user-1',
      payload: {
        full_name: 'Parent Test',
        phone: '2250709990001',
        student_ids: ['student-1', 'student-2'],
        duration_months: 3,
        payment_method: 'cash',
        paid_now: true,
      },
    });

    expect(result.subscription.total_amount_fcfa).toBe(6000);
  });

  it('revenueSummary calcule commission due (15% de 4000 = 600)', async () => {
    const repository = buildRepositoryMock();
    repository.getTenantIdBySchemaName.mockResolvedValue('tenant-1');
    repository.getSmsFeatureByTenantId.mockResolvedValue({ commission_pct: 15 });
    repository.getRevenueSummary.mockResolvedValue({
      monthly_revenue_prorated_fcfa: 4000,
      total_collected_fcfa: 4000,
      commission_paid_fcfa: 0,
      subscriptions_count: 2,
      active_subscriptions_count: 2,
    });

    const service = new SubscriptionsService(repository as never);
    const result = await service.revenueSummary('school_test', '2026-04');

    expect(result.commission_due_fcfa).toBe(600);
  });

  it('renewParentSubscription utilise starts_at = ancien ends_at + 1 jour', async () => {
    const repository = buildRepositoryMock();
    repository.getParentById.mockResolvedValue({ id: 'parent-1' });
    repository.getLatestSubscription.mockResolvedValue({ id: 'sub-old', ends_at: '2025-02-15', auto_renew_alert: false });
    repository.getSubscriptionStudents.mockResolvedValue([{ id: 'student-1' }]);
    repository.getTenantIdBySchemaName.mockResolvedValue('tenant-1');
    repository.getSmsFeatureByTenantId.mockResolvedValue({ sms_unit_price_fcfa: 1000, is_enabled: true, sms_cap_per_student: 60 });
    repository.computeRenewalStartsAndEnds.mockReturnValue({ startsAt: '2025-02-16', endsAt: '2025-03-16' });
    repository.createSubscription.mockResolvedValue('sub-new');

    const service = new SubscriptionsService(repository as never);
    const result = await service.renewParentSubscription({
      parentId: 'parent-1',
      actorUserId: 'user-1',
      schemaName: 'school_test',
      payload: { duration_months: 1, payment_method: 'cash', paid_now: true },
    });

    expect(repository.computeRenewalStartsAndEnds).toHaveBeenCalledWith('2025-02-15', 1);
    expect(result.starts_at).toBe('2025-02-16');
    expect(result.ends_at).toBe('2025-03-16');
  });

  it('runDailyMaintenance expire et log les alertes de renouvellement', async () => {
    const repository = buildRepositoryMock();
    repository.expireOutdatedSubscriptions.mockResolvedValue(1);
    repository.listRenewalAlertsInSevenDays.mockResolvedValue([
      { parentPhone: '2250700000001', parentName: 'Parent', endsAt: '2026-05-10' },
    ]);

    const service = new SubscriptionsService(repository as never);
    const result = await service.runDailyMaintenance('school_test');

    expect(result).toEqual({ expired: 1, alerts: 1 });
    expect(repository.insertSubscriptionExpiryAlertLog).toHaveBeenCalledTimes(1);
  });
});
