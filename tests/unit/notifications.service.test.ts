import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  dbExecute: vi.fn(),
  withTenantSchema: vi.fn(),
}));

vi.mock('../../src/shared/database/db.js', () => ({
  db: { execute: dbMocks.dbExecute },
  withTenantSchema: dbMocks.withTenantSchema,
}));

import { SMS_MAX_LENGTH } from '../../src/modules/notifications/notifications.sms.js';
import { NotificationsService } from '../../src/modules/notifications/notifications.service.js';
import { SubscriptionsRepository } from '../../src/modules/subscriptions/subscriptions.repository.js';
import type {
  StudentAbsentPayload,
  SubscriptionExpiredPayload,
  TeacherLatePayload,
  TeacherQrAlertPayload,
} from '../../src/shared/events/events.types.js';

// ---------- helpers de mock ----------

const makeRepository = () => ({
  getLateAlertContext: vi.fn(),
  getQrAlertContext: vi.fn(),
  getQrInvalidAlertContext: vi.fn(),
  insertNotificationLog: vi.fn(),
  updateNotificationLogStatus: vi.fn(),
  markQrAlertSent: vi.fn(),
  getTeacherDailySummaryContext: vi.fn(),
});

const makeSmsQueue = () => ({
  add: vi.fn().mockResolvedValue({ id: 'job-1' }),
});

const makeWithTenantSchema = (tenantDb: object) =>
  vi.fn(async (_schemaName: string, callback: (db: object) => Promise<void>) => callback(tenantDb));

// sms_feature retournée par getSmsFeatureByTenantId
const makeEnabledFeature = (opts: { monetize?: boolean; smsCap?: number } = {}) => ({
  tenant_id: 'tenant-1',
  is_enabled: true,
  monetize_parent_alerts: opts.monetize ?? false,
  sms_cap_per_student: opts.smsCap ?? 10,
  commission_pct: 15,
  sms_unit_price_fcfa: 2000,
  use_real_hours: false,
  geo_check_enabled: false,
  checkout_tolerance_minutes: 5,
});

// contact parent retourné par listParentAlertContactsByStudent
const makeActiveContact = (overrides: Partial<{
  parent_id: string | null;
  subscription_id: string | null;
  parent_phone: string;
  parent_email: string | null;
  ends_at: string | null;
  subscription_status: string | null;
}> = {}) => ({
  parent_id: 'parent-1',
  subscription_id: 'sub-1',
  parent_phone: '2250700000001',
  parent_email: null,
  ends_at: '2099-12-31',
  subscription_status: 'active',
  ...overrides,
});

// ---------- fixtures de base ----------

const repository = makeRepository();
const smsQueue = makeSmsQueue();
const tenantDb = { execute: vi.fn() };
const withTenantSchema = makeWithTenantSchema(tenantDb);

const eventBusHandlers: Record<string, ((payload: unknown) => void) | undefined> = {};

const eventBus = {
  on: vi.fn((event: string, handler: (payload: unknown) => void) => {
    eventBusHandlers[event] = handler;
  }),
  off: vi.fn((event: string) => {
    delete eventBusHandlers[event];
  }),
};

const ALL_EVENTS = [
  'teacher.late',
  'teacher.qr_alert',
  'teacher.qr_invalid',
  'teacher.attendance_rejected',
  'teacher.attendance_approved',
  'teacher.end_scan_action',
  'teacher.sanction_cancelled',
  'teacher.end_scan_warning',
  'student.absent',
  'subscription.expired',
  'subscription.revenue_payout',
];

const baseContext = {
  teacherName: 'Kouassi Awa',
  subject: 'Mathématiques',
  className: '3ème A',
  slotLabel: '07h30-09h00',
  directorPhone: '2250700000001',
};

const baseLatePayload: TeacherLatePayload = {
  tenantId: 'tenant-1',
  schemaName: 'school_sainte_marie',
  teacherId: 'teacher-1',
  scheduleId: 'schedule-1',
  date: '2026-04-14',
  checkedInAt: '2026-04-14T07:42:00.000Z',
  checkedInVia: 'app',
  lateMinutes: 12,
};

