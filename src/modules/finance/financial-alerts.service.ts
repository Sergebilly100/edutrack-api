import { logger as appLogger } from '../../shared/observability/logger.js';
import { withTenantSchema } from '../../shared/database/db.js';
import { FinancialAlertsRepository, type FinancialAlertRule } from './financial-alerts.repository.js';

type SmsQueueHandle = {
  add: (
    name: string,
    data: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Promise<unknown> | unknown;
};

/** Détermine si une règle de retard s'applique (les préventives dépendent des échéances). */
export const isRuleDue = (
  rule: Pick<FinancialAlertRule, 'type' | 'daysOffset'>,
  student: { status: 'up_to_date' | 'late' | 'waived'; daysLate: number | null }
): boolean => {
  if (rule.type === 'preventive' || student.status !== 'late') return false;
  return (student.daysLate ?? 0) >= rule.daysOffset;
};

export const buildFinancialReminderMessage = (reminder: {
  ruleType: FinancialAlertRule['type'];
  studentName: string;
  daysLate: number | null;
}): string => {
  if (reminder.ruleType === 'preventive') {
    return `Rappel - Une echeance de scolarite de ${reminder.studentName} approche. Merci de prevoir le reglement aupres de l'ecole.`;
  }
  if (reminder.ruleType === 'severe_late') {
    return `URGENT - Scolarite de ${reminder.studentName} en retard de ${reminder.daysLate ?? 0} jours. Merci de regulariser rapidement.`;
  }
  return `Rappel - Scolarite de ${reminder.studentName} en retard. Merci de regulariser aupres de l'ecole.`;
};

export class FinancialAlertsService {
  constructor(
    private readonly repository: FinancialAlertsRepository,
    private readonly smsQueue?: SmsQueueHandle
  ) {}

  async runDaily(schemaName: string): Promise<{ sentCount: number; skippedCount: number }> {
    return withTenantSchema(schemaName, (tenantDb) => this.runDailyOnDb(tenantDb, schemaName));
  }

  /** Journalise chaque canal séparément : une panne SMS ne redépose pas l'in-app. */
  async runDailyOnDb(
    tenantDb: ConstructorParameters<typeof FinancialAlertsRepository>[0],
    schemaName = ''
  ): Promise<{ sentCount: number; skippedCount: number }> {
    const repository = tenantDb === this.repository.db ? this.repository : new FinancialAlertsRepository(tenantDb);
    const yearId = await repository.getActiveSchoolYearId();
    if (!yearId) return { sentCount: 0, skippedCount: 0 };

    const due = await repository.listDueReminders(yearId);
    let sentCount = 0;
    let skippedCount = 0;
    for (const reminder of due) {
      const message = buildFinancialReminderMessage(reminder);
      const channels: Array<'in_app' | 'sms'> = reminder.channel === 'both'
        ? ['in_app', 'sms'] : [reminder.channel];
      let delivered = false;
      let allSkipped = true;

      for (const channel of channels) {
        if (await repository.wasReminderSentRecently(reminder.studentId, reminder.ruleId, channel)) continue;
        allSkipped = false;
        try {
          if (channel === 'in_app') {
            const recipientCount = await repository.insertInAppPaymentReminder({
              studentId: reminder.studentId,
              studentName: reminder.studentName,
              ruleId: reminder.ruleId,
              ruleType: reminder.ruleType,
              message,
            });
            if (recipientCount === 0) throw new Error('Aucun compte parent actif lié à cet élève');
          } else {
            if (!this.smsQueue || !reminder.parentPhone) throw new Error('Canal SMS indisponible');
            const queueRef = `fin-alert-${reminder.ruleId}-${reminder.studentId}-${Date.now()}`;
            await this.smsQueue.add('send-sms', {
              type: 'send-sms', to: reminder.parentPhone, message,
              notificationType: 'payment_reminder', schemaName,
              recipientPhone: reminder.parentPhone, queueRef,
            }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true });
          }
          await repository.insertAlertLog({
            studentId: reminder.studentId, ruleId: reminder.ruleId,
            channel, status: 'sent', message,
          });
          delivered = true;
        } catch {
          // Aucun nom, numéro ou message fournisseur dans les logs applicatifs.
          appLogger.warn({ studentId: reminder.studentId, ruleId: reminder.ruleId, channel }, '[financial-alerts] canal indisponible');
          await repository.insertAlertLog({
            studentId: reminder.studentId, ruleId: reminder.ruleId,
            channel, status: 'failed', message: channel === 'in_app'
              ? 'Relance in-app non remise à un compte parent actif'
              : 'Relance SMS non mise en file',
          }).catch(() => undefined);
        }
      }
      if (delivered) sentCount += 1;
      if (allSkipped) skippedCount += 1;
    }
    return { sentCount, skippedCount };
  }
}

export { FinancialAlertsRepository };
