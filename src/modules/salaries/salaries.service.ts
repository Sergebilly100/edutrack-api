import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { monthBoundsFromDate } from '../../shared/utils/date.js';
import { getRowsUntyped as getRows } from '../../shared/utils/db-helpers.js';
import { on } from '../../shared/events/event-bus.js';
import { withTenantSchema } from '../../shared/database/db.js';

type QueryExecutor = NodePgDatabase<Record<string, unknown>>;

export class SalariesModuleError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string
  ) {
    super(message);
    this.name = 'SalariesModuleError';
  }
}

export class SalariesService {
  constructor(private readonly db: QueryExecutor) {}

  /**
   * Recalcule le salary_record d'un prof pour un mois en lisant l'état courant
   * de attendances_teacher, y compris end_scan_action_cancelled_at.
   *
   * Ce recalcul repart des données brutes — il ne persiste pas de snapshot :
   * - Si une sanction a été annulée (end_scan_action_cancelled_at IS NOT NULL),
   *   la session est réintégrée au calcul.
   * - Si validation_status = 'approved', validated_hours est utilisé tel quel.
   * - Si validation_status = 'rejected', 0 heures comptabilisées.
   */
  async recalculateForTeacherMonth(params: {
    teacherId: string;
    month: string;
  }): Promise<{ updated: boolean }> {

    const { monthStart, monthEnd } = monthBoundsFromDate(`${params.month}-01`);

    // Vérifier que le teacher existe
    const teacherResult = await this.db.execute<{ id: string }>(sql`
      SELECT id::text FROM teachers WHERE id = ${params.teacherId}::uuid LIMIT 1
    `);
    if (getRows<{ id: string }>(teacherResult).length === 0) {
      throw new SalariesModuleError('Teacher not found', 404, 'TEACHER_NOT_FOUND');
    }

    // Vérifier que le salary_record existe pour ce mois
    const recordResult = await this.db.execute<{ id: string }>(sql`
      SELECT id::text FROM salary_records
      WHERE teacher_id = ${params.teacherId}::uuid
        AND period_month = ${monthStart}::date
      LIMIT 1
    `);
    if (getRows<{ id: string }>(recordResult).length === 0) {
      throw new SalariesModuleError('Salary record not found for this period', 404, 'SALARY_RECORD_NOT_FOUND');
    }

    await this.db.execute(sql`
      WITH feature_flags AS (
        SELECT COALESCE(f.use_real_hours, false) AS use_real_hours
        FROM public.tenants t
        LEFT JOIN public.school_sms_features f ON f.tenant_id = t.id
        WHERE t.schema_name = current_schema()
        LIMIT 1
      ),
      totals AS (
        SELECT
          COALESCE(
            SUM(
              CASE
                WHEN at.validation_status = 'approved' THEN COALESCE(at.validated_hours, 0)
                WHEN at.validation_status = 'rejected' THEN 0
                WHEN COALESCE((SELECT use_real_hours FROM feature_flags), false)
                  AND at.actual_minutes IS NOT NULL
                  THEN at.actual_minutes / 60.0
                ELSE EXTRACT(EPOCH FROM (ts.end_time - ts.start_time)) / 3600.0
              END
            ),
            0
          )::numeric(8,2) AS hours_done
        FROM attendances_teacher at
        INNER JOIN schedules s ON s.id = at.schedule_id
        INNER JOIN time_slots ts ON ts.id = s.time_slot_id
        WHERE at.teacher_id = ${params.teacherId}::uuid
          AND at.date BETWEEN ${monthStart}::date AND ${monthEnd}::date
          AND at.status IN ('present', 'late', 'excused')
      )
      UPDATE salary_records sr
      SET
        hours_done = totals.hours_done,
        total_fcfa = CASE
          WHEN t.type = 'permanent' THEN COALESCE(t.monthly_salary, sr.total_fcfa)
          ELSE ROUND(totals.hours_done * sr.hourly_rate)::int
        END,
        status = CASE
          WHEN sr.status = 'disputed' THEN sr.status
          WHEN t.type = 'vacataire' AND totals.hours_done <= 0 THEN 'nothing_to_pay'::salary_status
          ELSE 'pending'::salary_status
        END,
        updated_at = NOW()
      FROM totals, teachers t
      WHERE sr.teacher_id = ${params.teacherId}::uuid
        AND sr.period_month = ${monthStart}::date
        AND t.id = sr.teacher_id
    `);

    return { updated: true };
  }

