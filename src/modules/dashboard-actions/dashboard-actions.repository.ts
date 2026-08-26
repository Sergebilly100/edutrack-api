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

export type ActionItemType =
  | 'payment_reminder_needed'
  | 'report_cards_blocked'
  | 'student_at_risk'
  | 'teacher_at_risk'
  | 'dossier_incomplete'
  | 'teacher_absences_high'
  | 'salary_pending'
  | 'validations_pending'
  | 'commission_overdue';

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
   * Remplace l'ensemble des items ouverts du type : les conditions sources qui
   * ont disparu sont automatiquement résolues, puis on insère le nouvel état.
   */
  async replaceType(type: string, items: Array<{ referenceId: string | null; priority: ActionItemPriority; message?: string }>): Promise<void> {
    await this.db.execute(sql`
      UPDATE dashboard_action_items
      SET resolved_at = NOW()
      WHERE type = ${type} AND resolved_at IS NULL
    `);
    for (const item of items) {
      await this.db.execute(sql`
        INSERT INTO dashboard_action_items (type, reference_id, priority, message)
        VALUES (${type}, ${item.referenceId ?? null}::uuid, ${item.priority}::dashboard_action_priority, ${item.message ?? null})
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

  async countRiskByLevel(): Promise<Record<string, number>> {
    const result = await this.db.execute<{ level: string; cnt: number }>(sql`
      SELECT level::text, COUNT(*)::int AS cnt FROM student_risk_status GROUP BY level
    `);
    const out: Record<string, number> = {};
    for (const row of getRows<{ level: string; cnt: number }>(result)) out[row.level] = Number(row.cnt);
    return out;
  }

  async listBlockedClasses(limit = 10): Promise<Array<{ classId: string; className: string; incomplete: number }>> {
    const result = await this.db.execute<{ class_id: string; class_name: string; incomplete: number }>(sql`
      SELECT c.id::text AS class_id, c.name AS class_name, COUNT(*)::int AS incomplete
      FROM class_subject_completion csc
      INNER JOIN classes c ON c.id = csc.class_id AND c.is_active = true
      WHERE csc.status <> 'completed'
        AND csc.grading_period_id IN (SELECT id FROM grading_periods WHERE school_year_id = (SELECT id FROM school_years WHERE status='active' LIMIT 1))
      GROUP BY c.id, c.name
      HAVING COUNT(*) >= 1
      ORDER BY incomplete DESC
      LIMIT ${limit}
    `);
    return getRows<{
      class_id: string; class_name: string; incomplete: number;
    }>(result).map((row) => ({
      classId: row.class_id,
      className: row.class_name,
      incomplete: Number(row.incomplete),
    }));
  }
}
