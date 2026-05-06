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

type ExistingTeacherAttendanceRow = {
  status: 'present' | 'absent' | 'late' | 'excused';
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

type StudentAbsenceNotificationCandidateRow = {
  tenant_id: string;
  student_id: string;
  student_first_name: string;
  parent_phone: string;
  parent_email: string | null;
  subject: string;
  school_phone: string | null;
};

// ── Nouveau type pour getTeacherAttendanceByDate ──────────────────────────────
type TeacherAttendanceByDateRow = {
  id: string;
  schedule_id: string;
  status: 'present' | 'absent' | 'late' | 'excused';
  late_minutes: number | null;
  date: string;
  room_scan_start_at: string | null;
  room_scan_end_at: string | null;
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
  room_mismatch: boolean;
  room_scanned_name: string | null;
  room_scanned_at: string | null;
  room_scan_end_at: string | null;
  checked_in_at: string | null;
  student_rollcall_done: boolean;
  student_present_count: number;
  student_absent_count: number;
  student_total_count: number;
};

type DirectorHistoryRow = {
  date: string;
  present_count: number;
  absent_count: number;
  not_checked_count: number;
  total_count: number;
  attendance_rate: number;
};

type DirectorHistoryDetailRow = {
  date: string;
  schedule_id: string;
  teacher_name: string;
  subject: string;
  class_name: string;
  room_name: string;
  start_time: string;
  end_time: string;
  attendance_status: 'present' | 'absent' | 'late' | 'excused' | null;
  late_minutes: number | null;
  checked_in_at: string | null;
  room_mismatch: boolean;
  room_scanned_name: string | null;
  room_scanned_at: string | null;
  room_scan_end_at: string | null;
  student_rollcall_done: boolean;
  student_present_count: number;
  student_absent_count: number;
  student_total_count: number;
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

  async markMissingTeacherAttendancesAsAbsent(): Promise<number> {
    const result = await this.db.execute<{ id: string }>(sql`
      WITH now_ctx AS (
        SELECT
          (NOW() AT TIME ZONE 'Africa/Abidjan')::date AS today,
          (NOW() AT TIME ZONE 'Africa/Abidjan') AS now_local,
          EXTRACT(ISODOW FROM (NOW() AT TIME ZONE 'Africa/Abidjan'))::int AS day_of_week
      ),
      active_period AS (
        SELECT id
        FROM schedule_periods
        WHERE is_active = true
          AND valid_from <= (SELECT today FROM now_ctx)
          AND valid_to >= (SELECT today FROM now_ctx)
        ORDER BY created_at DESC
        LIMIT 1
      ),
      due_schedules AS (
        SELECT
          s.teacher_id,
          s.id AS schedule_id,
          (SELECT today FROM now_ctx) AS date
        FROM schedules s
        INNER JOIN active_period ap ON ap.id = s.schedule_period_id
        INNER JOIN time_slots ts ON ts.id = s.time_slot_id
        CROSS JOIN now_ctx
        WHERE s.is_active = true
          AND (s.start_date IS NULL OR s.start_date <= now_ctx.today)
          AND (s.end_date IS NULL OR s.end_date > now_ctx.today)
          AND s.day_of_week = now_ctx.day_of_week
          AND (now_ctx.today::timestamp + ts.end_time + INTERVAL '15 minute') <= now_ctx.now_local
      )
      INSERT INTO attendances_teacher (
        teacher_id,
        schedule_id,
        date,
        status,
        room_mismatch,
        qr_alert_sent
      )
      SELECT
        ds.teacher_id,
        ds.schedule_id,
        ds.date,
        'absent',
        false,
        false
      FROM due_schedules ds
      ON CONFLICT (teacher_id, schedule_id, date)
      DO UPDATE SET
        status = 'absent',
        late_minutes = NULL
      WHERE attendances_teacher.checked_in_at IS NULL
        AND attendances_teacher.status <> 'excused'
      RETURNING id::text
    `);

    return getRows(result).length;
  }

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

  async getTeacherAttendance(params: {
    teacherId: string;
    scheduleId: string;
    date: string;
  }): Promise<ExistingTeacherAttendanceRow | null> {
    const result = await this.db.execute<ExistingTeacherAttendanceRow>(sql`
      SELECT
        status::text AS status,
        checked_in_at::text AS checked_in_at
      FROM attendances_teacher
      WHERE teacher_id = ${params.teacherId}
        AND schedule_id = ${params.scheduleId}
        AND date = ${params.date}
      LIMIT 1
    `);

    const [row] = getRows(result);
    return row ?? null;
  }

  async isTeacherQrSkipAllowed(schemaName: string): Promise<boolean> {
    const result = await this.db.execute<{ allow_teacher_qr_skip: boolean }>(sql`
      SELECT COALESCE(allow_teacher_qr_skip, false) AS allow_teacher_qr_skip
      FROM public.tenants
      WHERE schema_name = ${schemaName}
      LIMIT 1
    `);

    const [row] = getRows(result);
    return row?.allow_teacher_qr_skip ?? false;
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
          room_scan_end_at = NULL,
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
        at.date::text AS date,
        at.room_scan_start_at::text AS room_scan_start_at,
        at.room_scan_end_at::text AS room_scan_end_at
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

  async listStudentAbsenceNotificationCandidates(params: {
    schemaName: string;
    scheduleId: string;
    date: string;
    absentStudentIds: string[];
  }): Promise<
    Array<{
      tenantId: string;
      studentId: string;
      studentFirstName: string;
      parentPhone: string;
      parentEmail: string | null;
      subject: string;
      schoolPhone: string | null;
    }>
  > {
    if (params.absentStudentIds.length === 0) {
      return [];
    }

    const ids = Array.from(new Set(params.absentStudentIds));
    const placeholders = sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `
    );

    const result = await this.db.execute<StudentAbsenceNotificationCandidateRow>(sql`
      WITH tenant_ctx AS (
        SELECT id::text AS tenant_id
        FROM public.tenants
        WHERE schema_name = ${params.schemaName}
        LIMIT 1
      ),
      school_phone_ctx AS (
        SELECT phone AS school_phone
        FROM users
        WHERE role = 'director'
          AND is_active = true
          AND phone IS NOT NULL
        ORDER BY created_at ASC
        LIMIT 1
      )
      SELECT
        tc.tenant_id,
        st.id::text AS student_id,
        st.first_name AS student_first_name,
        st.parent_phone,
        parent_contact.email AS parent_email,
        s.subject,
        sp.school_phone
      FROM attendances_student ast
      INNER JOIN students st ON st.id = ast.student_id
      INNER JOIN schedules s ON s.id = ast.schedule_id
      CROSS JOIN tenant_ctx tc
      LEFT JOIN school_phone_ctx sp ON true
      LEFT JOIN LATERAL (
        SELECT p.email
        FROM parent_student_links psl
        INNER JOIN parent_subscriptions ps ON ps.id = psl.subscription_id
        INNER JOIN parents p ON p.id = psl.parent_id
        WHERE psl.student_id = st.id
          AND ps.status = 'active'
          AND p.email IS NOT NULL
        ORDER BY ps.ends_at DESC
        LIMIT 1
      ) parent_contact ON true
      WHERE ast.schedule_id = ${params.scheduleId}
        AND ast.date = ${params.date}::date
        AND ast.status = 'absent'
        AND ast.student_id IN (${placeholders})
        AND st.parent_phone IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM notifications_log n
          WHERE n.type = 'student_absent_parent'
            AND n.related_id = ast.schedule_id
            AND n.recipient_phone = st.parent_phone
            AND COALESCE(n.sent_at::date, n.created_at::date) = ast.date::date
            AND n.status <> 'failed'
        )
      ORDER BY st.last_name ASC, st.first_name ASC
    `);

    return getRows(result).map((row) => ({
      tenantId: row.tenant_id,
      studentId: row.student_id,
      studentFirstName: row.student_first_name,
      parentPhone: row.parent_phone,
      parentEmail: row.parent_email,
      subject: row.subject,
      schoolPhone: row.school_phone,
    }));
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
          WITH week_ctx AS (
            SELECT (
              ${date}::date
              - ((EXTRACT(ISODOW FROM ${date}::date)::int - 1) * INTERVAL '1 day')
            )::date AS week_start
          ),
          active_period AS (
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
          CROSS JOIN week_ctx wc
          WHERE t.user_id = ${userId}
            AND s.is_active = true
            AND (
              s.start_date IS NULL
              OR s.start_date <= (wc.week_start + ((s.day_of_week - 1) * INTERVAL '1 day'))::date
            )
            AND (
              s.end_date IS NULL
              OR s.end_date > (wc.week_start + ((s.day_of_week - 1) * INTERVAL '1 day'))::date
            )
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
          AND valid_from <= ${params.date}::date
          AND valid_to >= ${params.date}::date
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
       AND at.date = ${params.date}::date
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
        COALESCE(at.room_mismatch, false) AS room_mismatch,
        scanned_room.name AS room_scanned_name,
        at.room_scan_start_at::text AS room_scanned_at,
        at.room_scan_end_at::text AS room_scan_end_at,
        at.checked_in_at::text AS checked_in_at,
        CASE
          WHEN COUNT(ast.id) > 0 THEN true
          ELSE false
        END AS student_rollcall_done,
        COUNT(CASE WHEN ast.status = 'present' THEN 1 END)::int AS student_present_count,
        COUNT(CASE WHEN ast.status = 'absent' THEN 1 END)::int AS student_absent_count,
        COUNT(ast.id)::int AS student_total_count
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
      LEFT JOIN attendances_student ast
        ON ast.schedule_id = s.id
       AND ast.date = ${today}
      WHERE s.day_of_week = ${dayOfWeek}
        AND s.is_active = true
        AND (s.start_date IS NULL OR s.start_date <= ${today}::date)
        AND (s.end_date IS NULL OR s.end_date > ${today}::date)
      GROUP BY
        s.id,
        u.name,
        s.subject,
        c.name,
        r.name,
        ts.label,
        ts.start_time,
        ts.end_time,
        ts.sort_order,
        at.status,
        at.late_minutes,
        at.room_mismatch,
        scanned_room.name,
        at.room_scan_start_at,
        at.room_scan_end_at,
        at.checked_in_at
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
         AND (s.start_date IS NULL OR s.start_date <= d.date)
         AND (s.end_date IS NULL OR s.end_date > d.date)
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

  async listHistoryDetailForDirector(params: {
    from: string;
    to: string;
  }): Promise<DirectorHistoryDetailRow[]> {
    const result = await this.db.execute<DirectorHistoryDetailRow>(sql`
      WITH active_period AS (
        SELECT id
        FROM schedule_periods
        WHERE is_active = true
          AND valid_from <= ${params.to}::date
          AND valid_to   >= ${params.from}::date
        ORDER BY created_at DESC
        LIMIT 1
      ),
      dates AS (
        SELECT generate_series(
          ${params.from}::date,
          ${params.to}::date,
          INTERVAL '1 day'
        )::date AS date
      )
      SELECT
        d.date::text,
        s.id::text AS schedule_id,
        u.name AS teacher_name,
        s.subject,
        c.name AS class_name,
        r.name AS room_name,
        ts.start_time::text,
        ts.end_time::text,
        at.status::text AS attendance_status,
        at.late_minutes,
        at.checked_in_at::text,
        COALESCE(at.room_mismatch, false) AS room_mismatch,
        scanned_room.name AS room_scanned_name,
        at.room_scan_start_at::text AS room_scanned_at,
        at.room_scan_end_at::text AS room_scan_end_at,
        CASE WHEN COUNT(ast.id) > 0 THEN true ELSE false END AS student_rollcall_done,
        COUNT(CASE WHEN ast.status = 'present' THEN 1 END)::int AS student_present_count,
        COUNT(CASE WHEN ast.status = 'absent'  THEN 1 END)::int AS student_absent_count,
        COUNT(ast.id)::int AS student_total_count
      FROM dates d
      INNER JOIN active_period ap ON true
      INNER JOIN schedules s
        ON s.schedule_period_id = ap.id
       AND s.day_of_week = EXTRACT(ISODOW FROM d.date)::int
       AND s.is_active = true
       AND (s.start_date IS NULL OR s.start_date <= d.date)
       AND (s.end_date IS NULL OR s.end_date > d.date)
      INNER JOIN teachers t    ON t.id = s.teacher_id
      INNER JOIN users u       ON u.id = t.user_id
      INNER JOIN classes c     ON c.id = s.class_id
      INNER JOIN rooms r       ON r.id = s.room_id
      INNER JOIN time_slots ts ON ts.id = s.time_slot_id
      LEFT JOIN attendances_teacher at
        ON at.schedule_id = s.id AND at.date = d.date
      LEFT JOIN rooms scanned_room ON scanned_room.id = at.room_scanned_id
      LEFT JOIN attendances_student ast
        ON ast.schedule_id = s.id AND ast.date = d.date
      GROUP BY
        d.date, s.id, u.name, s.subject, c.name, r.name,
        ts.start_time, ts.end_time,
        at.status, at.late_minutes, at.checked_in_at,
        at.room_mismatch, scanned_room.name, at.room_scan_start_at, at.room_scan_end_at
      ORDER BY d.date DESC, ts.start_time ASC
    `);

    return getRows(result);
  }
}