  /**
   * Recalcule tous les salary_records d'un mois pour l'ensemble des profs.
   * Utile après une annulation groupée de sanctions ou une correction de données.
   */
  async recalculateAllForMonth(params: {
    month: string;
  }): Promise<{ updatedCount: number }> {

    const { monthStart, monthEnd } = monthBoundsFromDate(`${params.month}-01`);

    const result = await this.db.execute<{ teacher_id: string }>(sql`
      SELECT teacher_id::text FROM salary_records
      WHERE period_month = ${monthStart}::date
    `);

    const teacherIds = getRows<{ teacher_id: string }>(result).map((r) => r.teacher_id);
    if (teacherIds.length === 0) {
      return { updatedCount: 0 };
    }

    await this.db.execute(sql`
      WITH feature_flags AS (
        SELECT COALESCE(f.use_real_hours, false) AS use_real_hours
        FROM public.tenants t
        LEFT JOIN public.school_sms_features f ON f.tenant_id = t.id
        WHERE t.schema_name = current_schema()
        LIMIT 1
      ),
      totals AS (
        SELECT
          at.teacher_id,
          COALESCE(
            SUM(
              CASE
                WHEN at.validation_status = 'approved' THEN COALESCE(at.validated_hours, 0)
                WHEN at.validation_status = 'rejected' THEN 0
                WHEN COALESCE((SELECT use_real_hours FROM feature_flags), false)
                  AND at.actual_minutes IS NOT NULL
                  THEN at.actual_minutes / 60.0
                ELSE EXTRACT(EPOCH FROM (ts.end_time - ts.start_time)) / 3600.0
              END
            ),
            0
          )::numeric(8,2) AS hours_done
        FROM attendances_teacher at
        INNER JOIN schedules s ON s.id = at.schedule_id
        INNER JOIN time_slots ts ON ts.id = s.time_slot_id
        WHERE at.date BETWEEN ${monthStart}::date AND ${monthEnd}::date
          AND at.status IN ('present', 'late', 'excused')
        GROUP BY at.teacher_id
      )
      UPDATE salary_records sr
      SET
        hours_done = COALESCE(totals.hours_done, 0),
        total_fcfa = CASE
          WHEN t.type = 'permanent' THEN COALESCE(t.monthly_salary, sr.total_fcfa)
          ELSE ROUND(COALESCE(totals.hours_done, 0) * sr.hourly_rate)::int
        END,
        status = CASE
          WHEN sr.status = 'disputed' THEN sr.status
          WHEN t.type = 'vacataire' AND COALESCE(totals.hours_done, 0) <= 0 THEN 'nothing_to_pay'::salary_status
          ELSE 'pending'::salary_status
        END,
        updated_at = NOW()
      FROM teachers t
      LEFT JOIN totals ON totals.teacher_id = sr.teacher_id
      WHERE sr.period_month = ${monthStart}::date
        AND t.id = sr.teacher_id
    `);

    return { updatedCount: teacherIds.length };
  }
}

export const buildSalariesService = (db: QueryExecutor): SalariesService =>
  new SalariesService(db);

export const registerSalaryEventListeners = (): void => {
  on('teacher.checkout_completed', (payload) => {
    void withTenantSchema(payload.schemaName, async (tenantDb) => {
      const service = buildSalariesService(tenantDb);
      await service.recalculateForTeacherMonth({
        teacherId: payload.teacherId,
        month: payload.monthStart.slice(0, 7),
      });
    });
  });

  // Après chaque paiement de salaire (online ou sync offline), recalculer
  // le salary_record pour intégrer les modifications d'attendance intervenues
  // entre la dernière compute et le paiement (validations, sanctions, annulations).
  on('salary.payment_recorded', (payload) => {
    void withTenantSchema(payload.schemaName, async (tenantDb) => {
      const service = buildSalariesService(tenantDb);
      try {
        await service.recalculateForTeacherMonth({
          teacherId: payload.teacherId,
          month: payload.periodMonth,
        });
      } catch (error) {
        if (error instanceof SalariesModuleError && error.code === 'SALARY_RECORD_NOT_FOUND') {
          return;
        }
        throw error;
      }
    });
  });
};