const baseStudentPayload: StudentAbsentPayload = {
  tenantId: 'tenant-1',
  schemaName: 'school_sainte_marie',
  studentId: 'student-1',
  scheduleId: 'schedule-1',
  studentFirstName: 'Awa',
  parentPhone: '2250700000001',
  subject: 'Maths',
  date: '2026-04-14',
  schoolPhone: '2250701234567',
};

// ---------- setup ----------

beforeEach(() => {
  vi.clearAllMocks();
  for (const event of ALL_EVENTS) {
    delete eventBusHandlers[event];
  }

  dbMocks.dbExecute.mockResolvedValue({ rows: [] });
  withTenantSchema.mockImplementation(async (_schemaName, callback) => callback(tenantDb));
  smsQueue.add.mockResolvedValue({ id: 'job-1' });
  repository.getLateAlertContext.mockResolvedValue(baseContext);
  repository.getQrAlertContext.mockResolvedValue({
    ...baseContext,
    expectedRoom: 'Salle A1',
    scannedRoom: 'Salle B2',
  });
  repository.insertNotificationLog.mockResolvedValue(undefined);
  repository.updateNotificationLogStatus.mockResolvedValue(undefined);

  // Par défaut, SubscriptionsRepository retourne feature activée non-monétisée
  // et un contact actif sans email
  vi.spyOn(SubscriptionsRepository.prototype, 'getTenantIdBySchemaName').mockResolvedValue('tenant-1');
  vi.spyOn(SubscriptionsRepository.prototype, 'getSmsFeatureByTenantId').mockResolvedValue(makeEnabledFeature());
  vi.spyOn(SubscriptionsRepository.prototype, 'listParentAlertContactsByStudent').mockResolvedValue([makeActiveContact()]);
  vi.spyOn(SubscriptionsRepository.prototype, 'getUsageByStudentMonth').mockResolvedValue({ sms: 0, email: 0 });
  vi.spyOn(SubscriptionsRepository.prototype, 'incrementUsage').mockResolvedValue(undefined);
});

const makeService = () =>
  new NotificationsService({
    withTenantSchema,
    repository,
    eventBus,
    smsQueue: smsQueue as never,
  });

// =====================================================================
//  start / stop
// =====================================================================

describe('lifecycle start/stop', () => {
  it("start() s'abonne a tous les events attendus", () => {
    const service = makeService();
    service.start();

    for (const event of ALL_EVENTS) {
      expect(eventBus.on).toHaveBeenCalledWith(event, expect.any(Function));
    }
  });

  it("start() est idempotent : double appel n'ajoute pas de listeners en double", () => {
    const service = makeService();
    service.start();
    service.start();

    expect(eventBus.on).toHaveBeenCalledTimes(ALL_EVENTS.length);
  });

  it('stop() se désinscrit de tous les events', () => {
    const service = makeService();
    service.start();
    service.stop();

    for (const event of ALL_EVENTS) {
      expect(eventBus.off).toHaveBeenCalledWith(event, expect.any(Function));
    }
  });
});

// =====================================================================
//  handleTeacherLate
// =====================================================================

