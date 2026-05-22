import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createSchool: vi.fn(),
  getAdminMetrics: vi.fn(),
  getSchoolDetails: vi.fn(),
  getSchoolUsers: vi.fn(),
  updateSchoolConfig: vi.fn(),
  listSchoolPayments: vi.fn(),
  addManualPayment: vi.fn(),
  sendSchoolPaymentReminder: vi.fn(),
  getSmsDashboard: vi.fn(),
  getSmsPlatformConfig: vi.fn(),
  updateSmsPlatformConfig: vi.fn(),
  listSmsPlatformAudit: vi.fn(),
  listSmsTemplates: vi.fn(),
  upsertSmsTemplate: vi.fn(),
  deleteTenantSmsTemplate: vi.fn(),
  activateSchoolSmsFeature: vi.fn(),
  deactivateSchoolSmsFeature: vi.fn(),
  updateSchoolSmsFeatureConfig: vi.fn(),
  syncSchoolSmsCommission: vi.fn(),
  recordSchoolCommissionReceived: vi.fn(),
  getSchoolSmsFeatureStats: vi.fn(),
  getSmsFeatureGlobalStats: vi.fn(),
  attachPublicDb: vi.fn(),
  releaseTenantDb: vi.fn(),
  authenticateRequest: vi.fn(),
  requireRole: vi.fn(),
}));

vi.mock('../../src/modules/admin/admin.service.js', async () => {
  const actual = await vi.importActual('../../src/modules/admin/admin.service.js');
  return {
    ...actual,
    createSchool: mocks.createSchool,
    getAdminMetrics: mocks.getAdminMetrics,
    getSchoolDetails: mocks.getSchoolDetails,
    getSchoolUsers: mocks.getSchoolUsers,
    updateSchoolConfig: mocks.updateSchoolConfig,
    listSchoolPayments: mocks.listSchoolPayments,
    addManualPayment: mocks.addManualPayment,
    sendSchoolPaymentReminder: mocks.sendSchoolPaymentReminder,
    getSmsDashboard: mocks.getSmsDashboard,
    getSmsPlatformConfig: mocks.getSmsPlatformConfig,
    updateSmsPlatformConfig: mocks.updateSmsPlatformConfig,
    listSmsPlatformAudit: mocks.listSmsPlatformAudit,
    listSmsTemplates: mocks.listSmsTemplates,
    upsertSmsTemplate: mocks.upsertSmsTemplate,
    deleteTenantSmsTemplate: mocks.deleteTenantSmsTemplate,
    activateSchoolSmsFeature: mocks.activateSchoolSmsFeature,
    deactivateSchoolSmsFeature: mocks.deactivateSchoolSmsFeature,
    updateSchoolSmsFeatureConfig: mocks.updateSchoolSmsFeatureConfig,
    syncSchoolSmsCommission: mocks.syncSchoolSmsCommission,
    recordSchoolCommissionReceived: mocks.recordSchoolCommissionReceived,
    getSchoolSmsFeatureStats: mocks.getSchoolSmsFeatureStats,
    getSmsFeatureGlobalStats: mocks.getSmsFeatureGlobalStats,
  };
});

vi.mock('../../src/shared/middleware/tenant.middleware.js', async () => {
  const actual = await vi.importActual('../../src/shared/middleware/tenant.middleware.js');
  return {
    ...actual,
    attachPublicDb: mocks.attachPublicDb,
    releaseTenantDb: mocks.releaseTenantDb,
  };
});

vi.mock('../../src/shared/middleware/auth.middleware.js', async () => {
  const actual = await vi.importActual('../../src/shared/middleware/auth.middleware.js');
  return {
    ...actual,
    authenticateRequest: mocks.authenticateRequest,
    requireRole: mocks.requireRole,
  };
});

vi.mock('../../src/shared/middleware/admin-audit.middleware.js', () => ({
  adminAuditOnSend: async (_request: unknown, _reply: unknown, payload: unknown) => payload,
}));

import adminController from '../../src/modules/admin/admin.controller.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

