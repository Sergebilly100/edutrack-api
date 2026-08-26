import { sql } from 'drizzle-orm';

import type { TenantDb } from '../../shared/database/db.js';

type Rows<T> = { rows?: T[] };

const getRows = <T>(result: unknown): T[] => {
  if (typeof result !== 'object' || result === null || !('rows' in result)) {
    return [];
  }
  const rows = (result as Rows<T>).rows;
  return Array.isArray(rows) ? rows : [];
};

export type FinancialAlertRule = {
  id: string;
  type: 'preventive' | 'late' | 'severe_late';
  daysOffset: number;
  channel: 'sms' | 'in_app' | 'both';
  isActive: boolean;
};

export class FinancialAlertsRepository {
  constructor(readonly db: TenantDb) {}

  async getActiveSchoolYearId(): Promise<string | null> {
    const result = await this.db.execute<{ id: string }>(sql`
      SELECT id::text FROM school_years WHERE status = 'active' LIMIT 1
    `);
    return getRows<{ id: string }>(result)[0]?.id ?? null;
  }

  async listRules(): Promise<FinancialAlertRule[]> {
    const result = await this.db.execute<{
      id: string; type: string; days_offset: number; channel: string; is_active: boolean;
    }>(sql`
      SELECT id::text, type::text, days_offset, channel::text, is_active
      FROM financial_alert_rules ORDER BY days_offset ASC
    `);
    return getRows<{
      id: string; type: string; days_offset: number; channel: string; is_active: boolean;
    }>(result).map((row) => ({
      id: String(row.id),
      type: row.type as FinancialAlertRule['type'],
      daysOffset: Number(row.days_offset),
      channel: row.channel as FinancialAlertRule['channel'],
      isActive: Boolean(row.is_active),
    }));
  }

  async upsertRule(input: {
    type: FinancialAlertRule['type'];
    daysOffset: number;
    channel: FinancialAlertRule['channel'];
    isActive: boolean;
    createdByUserId?: string;
  }): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO financial_alert_rules (type, days_offset, channel, is_active, created_by_user_id)
      VALUES (${input.type}::financial_alert_rule_type, ${input.daysOffset},
              ${input.channel}::financial_alert_channel, ${input.isActive}, ${input.createdByUserId ?? null}::uuid)
      ON CONFLICT ("type") DO UPDATE SET
        days_offset = EXCLUDED.days_offset,
        channel = EXCLUDED.channel,
        is_active = EXCLUDED.is_active,
        updated_at = NOW()
    `);
  }

  async deleteRule(id: string): Promise<boolean> {
    const result = await this.db.execute(sql`
      DELETE FROM financial_alert_rules WHERE id = ${id}::uuid RETURNING id::text
    `);
    return getRows(result).length > 0;
  }

  /**
   * Élèves éligibles par règle : joint le cache financier (6a) aux règles
   * actives, sans recalculer les montants ici.
   */
  async listDueReminders(schoolYearId: string): Promise<Array<{
    studentId: string;
    studentName: string;
    parentPhone: string | null;
    status: string;
    daysLate: number | null;
    ruleId: string;
    ruleType: FinancialAlertRule['type'];
    channel: FinancialAlertRule['channel'];
  }>> {
    const result = await this.db.execute<Record<string, string | number | null>>(sql`
      SELECT s.id::text AS student_id,
             concat_ws(' ', s.first_name, s.last_name) AS student_name,
             COALESCE(s.parent_phone, s.parent_phone_2) AS parent_phone,
             sfs.status::text AS status,
             sfs.days_late,
             r.id::text AS rule_id,
             r.type::text AS rule_type,
             r.channel::text AS channel
      FROM student_financial_status sfs
      INNER JOIN students s ON s.id = sfs.student_id AND s.is_active = true
      INNER JOIN financial_alert_rules r
        ON r.is_active = true
       AND (
         (r.type = 'late' AND sfs.status = 'late' AND COALESCE(sfs.days_late, 0) >= r.days_offset)
         OR (r.type = 'severe_late' AND sfs.status = 'late' AND COALESCE(sfs.days_late, 0) >= r.days_offset)
         OR (
           r.type = 'preventive'
           AND sfs.status = 'up_to_date'
           AND EXISTS (
             SELECT 1
             FROM tuition_schedule_steps tss
             INNER JOIN tuition_plans tp ON tp.id = tss.tuition_plan_id
             INNER JOIN classes c2 ON c2.level_id = tp.level_id AND c2.id = COALESCE(s.class_id, s.class_id)
             WHERE tp.school_year_id = sfs.school_year_id
               AND tss.due_date > CURRENT_DATE
               AND tss.due_date <= CURRENT_DATE + r.days_offset
           )
         )
       )
      WHERE sfs.school_year_id = ${schoolYearId}::uuid
    `);
    return getRows<{
      student_id: string;
      student_name: string;
      parent_phone: string | null;
      status: string;
      days_late: number | null;
      rule_id: string;
      rule_type: string;
      channel: string;
    }>(result).map((row) => ({
      studentId: String(row.student_id),
      studentName: String(row.student_name),
      parentPhone: row.parent_phone === null ? null : String(row.parent_phone),
      status: String(row.status),
      daysLate: row.days_late === null ? null : Number(row.days_late),
      ruleId: String(row.rule_id),
      ruleType: row.rule_type as FinancialAlertRule['type'],
      channel: row.channel as FinancialAlertRule['channel'],
    }));
  }

  async wasReminderSentRecently(studentId: string, ruleId: string, withinDays = 7): Promise<boolean> {
    const result = await this.db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM financial_alert_logs
        WHERE student_id = ${studentId}::uuid AND rule_id = ${ruleId}::uuid
          AND sent_at >= NOW() - (${withinDays} || ' days')::interval
      ) AS exists
    `);
    return getRows<{ exists: boolean }>(result)[0]?.exists ?? false;
  }

  async insertAlertLog(input: {
    studentId: string;
    ruleId: string;
    channel: FinancialAlertRule['channel'];
    status: 'sent' | 'failed';
    message?: string;
  }): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO financial_alert_logs (student_id, rule_id, channel, status, message, sent_at)
      VALUES (${input.studentId}::uuid, ${input.ruleId}::uuid,
              ${input.channel}::financial_alert_channel, ${input.status}, ${input.message ?? null}, NOW())
    `);
  }

  async listLogs(limit = 100) {
    const result = await this.db.execute<Record<string, string | number>>(sql`
      SELECT l.id::text, l.student_id::text,
             concat_ws(' ', s.first_name, s.last_name) AS student_name,
             r.type::text AS rule_type, l.channel::text, l.status, l.sent_at::text
      FROM financial_alert_logs l
      INNER JOIN students s ON s.id = l.student_id
      INNER JOIN financial_alert_rules r ON r.id = l.rule_id
      ORDER BY l.sent_at DESC LIMIT ${limit}
    `);
    return getRows(result);
  }
}