describe('handleTeacherLate', () => {
  it('queue le SMS directeur et loggue queued', async () => {
    const service = makeService();
    await service.handleTeacherLate(baseLatePayload);

    const smsData = smsQueue.add.mock.calls[0]?.[1];

    expect(smsQueue.add).toHaveBeenCalledWith(
      'send-sms',
      expect.objectContaining({
        type: 'send-sms',
        to: '2250700000001',
        notificationType: 'teacher_late_director',
      }),
      expect.objectContaining({
        jobId: expect.stringContaining('notif-school_sainte_marie-teacher_late_director-'),
      })
    );
    expect(smsData?.message).toContain('Kouassi Awa');
    expect((smsData?.message as string).length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
    expect(repository.insertNotificationLog).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({
        type: 'teacher_late_director',
        status: 'queued',
        recipientPhone: '2250700000001',
      })
    );
  });

  it('garde le message <= SMS_MAX_LENGTH avec un nom très long', async () => {
    repository.getLateAlertContext.mockResolvedValueOnce({
      teacherName: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234',
      subject: 'Mathématiques avancées',
      className: 'Terminale D1',
      slotLabel: '07h30-09h00',
      directorPhone: '2250700000001',
    });

    const service = makeService();
    await service.handleTeacherLate(baseLatePayload);

    const smsData = smsQueue.add.mock.calls[0]?.[1];
    expect((smsData?.message as string).length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
  });

  it('ne déclenche pas de SMS si directorPhone est null', async () => {
    repository.getLateAlertContext.mockResolvedValueOnce({ ...baseContext, directorPhone: null });

    const service = makeService();
    await service.handleTeacherLate(baseLatePayload);

    expect(smsQueue.add).not.toHaveBeenCalled();
  });

  it('ne déclenche pas de SMS si le contexte est null', async () => {
    repository.getLateAlertContext.mockResolvedValueOnce(null);

    const service = makeService();
    await service.handleTeacherLate(baseLatePayload);

    expect(smsQueue.add).not.toHaveBeenCalled();
  });
});

// =====================================================================
//  handleTeacherQrAlert
// =====================================================================

describe('handleTeacherQrAlert', () => {
  it('loggue teacher_qr_mismatch en base sans envoyer de SMS (dashboard only)', async () => {
    const service = makeService();

    await service.handleTeacherQrAlert({
      tenantId: 'tenant-1',
      schemaName: 'school_sainte_marie',
      teacherId: 'teacher-1',
      scheduleId: 'schedule-1',
      date: '2026-04-14',
      alertType: 'teacher_qr_mismatch',
      roomMismatch: true,
    });

    expect(smsQueue.add).not.toHaveBeenCalled();
    expect(repository.insertNotificationLog).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({
        type: 'teacher_qr_mismatch',
        status: 'sent',
        relatedId: 'schedule-1',
      })
    );
    expect(repository.markQrAlertSent).toHaveBeenCalledWith(tenantDb, {
      teacherId: 'teacher-1',
      scheduleId: 'schedule-1',
      date: '2026-04-14',
    });
  });

  it('loggue teacher_qr_missing_scan en base sans envoyer de SMS', async () => {
    const service = makeService();

    await service.handleTeacherQrAlert({
      tenantId: 'tenant-1',
      schemaName: 'school_sainte_marie',
      teacherId: 'teacher-1',
      scheduleId: 'schedule-1',
      date: '2026-04-14',
      alertType: 'teacher_qr_missing_scan',
      roomMismatch: false,
    });

    expect(smsQueue.add).not.toHaveBeenCalled();
    expect(repository.insertNotificationLog).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({ type: 'teacher_qr_missing_scan', status: 'sent' })
    );
  });

  it('loggue teacher_qr_scan_out_of_time en base sans envoyer de SMS', async () => {
    const service = makeService();

    await service.handleTeacherQrAlert({
      tenantId: 'tenant-1',
      schemaName: 'school_sainte_marie',
      teacherId: 'teacher-1',
      scheduleId: 'schedule-1',
      date: '2026-04-14',
      alertType: 'teacher_qr_scan_out_of_time',
      roomMismatch: false,
    });

    expect(smsQueue.add).not.toHaveBeenCalled();
    expect(repository.insertNotificationLog).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({ type: 'teacher_qr_scan_out_of_time', status: 'sent' })
    );
  });

  it('ne loggue rien si le contexte est null', async () => {
    repository.getQrAlertContext.mockResolvedValueOnce(null);
    const service = makeService();

    await service.handleTeacherQrAlert({
      tenantId: 'tenant-1',
      schemaName: 'school_sainte_marie',
      teacherId: 'teacher-1',
      scheduleId: 'schedule-1',
      date: '2026-04-14',
      alertType: 'teacher_qr_mismatch',
      roomMismatch: true,
    });

    expect(smsQueue.add).not.toHaveBeenCalled();
    expect(repository.insertNotificationLog).not.toHaveBeenCalled();
  });
});

// =====================================================================
//  handleStudentAbsent — feature non-monétisée (free)
// =====================================================================

