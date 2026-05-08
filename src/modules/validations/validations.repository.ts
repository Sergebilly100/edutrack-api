import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { QueryResult, QueryResultRow } from 'pg';

import { ensureTenantRealHoursInfrastructure } from '../../shared/database/real-hours-infrastructure.js';
import type {
  PendingValidationCount,
  PendingValidationGroups,
  PendingValidationItem,
  ValidationKind,
} from './validations.types.js';

export type QueryExecutor = NodePgDatabase<Record<string, unknown>>;

type PendingValidationRow = {
  attendance_id: string;
  teacher_id: string;
  teacher_user_id: string;
  teacher_name: string;
  teacher_phone: string | null;
  teacher_email: string | null;
  course_name: string;
  class_name: string;
  date: string;
  checked_in_at: string | null;
  checked_out_at: string | null;
  geo_status: 'verified' | 'suspicious' | 'unavailable' | 'not_checked' | null;
  checkin_distance: string | number | null;
  actual_minutes: number | null;
  schedule_duration_minutes: string | number;
  validation_reason: string | null;
  hourly_rate: number | null;
  kind: ValidationKind;
};

type AttendanceValidationContextRow = PendingValidationRow & {
  period_month: string;
};

const getRows = <TRow extends QueryResultRow>(result: QueryResult<TRow>): TRow[] => result.rows;

