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
  class_id: string;
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

// ── Type élève minimal pour l'appel ──────────────────────────────────────────
type StudentIdRow = {
  id: string;
};

// ── Nouveau type pour getTeacherAttendanceByDate ──────────────────────────────
type TeacherAttendanceByDateRow = {
  id: string;
  schedule_id: string;
  status: 'present' | 'absent' | 'late' | 'excused';
  late_minutes: number | null;
  date: string;
};

type DirectorTodayCourseRow = {
  schedule_id: string;
  teacher_name: string;
  subject: string;
  class_name: string;
  room_name: string;
  slot_label: string;
  start_time: string;
  end_time: string;
  attendance_status: 'present' | 'absent' | 'late' | 'excused' | null;
  late_minutes: number | null;
  room_mismatch: boolean | null;
  room_scanned_name: string | null;
  checked_in_at: string | null;
};

type DirectorHistoryRow = {
  date: string;
  present_count: number;
  absent_count: number;
  not_checked_count: number;
  total_count: number;
  attendance_rate: number;
};

type schex = {
  id: string;
  class_id: string;
  class_name: string;
  subject: string;
  room_id: string;
  room_name: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
};

const getRows = <TRow extends QueryResultRow>(result: QueryResult<TRow>): TRow[] => result.rows;

const mapScheduleContext = (row: ScheduleContextRow): AttendanceScheduleContext => ({
  scheduleId: row.schedule_id,
  teacherId: row.teacher_id,
  teacherName: row.teacher_name,
  classId: row.class_id,
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
        c.id AS class_id,
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

  // ── NOUVEAU — statuts de pointage prof pour une date (TeacherSchedulePage) ──
  async getTeacherAttendanceByDate(params: {
    teacherId: string;
    date: string;
  }): Promise<TeacherAttendanceByDateRow[]> {
    const result = await this.db.execute<TeacherAttendanceByDateRow>(sql`
      SELECT
        at.id::text AS id,
        at.schedule_id::text AS schedule_id,
        at.status::text AS status,
        at.late_minutes,
        at.date::text AS date
      FROM attendances_teacher at
      WHERE at.teacher_id = ${params.teacherId}
        AND at.date = ${params.date}
    `);

    return getRows(result);
  }

  // ── NOUVEAU — appel élèves en masse par le prof ───────────────────────────
  async bulkUpsertStudentAttendance(params: {
    scheduleId: string;
    date: string;
    absentStudentIds: string[];
    markedByUserId: string;
    allStudentIds: string[];
  }): Promise<{ upsertedCount: number }> {
    if (params.allStudentIds.length === 0) {
      return { upsertedCount: 0 };
    }

    const absentSet = new Set(params.absentStudentIds);

    // Construire les valeurs à insérer pour chaque élève de la classe
    // Statut : 'absent' si dans absentStudentIds, sinon 'present'
    const values = params.allStudentIds.map((studentId) => ({
      studentId,
      status: absentSet.has(studentId) ? 'absent' : 'present',
    }));

    // Upsert par batch — PostgreSQL VALUES list via sql template
    // On construit dynamiquement la liste VALUES
    let upsertedCount = 0;
    for (const { studentId, status } of values) {
      await this.db.execute(sql`
        INSERT INTO attendances_student (
          student_id,
          schedule_id,
          date,
          status,
          marked_by
        )
        VALUES (
          ${studentId},
          ${params.scheduleId},
          ${params.date},
          ${status},
          ${params.markedByUserId}
        )
        ON CONFLICT (student_id, schedule_id, date)
        DO UPDATE SET
          status = EXCLUDED.status,
          marked_by = EXCLUDED.marked_by
      `);
      upsertedCount += 1;
    }

    return { upsertedCount };
  }

  // ── NOUVEAU — liste des IDs élèves d'une classe ───────────────────────────
  async listStudentsByClass(classId: string): Promise<StudentIdRow[]> {
    const result = await this.db.execute<StudentIdRow>(sql`
      SELECT id::text AS id
      FROM students
      WHERE class_id = ${classId}
        AND is_active = true
    `);

    return getRows(result);
  }

  async getWeekScheduleForTeacher(userId: string, date: string): Promise<schex[]> {
    const result = await this.db.execute<schex>(sql`
          WITH active_period AS (
            -- Résolution de la période active POUR LA DATE DEMANDÉE,
            -- pas pour aujourd'hui. Si aucune période ne couvre cette date,
            -- le CTE est vide et la query retourne [].
            SELECT id
            FROM schedule_periods
            WHERE is_active = true
              AND valid_from <= ${date}::date
              AND valid_to   >= ${date}::date
            ORDER BY created_at DESC
            LIMIT 1
          )
          SELECT
            s.id::text          AS id,
            s.class_id::text    AS class_id,
            c.name              AS class_name,
            s.subject,
            s.room_id::text     AS room_id,
            r.name              AS room_name,
            s.day_of_week,
            ts.start_time::text AS start_time,
            ts.end_time::text   AS end_time
          FROM schedules s
          INNER JOIN active_period ap ON ap.id = s.schedule_period_id
          INNER JOIN teachers t  ON t.id  = s.teacher_id
          INNER JOIN classes  c  ON c.id  = s.class_id
          INNER JOIN rooms    r  ON r.id  = s.room_id
          INNER JOIN time_slots ts ON ts.id = s.time_slot_id
          WHERE t.user_id = ${userId}
            AND s.is_active = true
          ORDER BY s.day_of_week ASC, ts.sort_order ASC, ts.start_time ASC
    `);

    return result.rows.map((row) => ({
      id: row.id,
      class_id: row.class_id,
      class_name: row.class_name,
      subject: row.subject,
      room_id: row.room_id,
      room_name: row.room_name,
      day_of_week: Number(row.day_of_week),
      start_time: row.start_time,
      end_time: row.end_time,
    }));
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

  async listTodayForDirector(): Promise<{
    date: string;
    courses: DirectorTodayCourseRow[];
    presentCount: number;
    absentCount: number;
    unmarkedCount: number;
  }> {
    const dateResult = await this.db.execute<{ date: string; day_of_week: number }>(sql`
      SELECT
        (NOW() AT TIME ZONE 'Africa/Abidjan')::date::text AS date,
        EXTRACT(ISODOW FROM (NOW() AT TIME ZONE 'Africa/Abidjan'))::int AS day_of_week
    `);
    const dateRow = getRows(dateResult)[0];
    const today = dateRow?.date;
    const dayOfWeek = dateRow?.day_of_week;

    if (!today || !dayOfWeek) {
      return {
        date: new Date().toISOString().slice(0, 10),
        courses: [],
        presentCount: 0,
        absentCount: 0,
        unmarkedCount: 0,
      };
    }

    const coursesResult = await this.db.execute<DirectorTodayCourseRow>(sql`
      WITH active_period AS (
        SELECT id
        FROM schedule_periods
        WHERE is_active = true
          AND valid_from <= ${today}
          AND valid_to >= ${today}
        ORDER BY created_at DESC
        LIMIT 1
      )
      SELECT
        s.id::text AS schedule_id,
        u.name AS teacher_name,
        s.subject,
        c.name AS class_name,
        r.name AS room_name,
        ts.label AS slot_label,
        ts.start_time::text AS start_time,
        ts.end_time::text AS end_time,
        at.status::text AS attendance_status,
        at.late_minutes,
        at.room_mismatch,
        scanned_room.name AS room_scanned_name,
        at.checked_in_at::text AS checked_in_at
      FROM schedules s
      INNER JOIN active_period ap ON ap.id = s.schedule_period_id
      INNER JOIN teachers t ON t.id = s.teacher_id
      INNER JOIN users u ON u.id = t.user_id
      INNER JOIN classes c ON c.id = s.class_id
      INNER JOIN rooms r ON r.id = s.room_id
      INNER JOIN time_slots ts ON ts.id = s.time_slot_id
      LEFT JOIN attendances_teacher at
        ON at.schedule_id = s.id
       AND at.date = ${today}
      LEFT JOIN rooms scanned_room ON scanned_room.id = at.room_scanned_id
      WHERE s.day_of_week = ${dayOfWeek}
        AND s.is_active = true
      ORDER BY ts.sort_order ASC, ts.start_time ASC, c.name ASC
    `);

    const courses = getRows(coursesResult);
    let presentCount = 0;
    let absentCount = 0;
    let unmarkedCount = 0;
    for (const course of courses) {
      if (
        course.attendance_status === 'present' ||
        course.attendance_status === 'late' ||
        course.attendance_status === 'excused'
      ) {
        presentCount += 1;
        continue;
      }

      if (course.attendance_status === 'absent') {
        absentCount += 1;
        continue;
      }

      unmarkedCount += 1;
    }

    return {
      date: today,
      courses,
      presentCount,
      absentCount,
      unmarkedCount,
    };
  }

  async listHistoryForDirector(days: number): Promise<DirectorHistoryRow[]> {
    const safeDays = Math.max(1, Math.min(days, 30));

    const result = await this.db.execute<DirectorHistoryRow>(sql`
      WITH params AS (
        SELECT
          (NOW() AT TIME ZONE 'Africa/Abidjan')::date AS today,
          ${safeDays}::int AS days
      ),
      dates AS (
        SELECT generate_series(
          (SELECT today - ((days - 1) * INTERVAL '1 day') FROM params),
          (SELECT today FROM params),
          INTERVAL '1 day'
        )::date AS date
      ),
      active_period AS (
        SELECT id, valid_from, valid_to
        FROM schedule_periods
        WHERE is_active = true
        ORDER BY created_at DESC
        LIMIT 1
      ),
      schedules_by_date AS (
        SELECT
          d.date,
          s.id AS schedule_id
        FROM dates d
        LEFT JOIN active_period ap
          ON d.date BETWEEN ap.valid_from AND ap.valid_to
        LEFT JOIN schedules s
          ON s.schedule_period_id = ap.id
         AND s.day_of_week = EXTRACT(ISODOW FROM d.date)::int
         AND s.is_active = true
      )
      SELECT
        sbd.date::text AS date,
        COALESCE(
          SUM(CASE WHEN at.status IN ('present', 'late', 'excused') THEN 1 ELSE 0 END),
          0
        )::int AS present_count,
        COALESCE(
          SUM(CASE WHEN at.status = 'absent' THEN 1 ELSE 0 END),
          0
        )::int AS absent_count,
        COALESCE(
          SUM(CASE WHEN at.id IS NULL THEN 1 ELSE 0 END),
          0
        )::int AS not_checked_count,
        COUNT(sbd.schedule_id)::int AS total_count,
        COALESCE(
          ROUND(
            100.0 * SUM(CASE WHEN at.status IN ('present', 'late', 'excused') THEN 1 ELSE 0 END)::numeric
            / NULLIF(COUNT(sbd.schedule_id), 0),
            2
          ),
          0
        )::float AS attendance_rate
      FROM schedules_by_date sbd
      LEFT JOIN attendances_teacher at
        ON at.schedule_id = sbd.schedule_id
       AND at.date = sbd.date
      GROUP BY sbd.date
      ORDER BY sbd.date ASC
    `);

    return getRows(result);
  }
}