describe('handleStudentAbsent — feature activée, non-monétisée', () => {
  it('queue le SMS parent et loggue queued', async () => {
    const service = makeService();
    await service.handleStudentAbsent(baseStudentPayload);

    expect(smsQueue.add).toHaveBeenCalledWith(
      'send-sms',
      expect.objectContaining({
        type: 'send-sms',
        to: '2250700000001',
        notificationType: 'student_absent_parent',
        relatedId: 'schedule-1',
      }),
      expect.objectContaining({
        jobId: expect.stringContaining('notif-school_sainte_marie-student_absent_parent-'),
      })
    );
    expect(repository.insertNotificationLog).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({
        type: 'student_absent_parent',
        channel: 'sms',
        recipientPhone: '2250700000001',
        status: 'queued',
        relatedId: 'schedule-1',
      })
    );
  });

  it('queue aussi un email si le contact a un email', async () => {
    vi.spyOn(SubscriptionsRepository.prototype, 'listParentAlertContactsByStudent').mockResolvedValue([
      makeActiveContact({ parent_email: 'parent@test.ci' }),
    ]);

    const service = makeService();
    await service.handleStudentAbsent(baseStudentPayload);

    expect(smsQueue.add).toHaveBeenCalledWith(
      'send-email',
      expect.objectContaining({
        type: 'send-email',
        to: 'parent@test.ci',
        notificationType: 'student_absent_parent',
      }),
      expect.any(Object)
    );
    expect(repository.insertNotificationLog).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({
        channel: 'email',
        recipientEmail: 'parent@test.ci',
        status: 'queued',
      })
    );
  });

  it("loggue skipped_unknown pour l'email si le contact n'a pas d'email", async () => {
    // contact sans email (défaut)
    const service = makeService();
    await service.handleStudentAbsent(baseStudentPayload);

    expect(repository.insertNotificationLog).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({ channel: 'email', status: 'skipped_unknown' })
    );
  });

  it('utilise le fallback payload.parentPhone si aucun contact en DB', async () => {
    vi.spyOn(SubscriptionsRepository.prototype, 'listParentAlertContactsByStudent').mockResolvedValue([]);

    const service = makeService();
    await service.handleStudentAbsent(baseStudentPayload);

    expect(smsQueue.add).toHaveBeenCalledWith(
      'send-sms',
      expect.objectContaining({ to: '2250700000001' }),
      expect.any(Object)
    );
  });

  it("ne loggue pas d'incrementUsage quand monetize=false", async () => {
    const incrementSpy = vi.spyOn(SubscriptionsRepository.prototype, 'incrementUsage').mockResolvedValue(undefined);

    const service = makeService();
    await service.handleStudentAbsent(baseStudentPayload);

    expect(incrementSpy).not.toHaveBeenCalled();
  });

  it('notifie plusieurs contacts pour un même élève', async () => {
    vi.spyOn(SubscriptionsRepository.prototype, 'listParentAlertContactsByStudent').mockResolvedValue([
      makeActiveContact({ parent_phone: '2250700000001' }),
      makeActiveContact({ parent_id: 'parent-2', parent_phone: '2250700000002' }),
    ]);

    const service = makeService();
    await service.handleStudentAbsent(baseStudentPayload);

    const smsCalls = smsQueue.add.mock.calls.filter((c) => c[0] === 'send-sms');
    expect(smsCalls).toHaveLength(2);
  });
});

// =====================================================================
//  handleStudentAbsent — feature désactivée
// =====================================================================

describe('handleStudentAbsent — feature désactivée', () => {
  it("loggue skipped_feature_disabled et n'envoie pas de SMS", async () => {
    vi.spyOn(SubscriptionsRepository.prototype, 'getSmsFeatureByTenantId').mockResolvedValue({
      ...makeEnabledFeature(),
      is_enabled: false,
    });

    const service = makeService();
    await service.handleStudentAbsent(baseStudentPayload);

    expect(smsQueue.add).not.toHaveBeenCalled();
    expect(repository.insertNotificationLog).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({ channel: 'sms', status: 'skipped_feature_disabled' })
    );
    expect(repository.insertNotificationLog).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({ channel: 'email', status: 'skipped_feature_disabled' })
    );
  });

  it("ne tente pas l'envoi si feature est null (tenant sans configuration)", async () => {
    vi.spyOn(SubscriptionsRepository.prototype, 'getSmsFeatureByTenantId').mockResolvedValue(null);
    vi.spyOn(SubscriptionsRepository.prototype, 'getTenantIdBySchemaName').mockResolvedValue('tenant-1');

    const service = makeService();
    await service.handleStudentAbsent(baseStudentPayload);

    expect(smsQueue.add).not.toHaveBeenCalled();
  });
});

