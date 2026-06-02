import { sql } from 'drizzle-orm';

import type { TeacherLatePayload, TeacherQrAlertPayload } from '../../shared/events/events.types.js';
import type { NotificationType } from '../../shared/types/index.js';

export type TenantDbLike = object;

type TenantQueryExecutor = {
  execute: <TRow = Record<string, unknown>>(query: unknown) => Promise<{ rows: TRow[] }>;
};

export type LateAlertContext = {
  teacherName: string;
  subject: string;
  className: string;
  slotLabel: string;
  directorPhone: string | null;
};

export type QrAlertContext = LateAlertContext & {
  expectedRoom: string;
  scannedRoom: string;
};

export type NotificationLogRow = {
  id: string;
  type: NotificationType;
  channel: 'sms' | 'email';
  message: string;
  sent_at: string | null;
  recipient_phone: string | null;
  recipient_email: string | null;
  status:
    | 'queued'
    | 'sent'
    | 'failed'
    | 'delivered'
    | 'skipped_no_active_subscription'
    | 'skipped_feature_disabled'
    | 'skipped_cap_reached'
    | 'skipped_subscription_expired'
    | 'skipped_unknown';
};

export type TeacherDailySummaryContext = {
  directorPhone: string | null;
  directorEmail: string | null;
  totalCourses: number;
  presentCount: number;
  lateCount: number;
  absentCount: number;
};

export type NotificationsRepository = {
  getLateAlertContext: (
    tenantDb: TenantDbLike,
    payload: Pick<TeacherLatePayload, 'teacherId' | 'scheduleId'>
  ) => Promise<LateAlertContext | null>;
  getQrAlertContext: (
    tenantDb: TenantDbLike,
    payload: Pick<TeacherQrAlertPayload, 'teacherId' | 'scheduleId' | 'date'>
  ) => Promise<QrAlertContext | null>;
  getQrInvalidAlertContext: (
    tenantDb: TenantDbLike,
    payload: { teacherId: string }
  ) => Promise<{ directorPhone: string | null; directorEmail: string | null } | null>;
  getDirectorContact: (
    tenantDb: TenantDbLike
  ) => Promise<{ directorPhone: string | null; directorEmail: string | null } | null>;
  insertNotificationLog: (
    tenantDb: TenantDbLike,
    params: {
      type: NotificationType;
      recipientPhone: string;
      channel?: 'sms' | 'email';
      recipientEmail?: string;
      message: string;
      status:
        | 'queued'
        | 'sent'
        | 'failed'
        | 'delivered'
        | 'skipped_no_active_subscription'
        | 'skipped_feature_disabled'
        | 'skipped_cap_reached'
        | 'skipped_subscription_expired'
        | 'skipped_unknown';
      providerRef?: string;
      relatedId?: string;
      sentAt?: Date;
    }
  ) => Promise<void>;
  updateNotificationLogStatus: (
    tenantDb: TenantDbLike,
    params: {
      queueRef: string;
      status: 'queued' | 'sent' | 'failed' | 'delivered';
      providerRef?: string;
      sentAt?: Date;
    }
  ) => Promise<void>;
  updateNotificationLogDeliveryStatus: (
    tenantDb: TenantDbLike,
    params: {
      providerRef: string;
      status: 'sent' | 'failed' | 'delivered';
    }
  ) => Promise<number>;
  markQrAlertSent: (
    tenantDb: TenantDbLike,
    payload: Pick<TeacherQrAlertPayload, 'teacherId' | 'scheduleId' | 'date'>
  ) => Promise<void>;
  getTeacherDailySummaryContext: (
    tenantDb: TenantDbLike,
    params: { date: string }
  ) => Promise<TeacherDailySummaryContext>;
  listNotificationLog: (
    tenantDb: TenantDbLike,
    params: {
      limit: number;
      types?: NotificationType[];
    }
  ) => Promise<NotificationLogRow[]>;
  listTeacherNotifications: (
    tenantDb: TenantDbLike,
    params: { userId: string; limit: number }
  ) => Promise<Array<{ id: string; type: string; message: string; created_at: string; metadata: unknown }>>;
};

const getFirstRow = <TRow>(result: { rows: TRow[] }): TRow | null => {
  return result.rows[0] ?? null;
};

