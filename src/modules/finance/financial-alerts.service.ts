import { logger as appLogger } from '../../shared/observability/logger.js';
import { withTenantSchema } from '../../shared/database/db.js';
import { FinancialAlertsRepository, type FinancialAlertRule } from './financial-alerts.repository.js';

type SmsQueueHandle = {
  add: (
    name: string,
    data: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Promise<{ id?: string | number } | undefined> | Promise<unknown> | unknown;
};

/** Détermine si une règle s'applique à l'état de cache d'un élève (pur). */
export const isRuleDue = (
  rule: Pick<FinancialAlertRule, 'type' | 'daysOffset'>,
  student: { status: 'up_to_date' | 'late' | 'waived'; daysLate: number | null }
): boolean => {
  if (rule.type === 'preventive') {
    // Préventive : traitée via la fenêtre avant échéance (voir listPreventiveReminders).
    return false;
  }
  if (student.status !== 'late') return false;
  return (student.daysLate ?? 0) >= rule.daysOffset;
};

export class FinancialAlertsService {
  constructor(
    private readonly repository: FinancialAlertsRepository,
    private readonly smsQueue?: SmsQueueHandle
  ) {}

  async runDaily(schemaName: string): Promise<{ sentCount: number; skippedCount: number }> {
    this.schemaNameRef = schemaName;
    return withTenantSchema(schemaName, async (tenantDb) =>
      this.runDailyOnDb(tenantDb, schemaName)
    );
  }

  /** Cœur testable : envoie les relances dues sur une connexion tenant arbitraire. */
  async runDailyOnDb(
    tenantDb: ConstructorParameters<typeof FinancialAlertsRepository>[0],
    schemaName = ''
  ): Promise<{ sentCount: number; skippedCount: number }> {
    const repository = new FinancialAlertsRepository(tenantDb);
    const yearId = await this.activeYearId(repository);
    if (!yearId) return { sentCount: 0, skippedCount: 0 };
    this.schemaNameRef = schemaName;

    const due = await repository.listDueReminders(yearId);
    let sentCount = 0;
    let skippedCount = 0;

    for (const reminder of due) {
      if (await repository.wasReminderSentRecently(reminder.studentId, reminder.ruleId)) {
        skippedCount += 1;
        continue;
      }

      const message =
        reminder.ruleType === 'severe_late'
          ? `URGENT - Scolarite de ${reminder.studentName} en retard de ${reminder.daysLate ?? 0} jours. Merci de regulariser rapidement.`
          : `Rappel - Scolarite de ${reminder.studentName} en retard. Merci de regulariser aupres de l'ecole.`;

      try {
        if (reminder.channel === 'in_app' || reminder.channel === 'both') {
          await repository.insertInAppPaymentReminder({
            studentId: reminder.studentId,
            ruleId: reminder.ruleId,
            ruleType: reminder.ruleType,
            message,
          });
        }

        if (reminder.channel === 'in_app') {
          await repository.insertAlertLog({
            studentId: reminder.studentId,
            ruleId: reminder.ruleId,
            channel: reminder.channel,
            status: 'sent',
            message,
          });
          sentCount += 1;
          continue;
        }

        if (this.smsQueue && reminder.parentPhone) {
          const queueRef = `fin-alert-${reminder.ruleId}-${reminder.studentId}-${Date.now()}`;
          await this.smsQueue.add(
            'send-sms',
            {
              type: 'send-sms',
              to: reminder.parentPhone,
              message,
              notificationType: 'payment_reminder',
              schemaName: this.schemaNameRef,
              recipientPhone: reminder.parentPhone,
              queueRef,
            },
            { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true }
          );
        } else if (!reminder.parentPhone) {
          // Pas de numéro joignable : on logue l'échec sans bloquer le lot.
          await repository.insertAlertLog({
            studentId: reminder.studentId,
            ruleId: reminder.ruleId,
            channel: reminder.channel,
            status: 'failed',
            message: 'Aucun numéro parent disponible',
          });
          sentCount += 0;
          continue;
        }

        await repository.insertAlertLog({
          studentId: reminder.studentId,
          ruleId: reminder.ruleId,
          channel: reminder.channel,
          status: 'sent',
          message,
        });
        sentCount += 1;
      } catch (error) {
        // Les relances ne doivent jamais faire échouer le lot quotidien.
        appLogger.warn({ err: error }, '[financial-alerts] envoi relance impossible');
        await repository.insertAlertLog({
          studentId: reminder.studentId,
          ruleId: reminder.ruleId,
          channel: reminder.channel,
          status: 'failed',
          message: error instanceof Error ? error.message : undefined,
        }).catch(() => undefined);
      }
    }

    return { sentCount, skippedCount };
  }

  private schemaNameRef = '';

  private activeYearId(repository: FinancialAlertsRepository): Promise<string | null> {
    return repository.getActiveSchoolYearId();
  }
}

// Ré-export pratique pour server.ts / tests.
export { FinancialAlertsRepository };