const buildApp = async () => {
  const app = Fastify();
  await app.register(adminController);
  await app.ready();
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();

  mocks.attachPublicDb.mockImplementation(async (request: { db?: unknown }) => {
    request.db = { execute: vi.fn() };
  });
  mocks.releaseTenantDb.mockResolvedValue(undefined);
  mocks.authenticateRequest.mockImplementation(async (request: { auth?: unknown }) => {
    request.auth = {
      sub: 'admin-user-id',
      role: 'super_admin',
      schemaName: 'school_sainte_marie',
    };
  });
  mocks.requireRole.mockReturnValue(async () => undefined);

  mocks.getSchoolDetails.mockResolvedValue({
    tenantId: TENANT_ID,
    metadata: { name: 'Lycée Test' },
  });
  mocks.getSchoolUsers.mockResolvedValue({
    director: null,
    staff: [],
    teachers: [],
  });
  mocks.updateSchoolConfig.mockResolvedValue(undefined);
  mocks.listSchoolPayments.mockResolvedValue([]);
  mocks.addManualPayment.mockResolvedValue(undefined);
  mocks.sendSchoolPaymentReminder.mockResolvedValue({
    sentAt: '2026-04-23T00:00:00.000Z',
    recipientPhone: '+2250700000000',
  });
  mocks.getSmsDashboard.mockResolvedValue({
    sentThisMonth: 12,
    deliveryRate: 99,
    activeSchools: 1,
    estimatedCostFcfa: 120,
    bySchool: [],
    history: [],
  });
  mocks.getSmsPlatformConfig.mockResolvedValue({
    provider: 'mock',
    hasApiKey: false,
    apiBaseUrl: null,
    apiKeyLast4: null,
    apiKeyUpdatedAt: null,
    senderId: 'EduTrack',
    fallbackSenderId: null,
    defaultCountryCode: '+225',
    alertQuotaThresholdPct: 80,
    alertFailureThresholdCount: 5,
    alertEmail: null,
    smsMaintenanceMode: false,
    smsMaintenanceMessage: 'Service SMS en maintenance',
    updatedAt: '2026-04-23T00:00:00.000Z',
  });
  mocks.updateSmsPlatformConfig.mockResolvedValue(undefined);
  mocks.listSmsPlatformAudit.mockResolvedValue([]);
  mocks.listSmsTemplates.mockResolvedValue([]);
  mocks.upsertSmsTemplate.mockResolvedValue(undefined);
  mocks.deleteTenantSmsTemplate.mockResolvedValue(undefined);
  mocks.activateSchoolSmsFeature.mockResolvedValue({
    is_enabled: true,
    commission_pct: 15,
    activated_at: '2026-04-29T00:00:00.000Z',
  });
  mocks.deactivateSchoolSmsFeature.mockResolvedValue({ is_enabled: false });
  mocks.updateSchoolSmsFeatureConfig.mockResolvedValue({
    is_enabled: true,
    commission_pct: 15,
    sms_cap_per_student: 60,
  });
  mocks.syncSchoolSmsCommission.mockResolvedValue({
    tenant_id: TENANT_ID,
    period_month: '2026-04-01',
    total_subscriptions_fcfa: 2000,
    commission_pct: 15,
    commission_due_fcfa: 300,
    commission_paid_fcfa: 0,
  });
  mocks.recordSchoolCommissionReceived.mockResolvedValue({
    period_month: '2026-04-01',
    commission_due_fcfa: 300,
    commission_paid_fcfa: 100,
    commission_remaining_fcfa: 200,
    overpaid: false,
  });
  mocks.getSchoolSmsFeatureStats.mockResolvedValue({
    config: { is_enabled: true, commission_pct: 15, sms_cap_per_student: 60 },
    current_month: {
      subscriptions_active: 2,
      subscriptions_new: 1,
      total_collected_fcfa: 2000,
      commission_due_fcfa: 300,
      commission_paid_fcfa: 100,
      commission_remaining_fcfa: 200,
    },
    history: [],
    sms_sent_this_month: 20,
  });
  mocks.getSmsFeatureGlobalStats.mockResolvedValue([]);
});

