import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { QueryResult, QueryResultRow } from 'pg';

import type { ActiveAttendanceItem, AttendanceScheduleContext } from './attendance.types.js';

export type QueryExecutor = NodePgDatabase<Record<string, unknown>>;

type TeacherRow = {
  id: string;
  user_id: string;
  name: string;
};

type ScheduleContextRow = {
  schedule_id: string;
  teacher_id: string;
  teacher_name: string;
  class_name: string;
  subject: string;
  planned_room_id: string;
  planned_room_name: string;
  planned_room_token: string;
  time_slot_id: string;
  slot_label: string;
  slot_start_time: string;
  slot_end_time: string;
};

type RoomTokenRow = {
  id: string;
  name: string;
  qr_token: string;
};

type AttendanceWriteRow = {
  id: string;
  status: 'present' | 'absent' | 'late' | 'excused';
  late_minutes: number | null;
  checked_in_at: string | null;
};

type ActiveAttendanceRow = {
  schedule_id: string;
  subject: string;
  class_name: string;
  room_name: string;
  time_slot_id: string;
  slot_label: string;
  slot_start_time: string;
  slot_end_time: string;
  attendance_status: 'present' | 'absent' | 'late' | 'excused' | null;
  late_minutes: number | null;
  room_mismatch: boolean | null;
  room_scanned_name: string | null;
  checked_in_at: string | null;
};

const getRows = <TRow extends QueryResultRow>(result: QueryResult<TRow>): TRow[] => result.rows;

const mapScheduleContext = (row: ScheduleContextRow): AttendanceScheduleContext => ({
  scheduleId: row.schedule_id,
  teacherId: row.teacher_id,
  teacherName: row.teacher_name,
  className: row.class_name,
  subject: row.subject,
  plannedRoomId: row.planned_room_id,
  plannedRoomName: row.planned_room_name,
  plannedRoomToken: row.planned_room_token,
  timeSlotId: row.time_slot_id,
  slotLabel: row.slot_label,
  slotStartTime: row.slot_start_time,
  slotEndTime: row.slot_end_time,
});

export class AttendanceRepository {
  constructor(private readonly db: QueryExecutor) {}

  async findTeacherByUserId(userId: string): Promise<TeacherRow | null> {
    const result = await this.db.execute<TeacherRow>(sql`
      SELECT t.id, t.user_id, u.name
      FROM teachers t
      INNER JOIN users u ON u.id = t.user_id
      WHERE t.user_id = ${userId}
      LIMIT 1
    `);

    const [row] = getRows(result);
    return row ?? null;
  }

  async findScheduleContextForTeacher(
    scheduleId: string,
    teacherId: string
  ): Promise<AttendanceScheduleContext | null> {
    const result = await this.db.execute<ScheduleContextRow>(sql`
      SELECT
        s.id AS schedule_id,
        s.teacher_id,
        u.name AS teacher_name,
        c.name AS class_name,
        s.subject,
        s.room_id AS planned_room_id,
        r.name AS planned_room_name,
        r.qr_token AS planned_room_token,
        s.time_slot_id,
        ts.label AS slot_label,
        ts.start_time::text AS slot_start_time,
        ts.end_time::text AS slot_end_time
      FROM schedules s
      INNER JOIN teachers t ON t.id = s.teacher_id
      INNER JOIN users u ON u.id = t.user_id
      INNER JOIN classes c ON c.id = s.class_id
      INNER JOIN rooms r ON r.id = s.room_id
      INNER JOIN time_slots ts ON ts.id = s.time_slot_id
      WHERE s.id = ${scheduleId}
        AND s.teacher_id = ${teacherId}
      LIMIT 1
    `);

    const [row] = getRows(result);
    return row ? mapScheduleContext(row) : null;
  }

  async findRoomByToken(token: string): Promise<RoomTokenRow | null> {
    const result = await this.db.execute<RoomTokenRow>(sql`
      SELECT id, name, qr_token
      FROM rooms
      WHERE qr_token = ${token}
      LIMIT 1
    `);

    const [row] = getRows(result);
    return row ?? null;
  }

  async upsertCheckIn(params: {
    teacherId: string;
    scheduleId: string;
    date: string;
    status: 'present' | 'absent' | 'late' | 'excused';
    lateMinutes: number | null;
    checkedInAt: string;
  }): Promise<AttendanceWriteRow> {
    const result = await this.db.execute<AttendanceWriteRow>(sql`
      INSERT INTO attendances_teacher (
        teacher_id,
        schedule_id,
        date,
        status,
        checked_in_at,
        late_minutes,
        room_mismatch,
        qr_alert_sent
      )
      VALUES (
        ${params.teacherId},
        ${params.scheduleId},
        ${params.date},
        ${params.status},
        ${params.checkedInAt}::timestamptz,
        ${params.lateMinutes},
        false,
        false
      )
      ON CONFLICT (teacher_id, schedule_id, date)
      DO UPDATE SET
        status = EXCLUDED.status,
        checked_in_at = EXCLUDED.checked_in_at,
        late_minutes = EXCLUDED.late_minutes
      RETURNING id, status, late_minutes, checked_in_at::text
    `);

    const [row] = getRows(result);
    if (!row) {
      throw new Error('Failed to persist check-in');
    }

    return row;
  }

