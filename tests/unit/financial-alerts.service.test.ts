import { describe, expect, it, vi } from 'vitest';

import { buildFinancialReminderMessage, FinancialAlertsRepository, FinancialAlertsService, isRuleDue } from '../../src/modules/finance/financial-alerts.service.js';

const baseRule = { type: 'late' as const, daysOffset: 3 };
const severeRule = { type: 'severe_late' as const, daysOffset: 15 };

describe('isRuleDue (détermination des relances dues)', () => {
  it('élève en retard au-delà du seuil : relance due', () => {
    expect(isRuleDue(baseRule, { status: 'late', daysLate: 5 })).toBe(true);
    expect(isRuleDue(baseRule, { status: 'late', daysLate: 3 })).toBe(true); // seuil inclus
  });

  it('retard sous le seuil : pas de relance', () => {
    expect(isRuleDue(baseRule, { status: 'late', daysLate: 2 })).toBe(false);
    expect(isRuleDue(baseRule, { status: 'late', daysLate: null })).toBe(false);
  });

  it('élève à jour : jamais de relance de retard', () => {
    expect(isRuleDue(baseRule, { status: 'up_to_date', daysLate: 30 })).toBe(false);
  });

  it('severe_late exige un retard supérieur au seuil simple', () => {
    expect(isRuleDue(severeRule, { status: 'late', daysLate: 10 })).toBe(false);
    expect(isRuleDue(severeRule, { status: 'late', daysLate: 15 })).toBe(true);
  });
});


describe('message de relance selon la situation réelle', () => {
  it('annonce une échéance à venir sans accuser un parent à jour de retard', () => {
    const message = buildFinancialReminderMessage({ ruleType: 'preventive', studentName: 'Aya QA', daysLate: null });
    expect(message).toContain('Aya QA');
    expect(message).toContain('approche');
    expect(message).not.toMatch(/retard|URGENT/);
  });
  it('distingue retard simple et retard important', () => {
    expect(buildFinancialReminderMessage({ ruleType: 'late', studentName: 'Aya QA', daysLate: 3 })).toContain('en retard');
    expect(buildFinancialReminderMessage({ ruleType: 'severe_late', studentName: 'Aya QA', daysLate: 15 })).toContain('URGENT - Scolarite de Aya QA en retard de 15 jours');
  });
});

describe('orchestration indépendante des canaux de relance', () => {
  const fixture = () => {
    const db = {} as ConstructorParameters<typeof FinancialAlertsRepository>[0];
    const reminder = { studentId: '11111111-1111-4111-8111-111111111111', ruleId: '22222222-2222-4222-8222-222222222222', studentName: 'Élève QA', parentPhone: '2250700000001', ruleType: 'late', channel: 'both', daysLate: 5 };
    const repository = {
      db,
      getActiveSchoolYearId: vi.fn().mockResolvedValue('year'),
      listDueReminders: vi.fn().mockResolvedValue([reminder]),
      wasReminderSentRecently: vi.fn().mockResolvedValue(false),
      insertInAppPaymentReminder: vi.fn().mockResolvedValue(1),
      insertAlertLog: vi.fn().mockResolvedValue(undefined),
    };
    const queue = { add: vi.fn().mockResolvedValue({ id: 'queued' }) };
    return { db, reminder, repository, queue, service: new FinancialAlertsService(repository as unknown as FinancialAlertsRepository, queue) };
  };

  it('continue le SMS si aucun parent actif ne reçoit le canal in-app', async () => {
    const f = fixture();
    f.repository.insertInAppPaymentReminder.mockResolvedValue(0);
    expect(await f.service.runDailyOnDb(f.db, 'school_qa')).toEqual({ sentCount: 1, skippedCount: 0 });
    expect(f.queue.add).toHaveBeenCalledWith('send-sms', expect.objectContaining({ schemaName: 'school_qa', notificationType: 'payment_reminder' }), expect.objectContaining({ attempts: 3 }));
    expect(f.repository.insertAlertLog.mock.calls.map(([log]) => ({ channel: log.channel, status: log.status }))).toEqual([
      { channel: 'in_app', status: 'failed' }, { channel: 'sms', status: 'sent' },
    ]);
  });

  it('n’annonce jamais un SMS envoyé quand le numéro manque', async () => {
    const f = fixture();
    f.repository.listDueReminders.mockResolvedValue([{ ...f.reminder, channel: 'sms', parentPhone: null }]);
    expect(await f.service.runDailyOnDb(f.db, 'school_qa')).toEqual({ sentCount: 0, skippedCount: 0 });
    expect(f.queue.add).not.toHaveBeenCalled();
    expect(f.repository.insertAlertLog).toHaveBeenCalledWith(expect.objectContaining({ channel: 'sms', status: 'failed' }));
  });

  it('ne redépose aucun des canaux déjà livrés récemment', async () => {
    const f = fixture();
    f.repository.wasReminderSentRecently.mockResolvedValue(true);
    expect(await f.service.runDailyOnDb(f.db)).toEqual({ sentCount: 0, skippedCount: 1 });
    expect(f.queue.add).not.toHaveBeenCalled();
    expect(f.repository.insertInAppPaymentReminder).not.toHaveBeenCalled();
    expect(f.repository.insertAlertLog).not.toHaveBeenCalled();
  });

  it('ne cherche aucun débiteur sans année active', async () => {
    const f = fixture();
    f.repository.getActiveSchoolYearId.mockResolvedValue(null);
    expect(await f.service.runDailyOnDb(f.db)).toEqual({ sentCount: 0, skippedCount: 0 });
    expect(f.repository.listDueReminders).not.toHaveBeenCalled();
    expect(f.queue.add).not.toHaveBeenCalled();
  });
});