// =====================================================================
//  handleStudentAbsent — feature monétisée
// =====================================================================

describe('handleStudentAbsent — feature monétisée', () => {
  beforeEach(() => {
    vi.spyOn(SubscriptionsRepository.prototype, 'getSmsFeatureByTenantId').mockResolvedValue(
      makeEnabledFeature({ monetize: true, smsCap: 5 })
    );
  });

  it('envoie le SMS si le parent a un abonnement actif non expiré', async () => {
    vi.spyOn(SubscriptionsRepository.prototype, 'listParentAlertContactsByStudent').mockResolvedValue([
      makeActiveContact({ subscription_status: 'active', ends_at: '2099-12-31', subscription_id: 'sub-1' }),
    ]);

    const service = makeService();
    await service.handleStudentAbsent(baseStudentPayload);

    expect(smsQueue.add).toHaveBeenCalledWith(
      'send-sms',
      expect.objectContaining({ notificationType: 'student_absent_parent' }),
      expect.any(Object)
    );
  });

  it("incremente l'usage SMS apres l'envoi", async () => {
    vi.spyOn(SubscriptionsRepository.prototype, 'listParentAlertContactsByStudent').mockResolvedValue([
      makeActiveContact({ subscription_status: 'active', ends_at: '2099-12-31', subscription_id: 'sub-1' }),
    ]);
    const incrementSpy = vi.spyOn(SubscriptionsRepository.prototype, 'incrementUsage').mockResolvedValue(undefined);

    const service = makeService();
    await service.handleStudentAbsent(baseStudentPayload);

    expect(incrementSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sms', subscriptionId: 'sub-1' })
    );
  });

  it("incremente aussi l'usage email si un email est envoye", async () => {
    vi.spyOn(SubscriptionsRepository.prototype, 'listParentAlertContactsByStudent').mockResolvedValue([
      makeActiveContact({
        subscription_status: 'active',
        ends_at: '2099-12-31',
        subscription_id: 'sub-1',
        parent_email: 'parent@test.ci',
      }),
    ]);
    const incrementSpy = vi.spyOn(SubscriptionsRepository.prototype, 'incrementUsage').mockResolvedValue(undefined);

    const service = makeService();
    await service.handleStudentAbsent(baseStudentPayload);

    expect(incrementSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'sms' }));
    expect(incrementSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'email' }));
  });

  it("loggue skipped_no_active_subscription si le parent n'a pas de souscription", async () => {
    vi.spyOn(SubscriptionsRepository.prototype, 'listParentAlertContactsByStudent').mockResolvedValue([
      makeActiveContact({ subscription_id: null, subscription_status: null }),
    ]);

    const service = makeService();
    await service.handleStudentAbsent(baseStudentPayload);

    expect(smsQueue.add).not.toHaveBeenCalled();
    expect(repository.insertNotificationLog).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({ status: 'skipped_no_active_subscription' })
    );
  });

  it('loggue skipped_subscription_expired si la souscription est expirée', async () => {
    vi.spyOn(SubscriptionsRepository.prototype, 'listParentAlertContactsByStudent').mockResolvedValue([
      makeActiveContact({ subscription_status: 'active', ends_at: '2020-01-01', subscription_id: 'sub-1' }),
    ]);

    const service = makeService();
    await service.handleStudentAbsent(baseStudentPayload);

    expect(smsQueue.add).not.toHaveBeenCalled();
    expect(repository.insertNotificationLog).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({ status: 'skipped_subscription_expired' })
    );
  });

  it('loggue skipped_cap_reached si le cap SMS mensuel est atteint', async () => {
    vi.spyOn(SubscriptionsRepository.prototype, 'listParentAlertContactsByStudent').mockResolvedValue([
      makeActiveContact({ subscription_status: 'active', ends_at: '2099-12-31', subscription_id: 'sub-1' }),
    ]);
    vi.spyOn(SubscriptionsRepository.prototype, 'getUsageByStudentMonth').mockResolvedValue({ sms: 5, email: 0 });

    const service = makeService();
    await service.handleStudentAbsent(baseStudentPayload);

    expect(smsQueue.add).not.toHaveBeenCalled();
    expect(repository.insertNotificationLog).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({ status: 'skipped_cap_reached' })
    );
  });

  it('envoie si usage SMS = cap - 1 (juste en dessous du plafond)', async () => {
    vi.spyOn(SubscriptionsRepository.prototype, 'listParentAlertContactsByStudent').mockResolvedValue([
      makeActiveContact({ subscription_status: 'active', ends_at: '2099-12-31', subscription_id: 'sub-1' }),
    ]);
    vi.spyOn(SubscriptionsRepository.prototype, 'getUsageByStudentMonth').mockResolvedValue({ sms: 4, email: 0 });

    const service = makeService();
    await service.handleStudentAbsent(baseStudentPayload);

    expect(smsQueue.add).toHaveBeenCalledWith(
      'send-sms',
      expect.objectContaining({ notificationType: 'student_absent_parent' }),
      expect.any(Object)
    );
  });

  it('skip les contacts sans abonnement mais envoie au contact suivant qui en a un', async () => {
    vi.spyOn(SubscriptionsRepository.prototype, 'listParentAlertContactsByStudent').mockResolvedValue([
      makeActiveContact({ parent_phone: '2250700000001', subscription_id: null, subscription_status: null }),
      makeActiveContact({ parent_phone: '2250700000002', parent_id: 'parent-2', subscription_status: 'active', ends_at: '2099-12-31', subscription_id: 'sub-2' }),
    ]);

    const service = makeService();
    await service.handleStudentAbsent(baseStudentPayload);

    const smsCalls = smsQueue.add.mock.calls.filter((c) => c[0] === 'send-sms');
    expect(smsCalls).toHaveLength(1);
    expect(smsCalls[0]?.[1]).toMatchObject({ to: '2250700000002' });
  });
});