  async ensureAttendanceRecord(params: {
    teacherId: string;
    scheduleId: string;
    date: string;
  }): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO attendances_teacher (
        teacher_id,
        schedule_id,
        date,
        status,
        room_mismatch,
        qr_alert_sent
      )
      VALUES (
        ${params.teacherId},
        ${params.scheduleId},
        ${params.date},
        'absent',
        false,
        false
      )
      ON CONFLICT (teacher_id, schedule_id, date)
      DO NOTHING
    `);
  }

  async recordQrScan(params: {
    teacherId: string;
    scheduleId: string;
    date: string;
    scanType: 'start' | 'end';
    scannedRoomId: string | null;
    roomMismatch: boolean;
    qrAlertSent: boolean;
    scannedAtIso: string;
  }): Promise<void> {
    if (params.scanType === 'start') {
      await this.db.execute(sql`
        UPDATE attendances_teacher
        SET
          room_scanned_id = ${params.scannedRoomId},
          room_scan_start_at = ${params.scannedAtIso}::timestamptz,
          room_mismatch = ${params.roomMismatch},
          qr_alert_sent = ${params.qrAlertSent}
        WHERE teacher_id = ${params.teacherId}
          AND schedule_id = ${params.scheduleId}
          AND date = ${params.date}
      `);
      return;
    }

    await this.db.execute(sql`
      UPDATE attendances_teacher
      SET
        room_scanned_id = COALESCE(${params.scannedRoomId}, room_scanned_id),
        room_scan_end_at = ${params.scannedAtIso}::timestamptz,
        room_mismatch = ${params.roomMismatch},
        qr_alert_sent = ${params.qrAlertSent}
      WHERE teacher_id = ${params.teacherId}
        AND schedule_id = ${params.scheduleId}
        AND date = ${params.date}
    `);
  }

  async markQrAlertSent(params: {
    teacherId: string;
    scheduleId: string;
    date: string;
  }): Promise<void> {
    await this.db.execute(sql`
      UPDATE attendances_teacher
      SET qr_alert_sent = true
      WHERE teacher_id = ${params.teacherId}
        AND schedule_id = ${params.scheduleId}
        AND date = ${params.date}
    `);
  }

  async listActiveAttendanceForTeacher(params: {
    teacherId: string;
    date: string;
    dayOfWeek: number;
  }): Promise<ActiveAttendanceItem[]> {
    const result = await this.db.execute<ActiveAttendanceRow>(sql`
      WITH active_period AS (
        SELECT id
        FROM schedule_periods
        WHERE is_active = true
          AND valid_from <= ${params.date}
          AND valid_to >= ${params.date}
        ORDER BY created_at DESC
        LIMIT 1
      )
      SELECT
        s.id AS schedule_id,
        s.subject,
        c.name AS class_name,
        r.name AS room_name,
        ts.id AS time_slot_id,
        ts.label AS slot_label,
        ts.start_time::text AS slot_start_time,
        ts.end_time::text AS slot_end_time,
        at.status::text AS attendance_status,
        at.late_minutes,
        at.room_mismatch,
        rs.name AS room_scanned_name,
        at.checked_in_at::text AS checked_in_at
      FROM schedules s
      INNER JOIN active_period ap ON ap.id = s.schedule_period_id
      INNER JOIN classes c ON c.id = s.class_id
      INNER JOIN rooms r ON r.id = s.room_id
      INNER JOIN time_slots ts ON ts.id = s.time_slot_id
      LEFT JOIN attendances_teacher at
        ON at.schedule_id = s.id
       AND at.teacher_id = ${params.teacherId}
       AND at.date = ${params.date}
      LEFT JOIN rooms rs ON rs.id = at.room_scanned_id
      WHERE s.teacher_id = ${params.teacherId}
        AND s.day_of_week = ${params.dayOfWeek}
        AND s.is_active = true
      ORDER BY ts.sort_order ASC, ts.start_time ASC
    `);

    return getRows(result).map((row) => ({
      scheduleId: row.schedule_id,
      subject: row.subject,
      className: row.class_name,
      roomName: row.room_name,
      timeSlot: {
        id: row.time_slot_id,
        label: row.slot_label,
        startTime: row.slot_start_time,
        endTime: row.slot_end_time,
      },
      attendance: {
        status: row.attendance_status,
        lateMinutes: row.late_minutes,
        roomMismatch: row.room_mismatch ?? false,
        roomScannedName: row.room_scanned_name,
        checkedInAt: row.checked_in_at,
      },
    }));
  }

  async listMissingQrScans(params: { date: string }): Promise<
    Array<{
      teacherId: string;
      scheduleId: string;
    }>
  > {
    const result = await this.db.execute<{
      teacher_id: string;
      schedule_id: string;
    }>(sql`
      SELECT teacher_id, schedule_id
      FROM attendances_teacher
      WHERE date = ${params.date}
        AND checked_in_at IS NOT NULL
        AND room_scan_start_at IS NULL
        AND qr_alert_sent = false
    `);

    return getRows(result).map((row) => ({
      teacherId: row.teacher_id,
      scheduleId: row.schedule_id,
    }));
  }
}
