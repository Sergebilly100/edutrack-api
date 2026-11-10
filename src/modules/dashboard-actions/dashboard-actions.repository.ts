import { sql } from 'drizzle-orm';

import { BUSINESS_DATE_SQL } from '../../shared/database/business-date.js';
import type { TenantDb } from '../../shared/database/db.js';

type Rows<T> = { rows?: T[] };

const getRows = <T>(result: unknown): T[] => {
  if (typeof result !== 'object' || result === null || !('rows' in result)) {
    return [];
  }
  const rows = (result as Rows<T>).rows;
  return Array.isArray(rows) ? rows : [];
};

export type ActionItemType =
  | 'payment_reminder_needed'
  | 'report_cards_blocked'
  | 'student_at_risk'
  | 'teacher_at_risk'
  | 'dossier_incomplete'
  | 'teacher_absences_high'
  | 'salary_pending'
  | 'validations_pending'
  | 'commission_overdue'
  | 'conduct_decision_pending'
  | 'config_active_year'
  | 'config_school_info'
  | 'config_levels'
  | 'config_subjects'
  | 'config_rooms'
  | 'config_fees'
  | 'config_required_documents'
  | 'config_schedule'
  | 'config_grading_periods'
  | 'config_teachers'
  | 'config_reminder_rules'
  | 'config_risk_rules'
  | 'config_document_identity';

export type ActionItemPriority = 'low' | 'medium' | 'high';

export class DashboardActionsRepository {
  constructor(readonly db: TenantDb) {}

  async listOpen(): Promise<Array<{
    id: string;
    type: string;
    referenceId: string | null;
    priority: string;
    message: string | null;
    generatedAt: string;
  }>> {
    const result = await this.db.execute(sql`
      SELECT id::text, type, reference_id::text, priority::text, message, generated_at::text
      FROM dashboard_action_items
      WHERE resolved_at IS NULL
      ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
               generated_at DESC
      LIMIT 200
    `);
    return getRows<{
      id: string; type: string; reference_id: string | null;
      priority: string; message: string | null; generated_at: string;
    }>(result).map((row) => ({
      id: row.id,
      type: row.type,
      referenceId: row.reference_id,
      priority: row.priority,
      message: row.message,
      generatedAt: row.generated_at,
    }));
  }

  /**
   * Synchronise les items du type avec l'état courant des sources (idempotent, appelable à chaque lecture) :
   * - condition disparue → item ouvert résolu automatiquement, et un rejet manuel antérieur est « oublié »
   *   (resolved_by_user_id remis à NULL, rien n'est supprimé) pour que l'alerte puisse réapparaître plus tard ;
   * - condition toujours vraie → item ouvert mis à jour en place (même id) ;
   * - condition vraie mais alerte écartée par le directeur → rien n'est recréé.
   */
  async replaceType(type: string, items: Array<{ referenceId: string | null; priority: ActionItemPriority; message?: string }>): Promise<void> {
    const keyOf = (referenceId: string | null) => referenceId ?? 'global';
    const keys = items.map((item) => keyOf(item.referenceId));
    const absent = keys.length
      ? sql`COALESCE(reference_id::text, 'global') NOT IN (${sql.join(keys.map((key) => sql`${key}`), sql`, `)})`
      : sql`TRUE`;
    await this.db.execute(sql`
      UPDATE dashboard_action_items SET resolved_at = NOW()
      WHERE type = ${type} AND resolved_at IS NULL AND ${absent}
    `);
    await this.db.execute(sql`
      UPDATE dashboard_action_items SET resolved_by_user_id = NULL
      WHERE type = ${type} AND resolved_by_user_id IS NOT NULL AND ${absent}
    `);
    for (const item of items) {
      const key = keyOf(item.referenceId);
      const updated = await this.db.execute(sql`
        UPDATE dashboard_action_items SET priority = ${item.priority}::dashboard_action_priority, message = ${item.message ?? null}
        WHERE type = ${type} AND resolved_at IS NULL AND COALESCE(reference_id::text, 'global') = ${key}
        RETURNING id::text
      `);
      if (getRows(updated).length > 0) continue;
      const dismissed = await this.db.execute(sql`
        SELECT 1 FROM dashboard_action_items
        WHERE type = ${type} AND resolved_by_user_id IS NOT NULL AND COALESCE(reference_id::text, 'global') = ${key}
        LIMIT 1
      `);
      if (getRows(dismissed).length > 0) continue;
      await this.db.execute(sql`
        INSERT INTO dashboard_action_items (type, reference_id, priority, message)
        VALUES (${type}, ${item.referenceId ?? null}::uuid, ${item.priority}::dashboard_action_priority, ${item.message ?? null})
        ON CONFLICT DO NOTHING
      `);
    }
  }

  async resolve(id: string, userId: string): Promise<boolean> {
    const result = await this.db.execute(sql`
      UPDATE dashboard_action_items
      SET resolved_at = NOW(), resolved_by_user_id = ${userId}::uuid
      WHERE id = ${id}::uuid AND resolved_at IS NULL
      RETURNING id::text
    `);
    return getRows(result).length > 0;
  }