// =====================================================================
//  handleSubscriptionExpired
// =====================================================================

describe('handleSubscriptionExpired', () => {
  it('queue SMS et email directeur quand directorEmail est fourni', async () => {
    const service = makeService();

    await service.handleSubscriptionExpired({
      tenantId: 'tenant-1',
      schemaName: 'school_sainte_marie',
      schoolName: 'Sainte Marie',
      periodLabel: '01/04/2026 -> 30/04/2026',
      dueDate: '2026-05-01',
      remainingAmountFcfa: 25000,
      directorPhone: '2250700000001',
      directorEmail: 'directeur@test.ci',
    });

    expect(smsQueue.add).toHaveBeenNthCalledWith(
      1,
      'send-sms',
      expect.objectContaining({ type: 'send-sms', to: '2250700000001', notificationType: 'payment_reminder' }),
      expect.any(Object)
    );
    expect(smsQueue.add).toHaveBeenNthCalledWith(
      2,
      'send-email',
      expect.objectContaining({
        type: 'send-email',
        to: 'directeur@test.ci',
        subject: '[IvoirEdu] Relance paiement — Sainte Marie',
        notificationType: 'payment_reminder',
      }),
      expect.any(Object)
    );
    expect(repository.insertNotificationLog).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({
        type: 'payment_reminder',
        channel: 'email',
        recipientEmail: 'directeur@test.ci',
        status: 'queued',
      })
    );
  });

  it("loggue skipped_unknown pour l'email si directorEmail est absent", async () => {
    const service = makeService();

    await service.handleSubscriptionExpired({
      tenantId: 'tenant-1',
      schemaName: 'school_sainte_marie',
      schoolName: 'Sainte Marie',
      periodLabel: '01/04/2026 -> 30/04/2026',
      dueDate: '2026-05-01',
      remainingAmountFcfa: 25000,
      directorPhone: '2250700000001',
    });

    const smsCalls = smsQueue.add.mock.calls.filter((c) => c[0] === 'send-sms');
    expect(smsCalls).toHaveLength(1);
    expect(repository.insertNotificationLog).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({ channel: 'email', status: 'skipped_unknown' })
    );
  });
});

