import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { QueryResult, QueryResultRow } from 'pg';

import type {
  EndScanAction,
  MissingEndScanTeacher,
  PendingValidationCount,
  PendingValidationGroups,
  PendingValidationItem,
  TeacherNotificationItem,
  ValidationHistoryPage,
  ValidationKind,
} from './validations.types.js';

import { formatDecimalHours } from "../../shared/utils/time.js";

export type QueryExecutor = NodePgDatabase<Record<string, unknown>>;

type TransactionCallback<T> = (tx: QueryExecutor) => Promise<T>;

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
  /** Tableau Postgres des critères déclenchés (peut contenir plusieurs valeurs). */
  kinds: ValidationKind[] | null;
  slot_label: string | null;
  room_name: string | null;
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
  kinds: row.kinds && row.kinds.length > 0 ? row.kinds : [row.kind],
  slotLabel: row.slot_label ?? null,
  roomName: row.room_name ?? null,
});

export class ValidationsRepository {
  constructor(private readonly db: QueryExecutor) {}

  transaction<T>(callback: TransactionCallback<T>): Promise<T> {
    return this.db.transaction(callback);
  }

  async listPending(): Promise<PendingValidationGroups> {

    const result = await this.db.execute<PendingValidationRow>(sql`
      WITH feature_flags AS (
        SELECT
          COALESCE(f.use_real_hours, false) AS use_real_hours,
          COALESCE(f.checkout_tolerance_minutes, 5)::int AS checkout_tolerance_minutes
        FROM public.tenants t
        LEFT JOIN public.school_sms_features f ON f.tenant_id = t.id
        WHERE t.schema_name = current_schema()
        LIMIT 1
      ),
      base AS (
        SELECT
          at.id AS attendance_id,
          t.id AS teacher_id,
          u.id AS teacher_user_id,
          u.name AS teacher_name,
          u.phone AS teacher_phone,
          u.email AS teacher_email,
          s.subject AS course_name,
          c.name AS class_name,
          at.date,
          at.checked_in_at,
          at.checked_out_at,
          at.geo_status,
          at.checkin_distance,
          COALESCE(
            at.actual_minutes,
            CASE
              WHEN COALESCE((SELECT use_real_hours FROM feature_flags), false)
                AND at.checked_in_at IS NOT NULL
                AND at.room_scan_end_at IS NOT NULL
              THEN GREATEST(
                0,
                FLOOR(
                  EXTRACT(EPOCH FROM (
                    LEAST(at.room_scan_end_at, at.date::timestamp + ts.end_time) - at.checked_in_at
                  )) / 60
                )
              )::int
              ELSE NULL
            END
          ) AS actual_minutes,
          COALESCE(
            at.actual_minutes,
            CASE
              WHEN COALESCE((SELECT use_real_hours FROM feature_flags), false)
                AND at.checked_in_at IS NOT NULL
                AND at.room_scan_end_at IS NOT NULL
              THEN GREATEST(
                0,
                FLOOR(
                  EXTRACT(EPOCH FROM (
                    LEAST(at.room_scan_end_at, at.date::timestamp + ts.end_time) - (at.date::timestamp + ts.start_time)
                  )) / 60
                )
              )::int
              ELSE NULL
            END
          ) AS validation_minutes,
          (EXTRACT(EPOCH FROM (ts.end_time - ts.start_time)) / 60.0)::numeric(8,2) AS schedule_duration_minutes,
          at.validation_reason,
          at.validation_status,
          (at.actual_minutes IS NULL) AS needs_derived_duration,
          (at.validated_hours IS NULL) AS lacks_validated_hours,
          t.hourly_rate,
          ts.label AS slot_label,
          r.name AS room_name,
          (at.geo_status = 'suspicious') AS is_gps_suspicious,
          (
            COALESCE(
              at.actual_minutes,
              CASE
                WHEN COALESCE((SELECT use_real_hours FROM feature_flags), false)
                  AND at.checked_in_at IS NOT NULL
                  AND at.room_scan_end_at IS NOT NULL
                THEN GREATEST(
                  0,
                  FLOOR(
                    EXTRACT(EPOCH FROM (
                      LEAST(at.room_scan_end_at, at.date::timestamp + ts.end_time) - (at.date::timestamp + ts.start_time)
                    )) / 60
                  )
                )::int
                ELSE NULL
              END
            ) IS NOT NULL
            AND COALESCE(
              at.actual_minutes,
              CASE
                WHEN COALESCE((SELECT use_real_hours FROM feature_flags), false)
                  AND at.checked_in_at IS NOT NULL
                  AND at.room_scan_end_at IS NOT NULL
                THEN GREATEST(
                  0,
                  FLOOR(
                    EXTRACT(EPOCH FROM (
                      LEAST(at.room_scan_end_at, at.date::timestamp + ts.end_time) - (at.date::timestamp + ts.start_time)
                    )) / 60
                  )
                )::int
                ELSE NULL
              END
            ) < ((EXTRACT(EPOCH FROM (ts.end_time - ts.start_time)) / 60.0) - (SELECT checkout_tolerance_minutes FROM feature_flags))
          ) AS is_short_hours
        FROM attendances_teacher at
        INNER JOIN teachers t ON t.id = at.teacher_id
        INNER JOIN users u ON u.id = t.user_id
        INNER JOIN schedules s ON s.id = at.schedule_id
        INNER JOIN classes c ON c.id = s.class_id
        INNER JOIN time_slots ts ON ts.id = s.time_slot_id
        LEFT JOIN rooms r ON r.id = s.room_id
        WHERE at.validation_status NOT IN ('approved', 'rejected')
          AND at.status IN ('present', 'late', 'excused')
          AND NOT EXISTS (
            SELECT 1 FROM schedule_exceptions se
            WHERE se.schedule_id = s.id AND se.exception_date = at.date
          )
      )
      SELECT
        attendance_id::text AS attendance_id,
        teacher_id::text AS teacher_id,
        teacher_user_id::text AS teacher_user_id,
        teacher_name,
        teacher_phone,
        teacher_email,
        course_name,
        class_name,
        date::text AS date,
        checked_in_at::text AS checked_in_at,
        checked_out_at::text AS checked_out_at,
        geo_status,
        checkin_distance,
        actual_minutes,
        schedule_duration_minutes,
        validation_reason,
        hourly_rate,
        -- Onglet primaire : short_hours quand le motif "heures" est présent
        -- (le directeur doit saisir validated_hours), sinon gps_suspicious.
        CASE WHEN is_short_hours THEN 'short_hours' ELSE 'gps_suspicious' END AS kind,
        ARRAY_REMOVE(ARRAY[
          CASE WHEN is_short_hours THEN 'short_hours'::text END,
          CASE WHEN is_gps_suspicious THEN 'gps_suspicious'::text END
        ], NULL) AS kinds,
        slot_label,
        room_name
      FROM base
      WHERE (validation_status = 'pending' AND (is_gps_suspicious OR is_short_hours))
        OR (
          validation_status <> 'pending'
          AND lacks_validated_hours
          AND needs_derived_duration
          AND is_short_hours
        )
      ORDER BY date DESC, checked_in_at DESC NULLS LAST, teacher_name ASC
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

    type CountRow = { kind: ValidationKind | 'missing_end_scan'; cnt: string };
    const result = await this.db.execute<CountRow>(sql`
      WITH feature_flags AS (
        SELECT
          COALESCE(f.use_real_hours, false) AS use_real_hours,
          COALESCE(f.checkout_tolerance_minutes, 5)::int AS checkout_tolerance_minutes
        FROM public.tenants t
        LEFT JOIN public.school_sms_features f ON f.tenant_id = t.id
        WHERE t.schema_name = current_schema()
        LIMIT 1
      ),
      pending_base AS (
        SELECT
          at.validation_status,
          (at.actual_minutes IS NULL) AS needs_derived_duration,
          (at.validated_hours IS NULL) AS lacks_validated_hours,
          (at.geo_status = 'suspicious') AS is_gps_suspicious,
          (
            COALESCE(
              at.actual_minutes,
              CASE
                WHEN COALESCE((SELECT use_real_hours FROM feature_flags), false)
                  AND at.checked_in_at IS NOT NULL
                  AND at.room_scan_end_at IS NOT NULL
                THEN GREATEST(
                  0,
                  FLOOR(
                    EXTRACT(EPOCH FROM (
                      LEAST(at.room_scan_end_at, at.date::timestamp + ts.end_time) - (at.date::timestamp + ts.start_time)
                    )) / 60
                  )
                )::int
                ELSE NULL
              END
            ) IS NOT NULL
            AND COALESCE(
              at.actual_minutes,
              CASE
                WHEN COALESCE((SELECT use_real_hours FROM feature_flags), false)
                  AND at.checked_in_at IS NOT NULL
                  AND at.room_scan_end_at IS NOT NULL
                THEN GREATEST(
                  0,
                  FLOOR(
                    EXTRACT(EPOCH FROM (
                      LEAST(at.room_scan_end_at, at.date::timestamp + ts.end_time) - (at.date::timestamp + ts.start_time)
                    )) / 60
                  )
                )::int
                ELSE NULL
              END
            ) < ((EXTRACT(EPOCH FROM (ts.end_time - ts.start_time)) / 60.0) - (SELECT checkout_tolerance_minutes FROM feature_flags))
          ) AS is_short_hours
        FROM attendances_teacher at
        INNER JOIN schedules s ON s.id = at.schedule_id
        INNER JOIN time_slots ts ON ts.id = s.time_slot_id
        WHERE at.validation_status NOT IN ('approved', 'rejected')
          AND at.status IN ('present', 'late', 'excused')
          AND NOT EXISTS (
            SELECT 1 FROM schedule_exceptions se
            WHERE se.schedule_id = s.id AND se.exception_date = at.date
          )
      )
      -- Onglet primaire identique à listPending : short_hours prioritaire si déclenché,
      -- sinon gps_suspicious. Garantit qu'un cours multi-critères n'est compté qu'une fois.
      SELECT
        CASE WHEN is_short_hours THEN 'short_hours' ELSE 'gps_suspicious' END AS kind,
        COUNT(*)::text AS cnt
      FROM pending_base
      WHERE (validation_status = 'pending' AND (is_gps_suspicious OR is_short_hours))
        OR (
          validation_status <> 'pending'
          AND lacks_validated_hours
          AND needs_derived_duration
          AND is_short_hours
        )
      GROUP BY 1
      UNION ALL
      SELECT
        'missing_end_scan' AS kind,
        COUNT(*)::text AS cnt
      FROM attendances_teacher at
      INNER JOIN schedules s ON s.id = at.schedule_id
      INNER JOIN time_slots ts ON ts.id = s.time_slot_id
      WHERE at.checked_in_at IS NOT NULL
        AND at.checked_out_at IS NULL
        AND at.room_scan_end_at IS NULL
        AND at.validation_status NOT IN ('approved', 'rejected')
        -- Une session est "traitée" dès qu'une action scan-de-fin active y est appliquée
        -- (tolérée/sanctionnée et non annulée). On l'exclut du compteur pour qu'il
        -- retombe à 0 quand tous les cas sont traités, cohérent avec countEligibleSessions
        -- côté frontend. Les actions annulées (cancelled_at NOT NULL) restent comptées.
        AND (at.end_scan_action IS NULL OR at.end_scan_action_cancelled_at IS NOT NULL)
        AND at.date <= (NOW() AT TIME ZONE 'Africa/Abidjan')::date
        AND (
          at.date < (NOW() AT TIME ZONE 'Africa/Abidjan')::date
          OR (NOW() AT TIME ZONE 'Africa/Abidjan') > (at.date::timestamp + ts.end_time + INTERVAL '30 minutes')
        )
    `);

    let gps = 0;
    let short = 0;
    let missingEndScan = 0;
    for (const row of getRows(result)) {
      if (row.kind === 'gps_suspicious') gps = Number(row.cnt);
      else if (row.kind === 'short_hours') short = Number(row.cnt);
      else if (row.kind === 'missing_end_scan') missingEndScan = Number(row.cnt);
    }
    return { gps_suspicious: gps, short_hours: short, missing_end_scan: missingEndScan, total: gps + short + missingEndScan };
  }

  async findValidationContext(attendanceId: string, tx?: QueryExecutor): Promise<AttendanceValidationContextRow | null> {
    const db = tx ?? this.db;

    const result = await db.execute<AttendanceValidationContextRow>(sql`
      WITH feature_flags AS (
        SELECT
          COALESCE(f.use_real_hours, false) AS use_real_hours,
          COALESCE(f.checkout_tolerance_minutes, 5)::int AS checkout_tolerance_minutes
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
        COALESCE(
          at.actual_minutes,
          CASE
            WHEN COALESCE((SELECT use_real_hours FROM feature_flags), false)
              AND at.checked_in_at IS NOT NULL
              AND at.room_scan_end_at IS NOT NULL
            THEN GREATEST(
              0,
              FLOOR(
                EXTRACT(EPOCH FROM (
                  LEAST(at.room_scan_end_at, at.date::timestamp + ts.end_time) - at.checked_in_at
                )) / 60
              )
            )::int
            ELSE NULL
          END
        ) AS actual_minutes,
        (EXTRACT(EPOCH FROM (ts.end_time - ts.start_time)) / 60.0)::numeric(8,2) AS schedule_duration_minutes,
        at.validation_reason,
        t.hourly_rate,
        CASE
          WHEN COALESCE(
            at.actual_minutes,
            CASE
              WHEN COALESCE((SELECT use_real_hours FROM feature_flags), false)
                AND at.checked_in_at IS NOT NULL
                AND at.room_scan_end_at IS NOT NULL
              THEN GREATEST(
                0,
                FLOOR(
                  EXTRACT(EPOCH FROM (
                    LEAST(at.room_scan_end_at, at.date::timestamp + ts.end_time) - (at.date::timestamp + ts.start_time)
                  )) / 60
                )
              )::int
              ELSE NULL
            END
          ) IS NOT NULL
            AND COALESCE(
              at.actual_minutes,
              CASE
                WHEN COALESCE((SELECT use_real_hours FROM feature_flags), false)
                  AND at.checked_in_at IS NOT NULL
                  AND at.room_scan_end_at IS NOT NULL
                THEN GREATEST(
                  0,
                  FLOOR(
                    EXTRACT(EPOCH FROM (
                      LEAST(at.room_scan_end_at, at.date::timestamp + ts.end_time) - (at.date::timestamp + ts.start_time)
                    )) / 60
                  )
                )::int
                ELSE NULL
              END
            ) < ((EXTRACT(EPOCH FROM (ts.end_time - ts.start_time)) / 60.0) - (SELECT checkout_tolerance_minutes FROM feature_flags))
          THEN 'short_hours'
          ELSE 'gps_suspicious'
        END AS kind,
        ARRAY_REMOVE(ARRAY[
          CASE
            WHEN COALESCE(
              at.actual_minutes,
              CASE
                WHEN COALESCE((SELECT use_real_hours FROM feature_flags), false)
                  AND at.checked_in_at IS NOT NULL
                  AND at.room_scan_end_at IS NOT NULL
                THEN GREATEST(
                  0,
                  FLOOR(
                    EXTRACT(EPOCH FROM (
                      LEAST(at.room_scan_end_at, at.date::timestamp + ts.end_time) - (at.date::timestamp + ts.start_time)
                    )) / 60
                  )
                )::int
                ELSE NULL
              END
            ) IS NOT NULL
              AND COALESCE(
                at.actual_minutes,
                CASE
                  WHEN COALESCE((SELECT use_real_hours FROM feature_flags), false)
                    AND at.checked_in_at IS NOT NULL
                    AND at.room_scan_end_at IS NOT NULL
                  THEN GREATEST(
                    0,
                    FLOOR(
                      EXTRACT(EPOCH FROM (
                        LEAST(at.room_scan_end_at, at.date::timestamp + ts.end_time) - (at.date::timestamp + ts.start_time)
                      )) / 60
                    )
                  )::int
                  ELSE NULL
                END
              ) < ((EXTRACT(EPOCH FROM (ts.end_time - ts.start_time)) / 60.0) - (SELECT checkout_tolerance_minutes FROM feature_flags))
            THEN 'short_hours'::text
          END,
          CASE WHEN at.geo_status = 'suspicious' THEN 'gps_suspicious'::text END
        ], NULL) AS kinds,
        DATE_TRUNC('month', at.date)::date::text AS period_month,
        ts.label AS slot_label,
        r.name AS room_name
      FROM attendances_teacher at
      INNER JOIN teachers t ON t.id = at.teacher_id
      INNER JOIN users u ON u.id = t.user_id
      INNER JOIN schedules s ON s.id = at.schedule_id
      INNER JOIN classes c ON c.id = s.class_id
      INNER JOIN time_slots ts ON ts.id = s.time_slot_id
      AND NOT EXISTS (
        SELECT 1 FROM schedule_exceptions se
        WHERE se.schedule_id = s.id AND se.exception_date = at.date
      )
      LEFT JOIN rooms r ON r.id = s.room_id
      WHERE at.id = ${attendanceId}
      LIMIT 1
    `);

    return getRows(result)[0] ?? null;
  }

  async approve(params: {
    attendanceId: string;
    validatedHours: number;
    validatedBy: string;
  }, tx?: QueryExecutor): Promise<void> {
    const db = tx ?? this.db;
    await db.execute(sql`
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
  }, tx?: QueryExecutor): Promise<void> {
    const db = tx ?? this.db;
    await db.execute(sql`
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

  async insertApprovedTeacherNotification(params: {
    context: AttendanceValidationContextRow;
    validatedHours: number;
    validatedBy: string;
  }): Promise<void> {
    const validatedHoursLabel =
      params.validatedHours > 0
        ? `${formatDecimalHours(params.validatedHours)} validées`
        : 'heures validées';
    const message = `Votre présence pour ${params.context.course_name} du ${params.context.date} a été validée. ${validatedHoursLabel}.`;
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
        'attendance_approved',
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
          validatedHours: params.validatedHours,
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
  }, tx?: QueryExecutor): Promise<void> {
    const db = tx ?? this.db;
    const actorResult = await db.execute<{ actor_name: string | null; actor_position: string | null }>(sql`
      SELECT
        u.name AS actor_name,
        (
          SELECT p.name
          FROM position_assignments pa
          INNER JOIN admin_positions p ON p.id = pa.position_id
          WHERE pa.user_id = u.id
          ORDER BY pa.created_at DESC
          LIMIT 1
        ) AS actor_position
      FROM users u
      WHERE u.id = ${params.actorId}::uuid
      LIMIT 1
    `);
    const actor = actorResult.rows[0] ?? { actor_name: null, actor_position: null };

    await db.execute(sql`
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
        ${actor.actor_position ?? params.actorRole},
        ${params.action},
        ${JSON.stringify(params.before)}::jsonb,
        ${JSON.stringify({
          ...params.after,
          actorName: actor.actor_name,
          actorRole: actor.actor_position ?? params.actorRole,
        })}::jsonb
      FROM public.tenants t
      WHERE t.schema_name = ${params.schemaName}
      LIMIT 1
    `);
  }

  async recomputeTeacherSalaryForMonth(params: {
    teacherId: string;
    monthStart: string;
    monthEnd: string;
  }, tx?: QueryExecutor): Promise<void> {
    const db = tx ?? this.db;
    await db.execute(sql`
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
        AND NOT EXISTS (
          SELECT 1 FROM schedule_exceptions se
          WHERE se.schedule_id = s.id AND se.exception_date = at.date
        )
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

  async recomputeForAttendanceDate(teacherId: string, date: string, tx?: QueryExecutor): Promise<void> {
    const { monthStart, monthEnd } = monthBoundsFromDate(date);
    await this.recomputeTeacherSalaryForMonth({ teacherId, monthStart, monthEnd }, tx);
  }

  // ── Missing end-scan queries ────────────────────────────────────────────────

  async listMissingEndScans(month: string): Promise<MissingEndScanTeacher[]> {

    const monthStart = `${month}-01`;
    const { monthEnd } = monthBoundsFromDate(monthStart);

    type MissingRow = {
      teacher_id: string;
      teacher_name: string;
      attendance_id: string;
      schedule_id: string;
      date: string;
      subject: string;
      slot_label: string;
      room_name: string | null;
      room_scan_start_at: string | null;
      end_scan_action: EndScanAction | null;
      end_scan_action_reason: string | null;
      end_scan_action_at: string | null;
      end_scan_action_cancelled_at: string | null;
      hourly_rate: number | null;
      schedule_duration_minutes: number;
      estimated_duration_minutes: number | null;
      likely_short_hours: boolean;
    };

    const result = await this.db.execute<MissingRow>(sql`
      WITH feature_flags AS (
        SELECT
          COALESCE(f.use_real_hours, false) AS use_real_hours,
          COALESCE(f.checkout_tolerance_minutes, 5)::int AS checkout_tolerance_minutes
        FROM public.tenants t
        LEFT JOIN public.school_sms_features f ON f.tenant_id = t.id
        WHERE t.schema_name = current_schema()
        LIMIT 1
      )
      SELECT
        t.id::text AS teacher_id,
        u.name AS teacher_name,
        at.id::text AS attendance_id,
        at.schedule_id::text AS schedule_id,
        at.date::text AS date,
        s.subject,
        ts.label AS slot_label,
        r.name AS room_name,
        at.room_scan_start_at::text AS room_scan_start_at,
        at.end_scan_action,
        at.end_scan_action_reason,
        at.end_scan_action_at::text AS end_scan_action_at,
        at.end_scan_action_cancelled_at::text AS end_scan_action_cancelled_at,
        t.hourly_rate,
        (EXTRACT(EPOCH FROM (ts.end_time - ts.start_time)) / 60)::int AS schedule_duration_minutes,
        -- Estimation : si le prof a réellement enseigné jusqu'à l'heure de fin prévue,
        -- la durée maximale du cours est (end_time - checked_in_at). C'est une borne
        -- supérieure : indication d'aide à la décision, sans impact sur le salaire.
        CASE
          WHEN at.checked_in_at IS NULL THEN NULL
          ELSE GREATEST(
            0,
            EXTRACT(EPOCH FROM ((at.date::timestamp + ts.end_time) - at.checked_in_at)) / 60
          )::int
        END AS estimated_duration_minutes,
        CASE
          WHEN at.checked_in_at IS NULL THEN false
          ELSE (
            EXTRACT(EPOCH FROM ((at.date::timestamp + ts.end_time) - at.checked_in_at)) / 60
            <
            (EXTRACT(EPOCH FROM (ts.end_time - ts.start_time)) / 60.0)
              - (SELECT checkout_tolerance_minutes FROM feature_flags)
          )
        END AS likely_short_hours
      FROM attendances_teacher at
      INNER JOIN teachers t ON t.id = at.teacher_id
      INNER JOIN users u ON u.id = t.user_id
      INNER JOIN schedules s ON s.id = at.schedule_id
      INNER JOIN time_slots ts ON ts.id = s.time_slot_id
      LEFT JOIN rooms r ON r.id = s.room_id
      WHERE at.date BETWEEN ${monthStart}::date AND ${monthEnd}::date
        AND at.checked_in_at IS NOT NULL
        AND at.checked_out_at IS NULL
        AND at.room_scan_end_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM schedule_exceptions se
          WHERE se.schedule_id = s.id AND se.exception_date = at.date
        )
        AND (
          at.date < CURRENT_DATE
          OR (NOW() AT TIME ZONE 'Africa/Abidjan') > (at.date::timestamp + ts.end_time + INTERVAL '30 minutes')
        )
      ORDER BY u.name ASC, at.date DESC
    `);

    const rows = getRows(result);
    const grouped = new Map<string, MissingEndScanTeacher>();

    for (const row of rows) {
      let entry = grouped.get(row.teacher_id);
      if (!entry) {
        entry = {
          teacherId: row.teacher_id,
          teacherName: row.teacher_name,
          hourlyRate: row.hourly_rate,
          missingEndScanCount: 0,
          warningCount: 0,
          sanctionCount: 0,
          sessions: [],
        };
        grouped.set(row.teacher_id, entry);
      }
      entry.missingEndScanCount++;
      if (row.end_scan_action === 'warned' && !row.end_scan_action_cancelled_at) entry.warningCount++;
      if (row.end_scan_action === 'sanctioned' && !row.end_scan_action_cancelled_at) entry.sanctionCount++;
      entry.sessions.push({
        date: row.date,
        scheduleId: row.schedule_id,
        attendanceId: row.attendance_id,
        subject: row.subject,
        timeSlot: row.slot_label,
        roomName: row.room_name ?? null,
        startScanAt: row.room_scan_start_at ?? null,
        endScanAction: row.end_scan_action ?? null,
        endScanActionReason: row.end_scan_action_reason ?? null,
        endScanActionAt: row.end_scan_action_at ?? null,
        endScanActionCancelledAt: row.end_scan_action_cancelled_at ?? null,
        scheduleDurationMinutes: Number(row.schedule_duration_minutes),
        estimatedDurationMinutes:
          row.estimated_duration_minutes === null
            ? null
            : Number(row.estimated_duration_minutes),
        likelyShortHours: row.likely_short_hours === true,
      });
    }

    return Array.from(grouped.values());
  }

  async invalidateSession(params: {
    attendanceId: string;
    reason: string;
    validatedBy: string;
  }): Promise<void> {
    await this.db.execute(sql`
      UPDATE attendances_teacher
      SET
        validation_status = 'rejected',
        validation_reason = ${params.reason},
        validated_by = ${params.validatedBy}::uuid,
        validated_at = NOW(),
        status = 'absent'::attendance_teacher_status
      WHERE id = ${params.attendanceId}
    `);
  }

  // ── End-scan actions (warn / sanction) ───────────────────────────────────

  async findAttendanceForEndScanAction(attendanceId: string): Promise<{
    attendance_id: string;
    teacher_id: string;
    teacher_user_id: string;
    teacher_name: string;
    teacher_phone: string | null;
    teacher_email: string | null;
    course_name: string;
    date: string;
    end_scan_action: EndScanAction | null;
    end_scan_action_cancelled_at: string | null;
    validation_status: string;
  } | null> {
    const result = await this.db.execute<{
      attendance_id: string;
      teacher_id: string;
      teacher_user_id: string;
      teacher_name: string;
      teacher_phone: string | null;
      teacher_email: string | null;
      course_name: string;
      date: string;
      end_scan_action: EndScanAction | null;
      end_scan_action_cancelled_at: string | null;
      validation_status: string;
    }>(sql`
      SELECT
        at.id::text AS attendance_id,
        t.id::text AS teacher_id,
        u.id::text AS teacher_user_id,
        u.name AS teacher_name,
        u.phone AS teacher_phone,
        u.email AS teacher_email,
        s.subject AS course_name,
        at.date::text AS date,
        at.end_scan_action,
        at.end_scan_action_cancelled_at::text AS end_scan_action_cancelled_at,
        at.validation_status::text AS validation_status
      FROM attendances_teacher at
      INNER JOIN teachers t ON t.id = at.teacher_id
      INNER JOIN users u ON u.id = t.user_id
      INNER JOIN schedules s ON s.id = at.schedule_id
      AND NOT EXISTS (
        SELECT 1 FROM schedule_exceptions se
        WHERE se.schedule_id = s.id AND se.exception_date = at.date
      )
      WHERE at.id = ${attendanceId}
      LIMIT 1
    `);
    return getRows(result)[0] ?? null;
  }

  async applyEndScanAction(params: {
    attendanceId: string;
    action: EndScanAction;
    reason: string;
    actorId: string;
  }): Promise<void> {
    await this.db.execute(sql`
      UPDATE attendances_teacher
      SET
        end_scan_action = ${params.action}::end_scan_action_type,
        end_scan_action_reason = ${params.reason},
        end_scan_action_at = NOW(),
        end_scan_action_by = ${params.actorId}::uuid,
        end_scan_action_cancelled_at = NULL,
        end_scan_action_cancel_reason = NULL
      WHERE id = ${params.attendanceId}
    `);
  }

  async setSanctionedAttendanceRejected(params: {
    attendanceId: string;
    reason: string;
    actorId: string;
  }): Promise<void> {
    await this.db.execute(sql`
      UPDATE attendances_teacher
      SET
        validation_status = 'rejected',
        validation_reason = ${params.reason},
        validated_by = ${params.actorId}::uuid,
        validated_at = NOW(),
        validated_hours = 0,
        status = 'absent'::attendance_teacher_status
      WHERE id = ${params.attendanceId}
    `);
  }

  async revertSanctionedAttendance(attendanceId: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE attendances_teacher
      SET
        validation_status = 'pending',
        validation_reason = NULL,
        validated_by = NULL,
        validated_at = NULL,
        validated_hours = NULL,
        status = 'present'::attendance_teacher_status
      WHERE id = ${attendanceId}
    `);
  }

  async cancelEndScanSanction(params: {
    attendanceId: string;
    reason: string;
  }): Promise<void> {
    await this.db.execute(sql`
      UPDATE attendances_teacher
      SET
        end_scan_action_cancelled_at = NOW(),
        end_scan_action_cancel_reason = ${params.reason}
      WHERE id = ${params.attendanceId}
    `);
  }

  /**
   * Applique 'warned' en masse à toutes les sessions sans scan de fin éligibles
   * pour les enseignants donnés sur le mois donné. Ne touche pas aux sessions
   * déjà actionnées (warned/sanctioned actifs) ; ne re-cible que celles avec
   * end_scan_action NULL ou end_scan_action_cancelled_at NOT NULL.
   * Retourne la liste des sessions affectées, groupée par enseignant, pour
   * permettre l'envoi des notifications consolidées.
   */
  async bulkApplyEndScanWarning(params: {
    teacherIds: string[];
    month: string;
    reason: string;
    actorId: string;
  }): Promise<Array<{
    teacher_id: string;
    user_id: string;
    teacher_name: string;
    phone: string | null;
    email: string | null;
    affected_count: number;
  }>> {
    if (params.teacherIds.length === 0) return [];
    const monthStart = `${params.month}-01`;
    const { monthEnd } = monthBoundsFromDate(monthStart);
    const idList = sql.join(params.teacherIds.map((id) => sql`${id}::uuid`), sql`, `);

    const result = await this.db.execute<{
      teacher_id: string;
      user_id: string;
      teacher_name: string;
      phone: string | null;
      email: string | null;
      affected_count: string;
    }>(sql`
      WITH eligible AS (
        SELECT at.id, t.id AS teacher_id, u.id AS user_id, u.name, u.phone, u.email
        FROM attendances_teacher at
        INNER JOIN teachers t ON t.id = at.teacher_id
        INNER JOIN users u ON u.id = t.user_id
        INNER JOIN time_slots ts ON ts.id = (
          SELECT s.time_slot_id FROM schedules s WHERE s.id = at.schedule_id 
          AND NOT EXISTS (
            SELECT 1 FROM schedule_exceptions se
            WHERE se.schedule_id = s.id AND se.exception_date = at.date
          )
        )
        WHERE t.id IN (${idList})
          AND at.date BETWEEN ${monthStart}::date AND ${monthEnd}::date
          AND at.checked_in_at IS NOT NULL
          AND at.checked_out_at IS NULL
          AND at.room_scan_end_at IS NULL
          AND (
            at.date < CURRENT_DATE
            OR (NOW() AT TIME ZONE 'Africa/Abidjan') > (at.date::timestamp + ts.end_time + INTERVAL '30 minutes')
          )
          AND (at.end_scan_action IS NULL OR at.end_scan_action_cancelled_at IS NOT NULL)
      ),
      updated AS (
        UPDATE attendances_teacher at
        SET
          end_scan_action = 'warned'::end_scan_action_type,
          end_scan_action_reason = ${params.reason},
          end_scan_action_at = NOW(),
          end_scan_action_by = ${params.actorId}::uuid,
          end_scan_action_cancelled_at = NULL,
          end_scan_action_cancel_reason = NULL
        FROM eligible e
        WHERE at.id = e.id
        RETURNING e.teacher_id, e.user_id, e.name, e.phone, e.email
      )
      SELECT
        teacher_id::text,
        user_id::text,
        name AS teacher_name,
        phone,
        email,
        COUNT(*)::text AS affected_count
      FROM updated
      GROUP BY teacher_id, user_id, name, phone, email
    `);

    return getRows(result).map((row) => ({
      teacher_id: row.teacher_id,
      user_id: row.user_id,
      teacher_name: row.teacher_name,
      phone: row.phone,
      email: row.email,
      affected_count: Number(row.affected_count),
    }));
  }

  async insertEndScanActionNotification(params: {
    action: EndScanAction;
    teacherUserId: string;
    teacherPhone: string | null;
    teacherEmail: string | null;
    teacherName: string;
    courseName: string;
    date: string;
    reason: string;
  }): Promise<void> {
    const isSanction = params.action === 'sanctioned';
    const message = isSanction
      ? `Sanction pour absence de scan de fin - ${params.courseName} du ${params.date}. Motif : ${params.reason}. Présentez-vous à l'administration pour justification.`
      : `Avertissement pour absence de scan de fin - ${params.courseName} du ${params.date}. Motif : ${params.reason}. Rendez-vous à l'administration de l'établissement pour plus d'informations.`;
    await this.db.execute(sql`
      INSERT INTO notifications_log (
        type, channel, recipient_id, recipient_phone, recipient_email, message, status, metadata
      ) VALUES (
        ${isSanction ? 'scan_end_sanction' : 'scan_end_warning'},
        'email',
        ${params.teacherUserId}::uuid,
        ${params.teacherPhone ?? ''},
        ${params.teacherEmail ?? null},
        ${message},
        'queued',
        ${JSON.stringify({ courseName: params.courseName, date: params.date, reason: params.reason, action: params.action })}::jsonb
      )
    `);
  }

  async insertSanctionCancelledNotification(params: {
    teacherUserId: string;
    teacherPhone: string | null;
    teacherEmail: string | null;
    teacherName: string;
    courseName: string;
    date: string;
    cancelReason: string;
  }): Promise<void> {
    const message = `La sanction pour ${params.courseName} du ${params.date} a été annulée. Motif : ${params.cancelReason}. Votre cours est de nouveau pris en compte. Rendez-vous à l'administration de l'établissement pour plus d'informations.`;
    await this.db.execute(sql`
      INSERT INTO notifications_log (
        type, channel, recipient_id, recipient_phone, recipient_email, message, status, metadata
      ) VALUES (
        'scan_end_sanction_cancelled',
        'email',
        ${params.teacherUserId}::uuid,
        ${params.teacherPhone ?? ''},
        ${params.teacherEmail ?? null},
        ${message},
        'queued',
        ${JSON.stringify({ courseName: params.courseName, date: params.date, cancelReason: params.cancelReason })}::jsonb
      )
    `);
  }

  // ── Teacher in-app notifications ─────────────────────────────────────────

  async listTeacherNotifications(userId: string): Promise<TeacherNotificationItem[]> {
    type NotifRow = {
      id: string;
      type: string;
      message: string;
      created_at: string;
      metadata: Record<string, unknown> | null;
    };

    const result = await this.db.execute<NotifRow>(sql`
      SELECT
        id::text,
        type,
        message,
        created_at::text,
        metadata
      FROM notifications_log
      WHERE recipient_id = ${userId}::uuid
        AND type IN ('attendance_rejected', 'attendance_approved', 'scan_end_warning', 'scan_end_sanction', 'scan_end_sanction_cancelled')
      ORDER BY created_at DESC
      LIMIT 50
    `);

    return getRows(result).map((row) => ({
      id: row.id,
      type: row.type,
      message: row.message,
      createdAt: row.created_at,
      readAt: (row.metadata as { read_at?: string } | null)?.read_at ?? null,
      metadata: row.metadata,
    }));
  }

  async findTeacherNotification(notificationId: string, userId: string): Promise<{ id: string } | null> {
    const result = await this.db.execute<{ id: string }>(sql`
      SELECT id::text
      FROM notifications_log
      WHERE id = ${notificationId}::uuid
        AND recipient_id = ${userId}::uuid
        AND type IN ('attendance_rejected', 'attendance_approved', 'scan_end_warning', 'scan_end_sanction', 'scan_end_sanction_cancelled')
      LIMIT 1
    `);
    return getRows(result)[0] ?? null;
  }

  async markNotificationRead(notificationId: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE notifications_log
      SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('read_at', NOW()::text)
      WHERE id = ${notificationId}::uuid
    `);
  }

  async markAllNotificationsRead(userId: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE notifications_log
      SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('read_at', NOW()::text)
      WHERE recipient_id = ${userId}::uuid
        AND type IN ('attendance_rejected', 'attendance_approved', 'scan_end_warning', 'scan_end_sanction', 'scan_end_sanction_cancelled')
        AND (metadata->>'read_at' IS NULL)
    `);
  }

  async listValidationHistory(params: {
    kind?: 'short_hours' | 'gps_suspicious';
    month?: string;
    status?: 'approved' | 'rejected';
    approvalType?: 'planned' | 'actual';
    search?: string;
    page: number;
    limit: number;
  }): Promise<ValidationHistoryPage> {

    const offset = (params.page - 1) * params.limit;

    const monthStart = params.month ? `${params.month}-01` : null;
    const monthEnd = params.month ? monthBoundsFromDate(`${params.month}-01`).monthEnd : null;

    type HistoryRow = {
      attendance_id: string;
      teacher_id: string;
      teacher_name: string;
      course_name: string;
      class_name: string;
      date: string;
      validation_status: 'approved' | 'rejected';
      validated_hours: string | null;
      validation_reason: string | null;
      validated_at: string | null;
      kind: ValidationKind;
      kinds: ValidationKind[] | null;
      slot_label: string | null;
      room_name: string | null;
      schedule_duration_minutes: string | number;
      actual_minutes: number | null;
      hourly_rate: number | null;
      total_count: string;
    };

    const result = await this.db.execute<HistoryRow>(sql`
      WITH feature_flags AS (
        SELECT
          COALESCE(f.use_real_hours, false) AS use_real_hours,
          COALESCE(f.checkout_tolerance_minutes, 5)::int AS checkout_tolerance_minutes
        FROM public.tenants t
        LEFT JOIN public.school_sms_features f ON f.tenant_id = t.id
        WHERE t.schema_name = current_schema()
        LIMIT 1
      ),
      base AS (
        SELECT
          at.id::text AS attendance_id,
          t.id::text AS teacher_id,
          u.name AS teacher_name,
          s.subject AS course_name,
          c.name AS class_name,
          at.date,
          at.validation_status,
          at.validated_hours,
          at.validation_reason,
          at.validated_at,
          ts.label AS slot_label,
          r.name AS room_name,
          (EXTRACT(EPOCH FROM (ts.end_time - ts.start_time)) / 60.0)::numeric(8,2) AS schedule_duration_minutes,
          COALESCE(
            at.actual_minutes,
            CASE
              WHEN COALESCE((SELECT use_real_hours FROM feature_flags), false)
                AND at.checked_in_at IS NOT NULL
                AND at.room_scan_end_at IS NOT NULL
              THEN GREATEST(
                0,
                FLOOR(
                  EXTRACT(EPOCH FROM (
                    LEAST(at.room_scan_end_at, at.date::timestamp + ts.end_time) - at.checked_in_at
                  )) / 60
                )
              )::int
              ELSE NULL
            END
          ) AS actual_minutes,
          t.hourly_rate,
          (at.geo_status = 'suspicious') AS is_gps_suspicious,
          (
            COALESCE(
              at.actual_minutes,
              CASE
                WHEN COALESCE((SELECT use_real_hours FROM feature_flags), false)
                  AND at.checked_in_at IS NOT NULL
                  AND at.room_scan_end_at IS NOT NULL
                THEN GREATEST(
                  0,
                  FLOOR(
                    EXTRACT(EPOCH FROM (
                      LEAST(at.room_scan_end_at, at.date::timestamp + ts.end_time) - (at.date::timestamp + ts.start_time)
                    )) / 60
                  )
                )::int
                ELSE NULL
              END
            ) IS NOT NULL
            AND COALESCE(
              at.actual_minutes,
              CASE
                WHEN COALESCE((SELECT use_real_hours FROM feature_flags), false)
                  AND at.checked_in_at IS NOT NULL
                  AND at.room_scan_end_at IS NOT NULL
                THEN GREATEST(
                  0,
                  FLOOR(
                    EXTRACT(EPOCH FROM (
                      LEAST(at.room_scan_end_at, at.date::timestamp + ts.end_time) - (at.date::timestamp + ts.start_time)
                    )) / 60
                  )
                )::int
                ELSE NULL
              END
            ) < ((EXTRACT(EPOCH FROM (ts.end_time - ts.start_time)) / 60.0) - (SELECT checkout_tolerance_minutes FROM feature_flags))
          ) AS is_short_hours
        FROM attendances_teacher at
        INNER JOIN teachers t ON t.id = at.teacher_id
        INNER JOIN users u ON u.id = t.user_id
        INNER JOIN schedules s ON s.id = at.schedule_id
        INNER JOIN classes c ON c.id = s.class_id
        INNER JOIN time_slots ts ON ts.id = s.time_slot_id
        LEFT JOIN rooms r ON r.id = s.room_id
        WHERE at.validation_status IN ('approved', 'rejected')
          AND NOT EXISTS (
            SELECT 1 FROM schedule_exceptions se
            WHERE se.schedule_id = s.id AND se.exception_date = at.date
          )
          ${params.status ? sql`AND at.validation_status = ${params.status}` : sql``}
          ${monthStart && monthEnd ? sql`AND at.date BETWEEN ${monthStart}::date AND ${monthEnd}::date` : sql``}
          ${params.search ? sql`AND u.name ILIKE ${'%' + params.search + '%'}` : sql``}
      )
      SELECT
        attendance_id,
        teacher_id,
        teacher_name,
        course_name,
        class_name,
        date::text AS date,
        validation_status::text AS validation_status,
        validated_hours::text AS validated_hours,
        validation_reason,
        validated_at::text AS validated_at,
        CASE WHEN is_short_hours THEN 'short_hours' ELSE 'gps_suspicious' END AS kind,
        ARRAY_REMOVE(ARRAY[
          CASE WHEN is_short_hours THEN 'short_hours'::text END,
          CASE WHEN is_gps_suspicious THEN 'gps_suspicious'::text END
        ], NULL) AS kinds,
        slot_label,
        room_name,
        schedule_duration_minutes,
        actual_minutes,
        hourly_rate,
        COUNT(*) OVER() AS total_count
      FROM base
      WHERE (is_gps_suspicious OR is_short_hours)
        ${params.kind === 'gps_suspicious' ? sql`AND is_gps_suspicious` : params.kind === 'short_hours' ? sql`AND is_short_hours` : sql``}
        ${
          params.kind === 'short_hours' && params.approvalType === 'planned'
            ? sql`AND validation_status = 'approved' AND validated_hours >= (schedule_duration_minutes / 60.0) - 0.01`
            : params.kind === 'short_hours' && params.approvalType === 'actual'
              ? sql`AND validation_status = 'approved' AND validated_hours < (schedule_duration_minutes / 60.0) - 0.01`
              : sql``
        }
      ORDER BY validated_at DESC NULLS LAST, date DESC
      LIMIT ${params.limit} OFFSET ${offset}
    `);

    const rows = getRows(result);
    const total = rows.length > 0 ? Number(rows[0].total_count) : 0;

    return {
      items: rows.map((row) => ({
        attendanceId: row.attendance_id,
        teacherId: row.teacher_id,
        teacherName: row.teacher_name,
        courseName: row.course_name,
        className: row.class_name,
        date: row.date,
        validationStatus: row.validation_status,
        validatedHours: row.validated_hours !== null ? Number(row.validated_hours) : null,
        validationReason: row.validation_reason,
        validatedAt: row.validated_at,
        kind: row.kind,
        kinds: row.kinds && row.kinds.length > 0 ? row.kinds : [row.kind],
        slotLabel: row.slot_label ?? null,
        roomName: row.room_name ?? null,
        scheduleDurationMinutes: toNumber(row.schedule_duration_minutes) ?? 0,
        actualMinutes: row.actual_minutes,
        hourlyRate: row.hourly_rate,
      })),
      total,
      page: params.page,
      limit: params.limit,
    };
  }
} // end class ValidationsRepository

export const buildValidationsRepository = (
  db: ConstructorParameters<typeof ValidationsRepository>[0]
): ValidationsRepository => new ValidationsRepository(db);