const asExecutor = (tenantDb: TenantDbLike): TenantQueryExecutor => {
  return tenantDb as unknown as TenantQueryExecutor;
};

export const defaultRepository: NotificationsRepository = {
  async getLateAlertContext(tenantDb, payload) {
    const result = await asExecutor(tenantDb).execute<{
      teacher_name: string;
      subject: string;
      class_name: string;
      slot_label: string;
      director_phone: string | null;
    }>(sql`
      SELECT
        tu.name AS teacher_name,
        s.subject,
        c.name AS class_name,
        ts.label AS slot_label,
        d.phone AS director_phone
      FROM schedules s
      INNER JOIN teachers t ON t.id = s.teacher_id
      INNER JOIN users tu ON tu.id = t.user_id
      INNER JOIN classes c ON c.id = s.class_id
      INNER JOIN time_slots ts ON ts.id = s.time_slot_id
      LEFT JOIN LATERAL (
        SELECT u.phone
        FROM users u
        WHERE u.role = 'director'
          AND u.is_active = true
          AND u.phone IS NOT NULL
        ORDER BY u.created_at ASC
        LIMIT 1
      ) d ON true
      WHERE s.id = ${payload.scheduleId}
        AND s.teacher_id = ${payload.teacherId}
      LIMIT 1
    `);

    const row = getFirstRow(result);
    if (!row) {
      return null;
    }

    return {
      teacherName: row.teacher_name,
      subject: row.subject,
      className: row.class_name,
      slotLabel: row.slot_label,
      directorPhone: row.director_phone,
    };
  },

  async getQrAlertContext(tenantDb, payload) {
    const result = await asExecutor(tenantDb).execute<{
      teacher_name: string;
      subject: string;
      class_name: string;
      slot_label: string;
      expected_room: string;
      scanned_room: string | null;
      director_phone: string | null;
    }>(sql`
      SELECT
        tu.name AS teacher_name,
        s.subject,
        c.name AS class_name,
        ts.label AS slot_label,
        expected_room.name AS expected_room,
        scanned_room.name AS scanned_room,
        d.phone AS director_phone
      FROM schedules s
      INNER JOIN teachers t ON t.id = s.teacher_id
      INNER JOIN users tu ON tu.id = t.user_id
      INNER JOIN classes c ON c.id = s.class_id
      INNER JOIN time_slots ts ON ts.id = s.time_slot_id
      INNER JOIN rooms expected_room ON expected_room.id = s.room_id
      LEFT JOIN attendances_teacher at
        ON at.teacher_id = s.teacher_id
        AND at.schedule_id = s.id
        AND at.date = ${payload.date}
      LEFT JOIN rooms scanned_room ON scanned_room.id = at.room_scanned_id
      LEFT JOIN LATERAL (
        SELECT u.phone
        FROM users u
        WHERE u.role = 'director'
          AND u.is_active = true
          AND u.phone IS NOT NULL
        ORDER BY u.created_at ASC
        LIMIT 1
      ) d ON true
      WHERE s.id = ${payload.scheduleId}
        AND s.teacher_id = ${payload.teacherId}
      LIMIT 1
    `);

    const row = getFirstRow(result);
    if (!row) {
      return null;
    }

    return {
      teacherName: row.teacher_name,
      subject: row.subject,
      className: row.class_name,
      slotLabel: row.slot_label,
      expectedRoom: row.expected_room,
      scannedRoom: row.scanned_room ?? 'inconnue',
      directorPhone: row.director_phone,
    };
  },

  async getDirectorContact(tenantDb) {
    const result = await asExecutor(tenantDb).execute<{
      director_phone: string | null;
      director_email: string | null;
    }>(sql`
      SELECT u.phone AS director_phone, u.email AS director_email
      FROM users u
      WHERE u.role = 'director'
        AND u.is_active = true
        AND (u.phone IS NOT NULL OR u.email IS NOT NULL)
      ORDER BY u.created_at ASC
      LIMIT 1
    `);

    const row = getFirstRow(result);
    if (!row) {
      return null;
    }

    return {
      directorPhone: row.director_phone,
      directorEmail: row.director_email,
    };
  },

  async getQrInvalidAlertContext(tenantDb) {
    const result = await asExecutor(tenantDb).execute<{
      director_phone: string | null;
      director_email: string | null;
    }>(sql`
      SELECT u.phone AS director_phone, u.email AS director_email
      FROM users u
      WHERE u.role = 'director'
        AND u.is_active = true
        AND (u.phone IS NOT NULL OR u.email IS NOT NULL)
      ORDER BY u.created_at ASC
      LIMIT 1
    `);

    const row = getFirstRow(result);
    if (!row) {
      return null;
    }

    return {
      directorPhone: row.director_phone,
      directorEmail: row.director_email,
    };
  },

  async insertNotificationLog(tenantDb, params) {
    await asExecutor(tenantDb).execute(sql`
      INSERT INTO notifications_log (
        type,
        channel,
        recipient_phone,
        recipient_email,
        message,
        status,
        provider_ref,
        related_id,
        sent_at
      )
      VALUES (
        ${params.type},
        ${params.channel ?? 'sms'},
        ${params.recipientPhone},
        ${params.recipientEmail ?? null},
        ${params.message},
        ${params.status},
        ${params.providerRef ?? null},
        ${params.relatedId ?? null},
        ${params.sentAt ?? null}
      )
    `);
  },

  async updateNotificationLogStatus(tenantDb, params) {
    await asExecutor(tenantDb).execute(sql`
      UPDATE notifications_log
      SET
        status = ${params.status},
        provider_ref = COALESCE(${params.providerRef ?? null}, provider_ref),
        sent_at = COALESCE(${params.sentAt ?? null}, sent_at)
      WHERE provider_ref = ${params.queueRef}
        AND status = 'queued'
    `);
  },

  async updateNotificationLogDeliveryStatus(tenantDb, params) {
    const result = await asExecutor(tenantDb).execute<{ id: string }>(sql`
      UPDATE notifications_log
      SET status = ${params.status}
      WHERE channel = 'sms'
        AND (
          provider_ref = ${params.providerRef}
          OR provider_ref LIKE ${`%${params.providerRef}`}
        )
      RETURNING id::text
    `);
    return result.rows.length;
  },

  async markQrAlertSent(tenantDb, payload) {
    await asExecutor(tenantDb).execute(sql`
      UPDATE attendances_teacher
      SET qr_alert_sent = true
      WHERE teacher_id = ${payload.teacherId}
        AND schedule_id = ${payload.scheduleId}
        AND date = ${payload.date}
    `);
  },

  async getTeacherDailySummaryContext(tenantDb, params) {
    const result = await asExecutor(tenantDb).execute<{
      director_phone: string | null;
      director_email: string | null;
      total_courses: number;
      present_count: number;
      late_count: number;
      absent_count: number;
    }>(sql`
      WITH date_ctx AS (
        SELECT
          ${params.date}::date AS target_date,
          EXTRACT(ISODOW FROM ${params.date}::date)::int AS day_of_week
      ),
      active_period AS (
        SELECT id
        FROM schedule_periods
        WHERE is_active = true
          AND valid_from <= (SELECT target_date FROM date_ctx)
          AND valid_to >= (SELECT target_date FROM date_ctx)
        ORDER BY created_at DESC
        LIMIT 1
      ),
      scheduled_courses AS (
        SELECT s.id AS schedule_id
        FROM schedules s
        INNER JOIN active_period ap ON ap.id = s.schedule_period_id
        INNER JOIN date_ctx dc ON dc.day_of_week = s.day_of_week
        WHERE s.is_active = true
          AND (s.start_date IS NULL OR s.start_date <= dc.target_date)
          AND (s.end_date IS NULL OR s.end_date > dc.target_date)
      ),
      director AS (
        SELECT u.phone, u.email
        FROM users u
        WHERE u.role = 'director'
          AND u.is_active = true
          AND (u.phone IS NOT NULL OR u.email IS NOT NULL)
        ORDER BY u.created_at ASC
        LIMIT 1
      )
      SELECT
        (SELECT phone FROM director) AS director_phone,
        (SELECT email FROM director) AS director_email,
        COUNT(sc.schedule_id)::int AS total_courses,
        COUNT(*) FILTER (WHERE at.status IN ('present', 'excused'))::int AS present_count,
        COUNT(*) FILTER (WHERE at.status = 'late')::int AS late_count,
        COUNT(*) FILTER (WHERE at.status = 'absent' OR at.status IS NULL)::int AS absent_count
      FROM scheduled_courses sc
      LEFT JOIN attendances_teacher at
        ON at.schedule_id = sc.schedule_id
        AND at.date = (SELECT target_date FROM date_ctx)
    `);

    const row = getFirstRow(result);
    return {
      directorPhone: row?.director_phone ?? null,
      directorEmail: row?.director_email ?? null,
      totalCourses: Number(row?.total_courses ?? 0),
      presentCount: Number(row?.present_count ?? 0),
      lateCount: Number(row?.late_count ?? 0),
      absentCount: Number(row?.absent_count ?? 0),
    };
  },

  async listNotificationLog(tenantDb, params) {
    const safeLimit = Math.max(1, Math.min(params.limit, 50));
    // Whitelist stricte : seuls les types destinés au directeur apparaissent dans son panneau.
    // Tout type prof/parent est invisible au directeur (corrige fuite notifications cross-roles).
    const DIRECTOR_ALLOWED_TYPES: NotificationType[] = [
      'teacher_late_director',
      'teacher_absent_director',
      'teacher_qr_mismatch',
      'teacher_qr_missing_scan',
      'teacher_qr_scan_out_of_time',
      'qr_invalid_alert',
      'payment_reminder',
      'subscription_expiry_alert',
      'subscription_revenue_payout',
      'custom',
    ];
    const requestedTypes = (params.types?.filter(Boolean) ?? []).filter((t) =>
      DIRECTOR_ALLOWED_TYPES.includes(t)
    );
    const effectiveTypes = requestedTypes.length === 0 ? DIRECTOR_ALLOWED_TYPES : requestedTypes;
    const whereClause = sql`WHERE type::text IN (${sql.join(
      effectiveTypes.map((item) => sql`${item}`),
      sql`, `
    )})`;
    const columnsResult = await asExecutor(tenantDb).execute<{
      has_channel: boolean;
      has_recipient_email: boolean;
    }>(sql`
      SELECT
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'notifications_log'
            AND column_name = 'channel'
        ) AS has_channel,
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'notifications_log'
            AND column_name = 'recipient_email'
        ) AS has_recipient_email
    `);
    const columns = getFirstRow(columnsResult);

    if (!columns?.has_channel || !columns.has_recipient_email) {
      const result = await asExecutor(tenantDb).execute<NotificationLogRow>(sql`
        SELECT
          id::text AS id,
          type::text AS type,
          'sms'::text AS channel,
          message,
          sent_at::text AS sent_at,
          recipient_phone,
          NULL::text AS recipient_email,
          status::text AS status
        FROM notifications_log
        ${whereClause}
        ORDER BY COALESCE(sent_at, created_at) DESC, created_at DESC
        LIMIT ${safeLimit}
      `);

      return result.rows;
    }

    const result = await asExecutor(tenantDb).execute<NotificationLogRow>(sql`
      SELECT
        id::text AS id,
        type::text AS type,
        channel::text AS channel,
        message,
        sent_at::text AS sent_at,
        recipient_phone,
        recipient_email,
        status::text AS status
      FROM notifications_log
      ${whereClause}
      ORDER BY COALESCE(sent_at, created_at) DESC, created_at DESC
      LIMIT ${safeLimit}
    `);

    return result.rows;
  },

  async listTeacherNotifications(tenantDb, params) {
    const safeLimit = Math.max(1, Math.min(params.limit, 50));
    const result = await asExecutor(tenantDb).execute<{
      id: string;
      type: string;
      message: string;
      created_at: string;
      metadata: unknown;
    }>(sql`
      SELECT nl.id::text, nl.type::text, nl.message, nl.created_at::text, nl.metadata
      FROM notifications_log nl
      INNER JOIN users u ON u.id = ${params.userId}::uuid
      WHERE (
          (nl.recipient_email IS NOT NULL AND nl.recipient_email = u.email)
          OR (nl.recipient_phone IS NOT NULL AND nl.recipient_phone = u.phone)
        )
        AND nl.type::text IN (
          'attendance_rejected',
          'attendance_approved',
          'scan_end_warning',
          'scan_end_sanction',
          'scan_end_sanction_cancelled'
        )
      ORDER BY nl.created_at DESC
      LIMIT ${safeLimit}
    `);

    return result.rows;
  },
};