// =====================================================================
//  handleStudentAbsent — propagation tenant.student_label (P2-05 palier D)
// =====================================================================

describe('handleStudentAbsent — student_label propagation', () => {
  const tenantLabelRow = (label: string | null) => ({ rows: [{ student_label: label }] });
  const customSmsTemplateRow = (template: string) => ({ rows: [{ message_template: template }] });
  const tenantIdRow = { rows: [{ id: 'tenant-1' }] };

  it("injecte le label custom du tenant ('Étudiant(e)') dans le subject email et dans un template SMS contenant {studentLabel}", async () => {
    // tenantDb.execute → utilisé seulement par resolveSmsTemplateMessage indirectement ? Non:
    // resolveSmsTemplateMessage et resolveTenantStudentLabel utilisent tous deux le `db` public,
    // qui est notre dbMocks.dbExecute. On distingue les requêtes via leur SQL.
    dbMocks.dbExecute.mockImplementation(async (query: unknown) => {
      const text = (query as { queryChunks?: Array<{ value?: string[] } | string> }).queryChunks
        ?.map((chunk) => (typeof chunk === 'string' ? chunk : chunk?.value?.[0] ?? ''))
        .join('') ?? '';
      if (text.includes('FROM public.sms_templates')) {
        return customSmsTemplateRow(
          'EduTrack: {studentLabel} {studentFirstName} absent(e) en {subject} le {date}.'
        );
      }
      if (text.includes('FROM public.tenants') && text.includes('student_label')) {
        return tenantLabelRow('Étudiant(e)');
      }
      if (text.includes('FROM public.tenants')) {
        return tenantIdRow;
      }
      return { rows: [] };
    });

    vi.spyOn(SubscriptionsRepository.prototype, 'listParentAlertContactsByStudent').mockResolvedValue([
      makeActiveContact({ parent_email: 'parent@test.ci' }),
    ]);

    const service = makeService();
    await service.handleStudentAbsent(baseStudentPayload);

    const smsCall = smsQueue.add.mock.calls.find((c) => c[0] === 'send-sms');
    const emailCall = smsQueue.add.mock.calls.find((c) => c[0] === 'send-email');

    expect(smsCall?.[1]).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('Étudiant(e)'),
      })
    );
    expect(smsCall?.[1]).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('Awa'),
      })
    );
    expect((smsCall?.[1] as { message: string }).message).not.toContain('{studentLabel}');
    expect(emailCall?.[1]).toEqual(
      expect.objectContaining({
        subject: 'Absence Étudiant(e) — IvoirEdu',
      })
    );
  });

  it("retombe sur 'élève' quand tenant.student_label est NULL", async () => {
    dbMocks.dbExecute.mockImplementation(async (query: unknown) => {
      const text = (query as { queryChunks?: Array<{ value?: string[] } | string> }).queryChunks
        ?.map((chunk) => (typeof chunk === 'string' ? chunk : chunk?.value?.[0] ?? ''))
        .join('') ?? '';
      if (text.includes('FROM public.tenants') && text.includes('student_label')) {
        return tenantLabelRow(null);
      }
      return { rows: [] };
    });

    vi.spyOn(SubscriptionsRepository.prototype, 'listParentAlertContactsByStudent').mockResolvedValue([
      makeActiveContact({ parent_email: 'parent@test.ci' }),
    ]);

    const service = makeService();
    await service.handleStudentAbsent(baseStudentPayload);

    const emailCall = smsQueue.add.mock.calls.find((c) => c[0] === 'send-email');

    expect(emailCall?.[1]).toEqual(
      expect.objectContaining({
        subject: 'Absence élève — IvoirEdu',
      })
    );
  });
});