  /** État de configuration non couvert par l'assistant de démarrage (une seule requête, lecture seule). */
  async readConfigState(): Promise<{
    requiredDocuments: boolean; scheduleConfigured: boolean; gradingPeriods: boolean;
    reminderRules: boolean; riskRules: boolean; hasLogo: boolean; hasSeal: boolean;
  }> {
    const result = await this.db.execute<{
      required_documents: boolean; schedule_configured: boolean; grading_periods: boolean;
      reminder_rules: boolean; risk_rules: boolean; has_logo: boolean; has_seal: boolean;
    }>(sql`
      SELECT
        EXISTS (SELECT 1 FROM required_document_types WHERE is_active = true) AS required_documents,
        EXISTS (SELECT 1 FROM schedules s JOIN schedule_periods sp ON sp.id = s.schedule_period_id
                WHERE s.is_active = true AND sp.is_active = true) AS schedule_configured,
        EXISTS (SELECT 1 FROM grading_periods gp JOIN school_years sy ON sy.id = gp.school_year_id
                WHERE sy.status = 'active') AS grading_periods,
        EXISTS (SELECT 1 FROM financial_alert_rules WHERE is_active = true) AS reminder_rules,
        EXISTS (SELECT 1 FROM risk_alert_rules WHERE is_active = true) AS risk_rules,
        COALESCE((SELECT logo_url IS NOT NULL AND logo_url <> '' FROM public.tenants WHERE schema_name = current_schema()), false) AS has_logo,
        COALESCE((SELECT seal_processed_key IS NOT NULL OR (stamp_image_url IS NOT NULL AND stamp_image_url <> '')
                  FROM public.tenants WHERE schema_name = current_schema()), false) AS has_seal
    `);
    const row = getRows<{
      required_documents: boolean; schedule_configured: boolean; grading_periods: boolean;
      reminder_rules: boolean; risk_rules: boolean; has_logo: boolean; has_seal: boolean;
    }>(result)[0];
    return {
      requiredDocuments: row?.required_documents ?? false, scheduleConfigured: row?.schedule_configured ?? false,
      gradingPeriods: row?.grading_periods ?? false, reminderRules: row?.reminder_rules ?? false,
      riskRules: row?.risk_rules ?? false, hasLogo: row?.has_logo ?? false, hasSeal: row?.has_seal ?? false,
    };
  }

  async countRiskByLevel(): Promise<Record<string, number>> {
    const result = await this.db.execute<{ level: string; cnt: number }>(sql`
      SELECT level::text, COUNT(*)::int AS cnt FROM student_risk_status GROUP BY level
    `);
    const out: Record<string, number> = {};
    for (const row of getRows<{ level: string; cnt: number }>(result)) out[row.level] = Number(row.cnt);
    return out;
  }

  async countTeachersAtRisk(): Promise<number> {
    const result = await this.db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM teacher_risk_status trs
      INNER JOIN teachers t ON t.id = trs.teacher_id
      INNER JOIN users u ON u.id = t.user_id AND u.is_active = true
      WHERE (trs.absences_signal = true OR trs.lateness_signal = true) AND t.is_blocked = false
    `);
    return getRows<{ count: number }>(result)[0]?.count ?? 0;
  }

  /**
   * Classes dont les bulletins sont bloqués : matières aux moyennes non validées, uniquement pour les périodes
   * dont la revue est ouverte (comme la page Bulletins) et dont la classe n'est pas déjà clôturée.
   * Une seule ligne par classe : la période la plus récente concernée.
   */
  async listBlockedClasses(limit = 10): Promise<Array<{ classId: string; className: string; periodLabel: string; incomplete: number }>> {
    const result = await this.db.execute<{ class_id: string; class_name: string; period_label: string; incomplete: number }>(sql`
      WITH pending AS (
        SELECT c.id AS class_id, c.name AS class_name, gp.label AS period_label, gp.order_index, COUNT(*)::int AS incomplete
        FROM class_subject_completion csc
        INNER JOIN classes c ON c.id = csc.class_id AND c.is_active = true
        INNER JOIN grading_periods gp ON gp.id = csc.grading_period_id
        WHERE csc.status <> 'completed'
          AND gp.school_year_id = (SELECT id FROM school_years WHERE status = 'active' LIMIT 1)
          AND gp.review_start_date <= ${BUSINESS_DATE_SQL}
          AND NOT EXISTS (
            SELECT 1 FROM grading_period_class_closures closure
            WHERE closure.class_id = c.id AND closure.grading_period_id = gp.id
          )
        GROUP BY c.id, c.name, gp.id, gp.label, gp.order_index
      ),
      latest AS (
        SELECT DISTINCT ON (class_id) class_id, class_name, period_label, incomplete
        FROM pending ORDER BY class_id, order_index DESC
      )
      SELECT class_id::text AS class_id, class_name, period_label, incomplete
      FROM latest ORDER BY incomplete DESC, class_name ASC
      LIMIT ${limit}
    `);
    return getRows<{ class_id: string; class_name: string; period_label: string; incomplete: number }>(result).map((row) => ({
      classId: row.class_id,
      className: row.class_name,
      periodLabel: row.period_label,
      incomplete: Number(row.incomplete),
    }));
  }
}