describe('admin V3 routes', () => {
  it('POST /api/v1/admin/schools crée une école complète', async () => {
    mocks.createSchool.mockResolvedValue({
      tenantId: TENANT_ID,
      schoolSchemaName: 'school_test',
      directorCredentials: {
        userId: 'user-1',
        name: 'Directeur Test',
        phone: '2250700000001',
        email: 'directeur@test.ci',
        password: 'deadbeefdeadbeef',
      },
    });

    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/schools',
      payload: {
        name: 'Lycée Test',
        subdomain: 'lycee-test',
        city: 'Abidjan',
        teaching_type: 'secondaire',
        director_name: 'Directeur Test',
        director_phone: '2250700000001',
        director_email: 'directeur@test.ci',
        active_school_year: '09/2025 - 06/2026',
        plan: 'pro',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(mocks.createSchool).toHaveBeenCalledTimes(1);
    expect(response.json().tenantId).toBe(TENANT_ID);
    await app.close();
  });

  it('GET /api/v1/admin/metrics retourne des données réelles agrégées', async () => {
    mocks.getAdminMetrics.mockResolvedValue({
      totalSchools: 1,
      activeSchools: 1,
      mrrTotalFcfa: 120000,
      dauLast7d: [{ date: '2026-04-15', uniqueUsers: 12 }],
      schoolsByPlan: [{ plan: 'pro', count: 1 }],
    });

    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/metrics',
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.getAdminMetrics).toHaveBeenCalledTimes(1);
    expect(response.json().mrrTotalFcfa).toBe(120000);
    await app.close();
  });

  it('GET /api/v1/admin/schools/:tenantId retourne le détail école', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/schools/${TENANT_ID}`,
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.getSchoolDetails).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('GET /api/v1/admin/schools/:tenantId/users retourne les utilisateurs école', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/schools/${TENANT_ID}/users`,
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.getSchoolUsers).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('PATCH /api/v1/admin/schools/:tenantId/config met à jour la configuration école', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/schools/${TENANT_ID}/config`,
      payload: {
        city: 'Abidjan',
        can_edit_sms_template: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
    expect(mocks.updateSchoolConfig).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('GET /api/v1/admin/schools/:tenantId/payments retourne les paiements', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/schools/${TENANT_ID}/payments`,
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.listSchoolPayments).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('POST /api/v1/admin/schools/:tenantId/payments enregistre un paiement manuel', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/schools/${TENANT_ID}/payments`,
      payload: {
        date: '2026-04-23',
        amount_fcfa: 15000,
        provider: 'manual',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ success: true });
    expect(mocks.addManualPayment).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('POST /api/v1/admin/schools/:tenantId/payments/reminder envoie une relance SMS', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/schools/${TENANT_ID}/payments/reminder`,
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.sendSchoolPaymentReminder).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('GET /api/v1/admin/sms/dashboard retourne les métriques SMS', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/sms/dashboard',
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.getSmsDashboard).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('GET /api/v1/admin/sms/platform-config retourne la configuration SMS plateforme', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/sms/platform-config',
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.getSmsPlatformConfig).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('PATCH /api/v1/admin/sms/platform-config met à jour la configuration SMS plateforme', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/sms/platform-config',
      payload: {
        provider: 'mock',
        sender_id: 'EduTrack',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
    expect(mocks.updateSmsPlatformConfig).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("GET /api/v1/admin/sms/platform-audit retourne l'audit SMS", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/sms/platform-audit?limit=10',
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.listSmsPlatformAudit).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('GET /api/v1/admin/sms/templates retourne les templates globaux', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/sms/templates',
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.listSmsTemplates).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('PUT /api/v1/admin/sms/templates/:type enregistre un template global', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/sms/templates/student_absent_parent',
      payload: {
        message_template: 'EduTrack: {studentFirstName} absent(e)',
        variables: ['studentFirstName'],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
    expect(mocks.upsertSmsTemplate).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('GET /api/v1/admin/sms/templates/:tenantId retourne les templates tenant', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/sms/templates/${TENANT_ID}`,
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.listSmsTemplates).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('PUT /api/v1/admin/sms/templates/:tenantId/:type enregistre un template tenant', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/sms/templates/${TENANT_ID}/student_absent_parent`,
      payload: {
        message_template: 'Template école',
        variables: ['studentFirstName'],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
    expect(mocks.upsertSmsTemplate).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('DELETE /api/v1/admin/sms/templates/:tenantId/:type supprime un template tenant', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/sms/templates/${TENANT_ID}/student_absent_parent`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
    expect(mocks.deleteTenantSmsTemplate).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('POST /api/v1/admin/schools/:tenantId/sms-feature/activate active la feature SMS', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/schools/${TENANT_ID}/sms-feature/activate`,
      payload: { commission_pct: 15 },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.activateSchoolSmsFeature).toHaveBeenCalledTimes(1);
    expect(response.json().is_enabled).toBe(true);
    await app.close();
  });

  it('POST /api/v1/admin/schools/:tenantId/sms-feature/deactivate désactive la feature SMS', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/schools/${TENANT_ID}/sms-feature/deactivate`,
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.deactivateSchoolSmsFeature).toHaveBeenCalledTimes(1);
    expect(response.json().is_enabled).toBe(false);
    await app.close();
  });

  it('GET /api/v1/admin/schools/:tenantId/sms-feature/stats retourne les stats SMS', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/schools/${TENANT_ID}/sms-feature/stats`,
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.getSchoolSmsFeatureStats).toHaveBeenCalledTimes(1);
    expect(response.json().config.is_enabled).toBe(true);
    await app.close();
  });

  it('GET /api/v1/admin/sms-feature/global-stats retourne une liste consolidée', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/sms-feature/global-stats',
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.getSmsFeatureGlobalStats).toHaveBeenCalledTimes(1);
    expect(response.json()).toHaveProperty('items');
    await app.close();
  });
});
