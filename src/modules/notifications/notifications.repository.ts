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

export type NotificationsRepository = {
  getLateAlertContext: (
    tenantDb: TenantDbLike,
    payload: Pick<TeacherLatePayload, 'teacherId' | 'scheduleId'>
  ) => Promise<LateAlertContext | null>;
  getQrAlertContext: (
    tenantDb: TenantDbLike,
    payload: Pick<TeacherQrAlertPayload, 'teacherId' | 'scheduleId' | 'date'>
  ) => Promise<QrAlertContext | null>;
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
  markQrAlertSent: (
    tenantDb: TenantDbLike,
    payload: Pick<TeacherQrAlertPayload, 'teacherId' | 'scheduleId' | 'date'>
  ) => Promise<void>;
  listNotificationLog: (
    tenantDb: TenantDbLike,
    params: {
      limit: number;
      types?: NotificationType[];
    }
  ) => Promise<NotificationLogRow[]>;
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

  async markQrAlertSent(tenantDb, payload) {
    await asExecutor(tenantDb).execute(sql`
      UPDATE attendances_teacher
      SET qr_alert_sent = true
      WHERE teacher_id = ${payload.teacherId}
        AND schedule_id = ${payload.scheduleId}
        AND date = ${payload.date}
    `);
  },

  async listNotificationLog(tenantDb, params) {
    const safeLimit = Math.max(1, Math.min(params.limit, 50));
    const filteredTypes = params.types?.filter(Boolean) ?? [];
    const whereClause =
      filteredTypes.length === 0
        ? sql``
        : sql`WHERE type IN (${sql.join(filteredTypes.map((item) => sql`${item}`), sql`, `)})`;

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
};