const toNumber = (value: string | number | null): number | null => {
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const monthBoundsFromDate = (date: string): { monthStart: string; monthEnd: string } => {
  const monthStart = `${date.slice(0, 7)}-01`;
  const [yearRaw, monthRaw] = date.slice(0, 7).split('-');
  const m = Number(monthRaw);
  const y = Number(yearRaw);
  const end = new Date(Date.UTC(
    m === 12 ? y + 1 : y,
    m === 12 ? 0 : m,
    0
  ));
  return { monthStart, monthEnd: end.toISOString().slice(0, 10) };
};

const mapPendingRow = (row: PendingValidationRow): PendingValidationItem => ({
  attendanceId: row.attendance_id,
  teacherId: row.teacher_id,
  teacherName: row.teacher_name,
  courseName: row.course_name,
  className: row.class_name,
  date: row.date,
  checkedInAt: row.checked_in_at,
  checkedOutAt: row.checked_out_at,
  geoStatus: row.geo_status,
  checkinDistance: toNumber(row.checkin_distance),
  actualMinutes: row.actual_minutes,
  scheduleDurationMinutes: toNumber(row.schedule_duration_minutes) ?? 0,
  validationReason: row.validation_reason,
  hourlyRate: row.hourly_rate,
  kind: row.kind,
});

export class ValidationsRepository {
  constructor(private readonly db: QueryExecutor) {}

  async listPending(): Promise<PendingValidationGroups> {
    await ensureTenantRealHoursInfrastructure(this.db);

    const result = await this.db.execute<PendingValidationRow>(sql`
      WITH feature_flags AS (
        SELECT COALESCE(f.checkout_tolerance_minutes, 5)::int AS checkout_tolerance_minutes
        FROM public.tenants t
        LEFT JOIN public.school_sms_features f ON f.tenant_id = t.id
        WHERE t.schema_name = current_schema()
        LIMIT 1
      )
      SELECT
        at.id::text AS attendance_id,
        t.id::text AS teacher_id,
        u.id::text AS teacher_user_id,
        u.name AS teacher_name,
        u.phone AS teacher_phone,
        u.email AS teacher_email,
        s.subject AS course_name,
        c.name AS class_name,
        at.date::text AS date,
        at.checked_in_at::text AS checked_in_at,
        at.checked_out_at::text AS checked_out_at,
        at.geo_status,
        at.checkin_distance,
        at.actual_minutes,
        (EXTRACT(EPOCH FROM (ts.end_time - ts.start_time)) / 60.0)::numeric(8,2) AS schedule_duration_minutes,
        at.validation_reason,
        t.hourly_rate,
        CASE
          WHEN at.geo_status = 'suspicious' THEN 'gps_suspicious'
          ELSE 'short_hours'
        END AS kind
      FROM attendances_teacher at
      INNER JOIN teachers t ON t.id = at.teacher_id
      INNER JOIN users u ON u.id = t.user_id
      INNER JOIN schedules s ON s.id = at.schedule_id
      INNER JOIN classes c ON c.id = s.class_id
      INNER JOIN time_slots ts ON ts.id = s.time_slot_id
      WHERE at.validation_status = 'pending'
        AND (
          at.geo_status = 'suspicious'
          OR (
            at.actual_minutes IS NOT NULL
            AND at.actual_minutes < ((EXTRACT(EPOCH FROM (ts.end_time - ts.start_time)) / 60.0) - (SELECT checkout_tolerance_minutes FROM feature_flags))
          )
        )
      ORDER BY at.date DESC, at.checked_in_at DESC NULLS LAST, u.name ASC
    `);

    return getRows(result).reduce<PendingValidationGroups>(
      (groups, row) => {
        groups[row.kind].push(mapPendingRow(row));
        return groups;
      },
      { gps_suspicious: [], short_hours: [] }
    );
  }

  async countPending(): Promise<PendingValidationCount> {
    const groups = await this.listPending();
    const gps = groups.gps_suspicious.length;
    const short = groups.short_hours.length;
    return { gps_suspicious: gps, short_hours: short, total: gps + short };
  }

  async findValidationContext(attendanceId: string): Promise<AttendanceValidationContextRow | null> {
    await ensureTenantRealHoursInfrastructure(this.db);

    const result = await this.db.execute<AttendanceValidationContextRow>(sql`
      SELECT
        at.id::text AS attendance_id,
        t.id::text AS teacher_id,
        u.id::text AS teacher_user_id,
        u.name AS teacher_name,
        u.phone AS teacher_phone,
        u.email AS teacher_email,
        s.subject AS course_name,
        c.name AS class_name,
        at.date::text AS date,
        at.checked_in_at::text AS checked_in_at,
        at.checked_out_at::text AS checked_out_at,
        at.geo_status,
        at.checkin_distance,
        at.actual_minutes,
        (EXTRACT(EPOCH FROM (ts.end_time - ts.start_time)) / 60.0)::numeric(8,2) AS schedule_duration_minutes,
        at.validation_reason,
        t.hourly_rate,
        CASE WHEN at.geo_status = 'suspicious' THEN 'gps_suspicious' ELSE 'short_hours' END AS kind,
        DATE_TRUNC('month', at.date)::date::text AS period_month
      FROM attendances_teacher at
      INNER JOIN teachers t ON t.id = at.teacher_id
      INNER JOIN users u ON u.id = t.user_id
      INNER JOIN schedules s ON s.id = at.schedule_id
      INNER JOIN classes c ON c.id = s.class_id
      INNER JOIN time_slots ts ON ts.id = s.time_slot_id
      WHERE at.id = ${attendanceId}
      LIMIT 1
    `);

    return getRows(result)[0] ?? null;
  }

  async approve(params: {
    attendanceId: string;
    validatedHours: number;
    validatedBy: string;
  }): Promise<void> {
    await this.db.execute(sql`
      UPDATE attendances_teacher
      SET
        validation_status = 'approved',
        validated_hours = ${params.validatedHours}::numeric,
        validation_reason = NULL,
        validated_by = ${params.validatedBy}::uuid,
        validated_at = NOW()
      WHERE id = ${params.attendanceId}
    `);
  }

  async reject(params: {
    attendanceId: string;
    reason: string;
    validatedBy: string;
  }): Promise<void> {
    await this.db.execute(sql`
      UPDATE attendances_teacher
      SET
        validation_status = 'rejected',
        validated_hours = 0,
        validation_reason = ${params.reason},
        validated_by = ${params.validatedBy}::uuid,
        validated_at = NOW(),
        status = 'absent'::attendance_teacher_status
      WHERE id = ${params.attendanceId}
    `);
  }

  async insertRejectedTeacherNotification(params: {
    context: AttendanceValidationContextRow;
    reason: string;
    validatedBy: string;
  }): Promise<void> {
    const message = `Votre présence pour ${params.context.course_name} du ${params.context.date} n'a pas pu être validée. Motif : ${params.reason}`;
    await this.db.execute(sql`
      INSERT INTO notifications_log (
        type,
        channel,
        recipient_id,
        recipient_phone,
        recipient_email,
        message,
        status,
        related_id,
        metadata
      )
      VALUES (
        'attendance_rejected',
        'email',
        ${params.context.teacher_user_id}::uuid,
        ${params.context.teacher_phone ?? ''},
        ${params.context.teacher_email ?? null},
        ${message},
        'queued',
        ${params.context.attendance_id}::uuid,
        ${JSON.stringify({
          courseName: params.context.course_name,
          date: params.context.date,
          reason: params.reason,
          validatedBy: params.validatedBy,
        })}::jsonb
      )
    `);
  }

  async auditValidation(params: {
    schemaName: string;
    actorId: string;
    actorRole: string;
    action: 'attendance_validation_approved' | 'attendance_validation_rejected';
    before: AttendanceValidationContextRow;
    after: Record<string, unknown>;
  }): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO public.audit_financial_events (
        tenant_id,
        actor_id,
        actor_role,
        action,
        payload_before,
        payload_after
      )
      SELECT
        t.id,
        ${params.actorId}::uuid,
        ${params.actorRole},
        ${params.action},
        ${JSON.stringify(params.before)}::jsonb,
        ${JSON.stringify(params.after)}::jsonb
      FROM public.tenants t
      WHERE t.schema_name = ${params.schemaName}
      LIMIT 1
    `);
  }

  async recomputeTeacherSalaryForMonth(params: {
    teacherId: string;
    monthStart: string;
    monthEnd: string;
  }): Promise<void> {
    await ensureTenantRealHoursInfrastructure(this.db);

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
                WHEN at.validation_status IN ('pending', 'rejected') THEN 0
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
        WHERE at.teacher_id = ${params.teacherId}
          AND at.date BETWEEN ${params.monthStart}::date AND ${params.monthEnd}::date
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
        END
      FROM totals, teachers t
      WHERE sr.teacher_id = ${params.teacherId}
        AND sr.period_month = ${params.monthStart}::date
        AND t.id = sr.teacher_id
    `);
  }

  async recomputeForAttendanceDate(teacherId: string, date: string): Promise<void> {
    const { monthStart, monthEnd } = monthBoundsFromDate(date);
    await this.recomputeTeacherSalaryForMonth({ teacherId, monthStart, monthEnd });
  }
}

export const buildValidationsRepository = (
  db: ConstructorParameters<typeof ValidationsRepository>[0]
): ValidationsRepository => new ValidationsRepository(db);
