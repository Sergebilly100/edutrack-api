import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { QueryResult, QueryResultRow } from 'pg';

export type QueryExecutor = NodePgDatabase<Record<string, unknown>>;

export type SchedulePeriod = {
  id: string;
  name: string;
  valid_from: string;
  valid_to: string;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
};

type SchedulePeriodRow = SchedulePeriod;

type ActiveScheduleRow = {
  id: string;
  schedule_period_id: string;
  teacher_id: string;
  teacher_name: string;
  teacher_username: string;
  class_id: string;
  class_name: string;
  room_id: string;
  room_name: string;
  room_qr_token: string;
  time_slot_id: string;
  time_slot_label: string;
  start_time: string;
  end_time: string;
  sort_order: number;
  day_of_week: number;
  subject: string;
  attendance_status: 'present' | 'absent' | 'late' | 'excused' | null;
  attendance_checked_in_at: string | null;
  attendance_late_minutes: number | null;
};

export type ActiveSchedule = {
  id: string;
  schedulePeriodId: string;
  dayOfWeek: number;
  subject: string;
  teacher: {
    id: string;
    name: string;
    username: string;
  };
  class: {
    id: string;
    name: string;
  };
  room: {
    id: string;
    name: string;
    qrToken: string;
  };
  timeSlot: {
    id: string;
    label: string;
    startTime: string;
    endTime: string;
    sortOrder: number;
  };
  attendance: {
    status: 'present' | 'absent' | 'late' | 'excused' | null;
    checkedInAt: string | null;
    lateMinutes: number | null;
  };
};

type RoomRow = {
  id: string;
  name: string;
  qr_token: string;
  building: string | null;
  capacity: number | null;
  is_active: boolean;
  created_at: string;
};

export type Room = {
  id: string;
  name: string;
  qrToken: string;
  building: string | null;
  capacity: number | null;
  isActive: boolean;
  createdAt: string;
};

type TeacherCatalogRow = {
  id: string;
  name: string;
  username: string;
  is_blocked?: boolean;
  subjects: string[];
};

export type TeacherCatalogItem = {
  id: string;
  name: string;
  username: string;
  isBlocked?: boolean;
  subjects: string[];
};

type ClassCatalogRow = {
  id: string;
  name: string;
};

export type ClassCatalogItem = {
  id: string;
  name: string;
};

type TimeSlotCatalogRow = {
  id: string;
  label: string;
  start_time: string;
  end_time: string;
  sort_order: number;
};

export type TimeSlotCatalogItem = {
  id: string;
  label: string;
  startTime: string;
  endTime: string;
  sortOrder: number;
};

export type PeriodInsertInput = {
  name: string;
  validFrom: string;
  validTo: string;
  createdBy: string | null;
};

export type PeriodUpdateInput = {
  name?: string;
  validFrom?: string;
  validTo?: string;
  isActive?: boolean;
};

export type ScheduleMutationInput = {
  schedulePeriodId: string;
  teacherId: string;
  classId: string;
  roomId: string;
  timeSlotId: string;
  dayOfWeek: number;
  subject: string;
  isActive?: boolean;
};

export type RoomInsertInput = {
  name: string;
  qrToken: string;
  building?: string | null;
  capacity?: number | null;
  isActive?: boolean;
};

export type RoomUpdateInput = {
  name?: string;
  building?: string | null;
  capacity?: number | null;
  isActive?: boolean;
};

type DuplicatePeriodRow = SchedulePeriodRow & { copied_count: string | number };

const getRows = <TRow extends QueryResultRow>(result: QueryResult<TRow>): TRow[] =>
  result.rows;

const mapPeriod = (row: SchedulePeriodRow): SchedulePeriod => ({
  id: row.id,
  name: row.name,
  valid_from: row.valid_from,
  valid_to: row.valid_to,
  is_active: row.is_active,
  created_by: row.created_by,
  created_at: row.created_at,
});

const mapRoom = (row: RoomRow): Room => ({
  id: row.id,
  name: row.name,
  qrToken: row.qr_token,
  building: row.building,
  capacity: row.capacity,
  isActive: row.is_active,
  createdAt: row.created_at,
});

const mapTeacherCatalogItem = (row: TeacherCatalogRow): TeacherCatalogItem => ({
  id: row.id,
  name: row.name,
  username: row.username,
  isBlocked: row.is_blocked,
  subjects: row.subjects ?? [],
});

const mapClassCatalogItem = (row: ClassCatalogRow): ClassCatalogItem => ({
  id: row.id,
  name: row.name,
});

const mapTimeSlotCatalogItem = (row: TimeSlotCatalogRow): TimeSlotCatalogItem => ({
  id: row.id,
  label: row.label,
  startTime: row.start_time,
  endTime: row.end_time,
  sortOrder: row.sort_order,
});

const mapActiveSchedule = (row: ActiveScheduleRow): ActiveSchedule => ({
  id: row.id,
  schedulePeriodId: row.schedule_period_id,
  dayOfWeek: row.day_of_week,
  subject: row.subject,
  teacher: {
    id: row.teacher_id,
    name: row.teacher_name,
    username: row.teacher_username,
  },
  class: {
    id: row.class_id,
    name: row.class_name,
  },
  room: {
    id: row.room_id,
    name: row.room_name,
    qrToken: row.room_qr_token,
  },
  timeSlot: {
    id: row.time_slot_id,
    label: row.time_slot_label,
    startTime: row.start_time,
    endTime: row.end_time,
    sortOrder: row.sort_order,
  },
  attendance: {
    status: row.attendance_status,
    checkedInAt: row.attendance_checked_in_at,
    lateMinutes: row.attendance_late_minutes,
  },
});

export const listSchedulePeriods = async (db: QueryExecutor): Promise<SchedulePeriod[]> => {
  const result = await db.execute<SchedulePeriodRow>(sql`
    SELECT id, name, valid_from, valid_to, is_active, created_by, created_at
    FROM schedule_periods
    ORDER BY valid_from DESC, created_at DESC
  `);

  return getRows<SchedulePeriodRow>(result).map(mapPeriod);
};

export const createSchedulePeriod = async (
  db: QueryExecutor,
  input: PeriodInsertInput
): Promise<SchedulePeriod> => {
  const result = await db.execute<SchedulePeriodRow>(sql`
    INSERT INTO schedule_periods (name, valid_from, valid_to, is_active, created_by)
    VALUES (${input.name}, ${input.validFrom}, ${input.validTo}, true, ${input.createdBy})
    RETURNING id, name, valid_from, valid_to, is_active, created_by, created_at
  `);

  const [row] = getRows<SchedulePeriodRow>(result);
  if (!row) {
    throw new Error('Failed to create schedule period');
  }

  return mapPeriod(row);
};

export const updateSchedulePeriod = async (
  db: QueryExecutor,
  periodId: string,
  input: PeriodUpdateInput
): Promise<SchedulePeriod | null> => {
  const result = await db.execute<SchedulePeriodRow>(sql`
    UPDATE schedule_periods
    SET
      name = CASE WHEN ${input.name !== undefined} THEN ${input.name ?? null} ELSE name END,
      valid_from = CASE WHEN ${input.validFrom !== undefined} THEN ${
        input.validFrom ?? null
      }::date ELSE valid_from END,
      valid_to = CASE WHEN ${input.validTo !== undefined} THEN ${
        input.validTo ?? null
      }::date ELSE valid_to END,
      is_active = CASE WHEN ${input.isActive !== undefined} THEN ${
        input.isActive ?? null
      }::boolean ELSE is_active END
    WHERE id = ${periodId}
    RETURNING id, name, valid_from, valid_to, is_active, created_by, created_at
  `);

  const [row] = getRows<SchedulePeriodRow>(result);
  return row ? mapPeriod(row) : null;
};

export const findSchedulePeriodById = async (
  db: QueryExecutor,
  periodId: string
): Promise<SchedulePeriod | null> => {
  const result = await db.execute<SchedulePeriodRow>(sql`
    SELECT id, name, valid_from, valid_to, is_active, created_by, created_at
    FROM schedule_periods
    WHERE id = ${periodId}
    LIMIT 1
  `);

  const [row] = getRows<SchedulePeriodRow>(result);
  return row ? mapPeriod(row) : null;
};

export const findActiveSchedulePeriodByDate = async (
  db: QueryExecutor,
  date: string
): Promise<SchedulePeriod | null> => {
  const result = await db.execute<SchedulePeriodRow>(sql`
    SELECT id, name, valid_from, valid_to, is_active, created_by, created_at
    FROM schedule_periods
    WHERE is_active = true
      AND valid_from <= ${date}
      AND valid_to >= ${date}
    ORDER BY created_at DESC
    LIMIT 1
  `);

  const [row] = getRows<SchedulePeriodRow>(result);
  return row ? mapPeriod(row) : null;
};

export const duplicatePeriodWithSchedules = async (
  db: QueryExecutor,
  sourcePeriodId: string,
  newPeriod: PeriodInsertInput
): Promise<{ period: SchedulePeriod; copiedCount: number }> => {
  const result = await db.execute<DuplicatePeriodRow>(sql`
    WITH source AS (
      SELECT id
      FROM schedule_periods
      WHERE id = ${sourcePeriodId}
    ),
    new_period AS (
      INSERT INTO schedule_periods (name, valid_from, valid_to, is_active, created_by)
      SELECT ${newPeriod.name}, ${newPeriod.validFrom}, ${newPeriod.validTo}, true, ${newPeriod.createdBy}
      FROM source
      RETURNING id, name, valid_from, valid_to, is_active, created_by, created_at
    ),
    copied_rows AS (
      INSERT INTO schedules (
        schedule_period_id,
        teacher_id,
        class_id,
        room_id,
        time_slot_id,
        day_of_week,
        subject,
        is_active
      )
      SELECT
        np.id,
        s.teacher_id,
        s.class_id,
        s.room_id,
        s.time_slot_id,
        s.day_of_week,
        s.subject,
        s.is_active
      FROM schedules s
      CROSS JOIN new_period np
      WHERE s.schedule_period_id = ${sourcePeriodId}
      RETURNING 1
    )
    SELECT
      np.id,
      np.name,
      np.valid_from,
      np.valid_to,
      np.is_active,
      np.created_by,
      np.created_at,
      (SELECT COUNT(*) FROM copied_rows) AS copied_count
    FROM new_period np
  `);

  const [row] = getRows<DuplicatePeriodRow>(result);
  if (!row) {
    throw new Error('Source schedule period not found');
  }

  return {
    period: mapPeriod(row),
    copiedCount: Number(row.copied_count),
  };
};

export const listSchedulesForPeriodAndDay = async (
  db: QueryExecutor,
  params: {
    periodId: string;
    dayOfWeek: number;
    date: string;
    teacherId?: string;
  }
): Promise<ActiveSchedule[]> => {
  const teacherFilter = params.teacherId
    ? sql`AND s.teacher_id = ${params.teacherId}`
    : sql``;

  const result = await db.execute<ActiveScheduleRow>(sql`
    SELECT
      s.id,
      s.schedule_period_id,
      s.teacher_id,
      u.name AS teacher_name,
      t.username AS teacher_username,
      s.class_id,
      c.name AS class_name,
      s.room_id,
      r.name AS room_name,
      r.qr_token AS room_qr_token,
      s.time_slot_id,
      ts.label AS time_slot_label,
      ts.start_time::text AS start_time,
      ts.end_time::text AS end_time,
      ts.sort_order,
      s.day_of_week,
      s.subject,
      at.status::text AS attendance_status,
      at.checked_in_at::text AS attendance_checked_in_at,
      at.late_minutes AS attendance_late_minutes
    FROM schedules s
    INNER JOIN teachers t ON t.id = s.teacher_id
    INNER JOIN users u ON u.id = t.user_id
    INNER JOIN classes c ON c.id = s.class_id
    INNER JOIN rooms r ON r.id = s.room_id
    INNER JOIN time_slots ts ON ts.id = s.time_slot_id
    LEFT JOIN attendances_teacher at ON at.schedule_id = s.id AND at.date = ${params.date}
    WHERE s.schedule_period_id = ${params.periodId}
      AND s.day_of_week = ${params.dayOfWeek}
      AND s.is_active = true
      ${teacherFilter}
    ORDER BY ts.sort_order ASC, ts.start_time ASC, u.name ASC
  `);

  return getRows<ActiveScheduleRow>(result).map(mapActiveSchedule);
};

export const listSchedulesForPeriod = async (
  db: QueryExecutor,
  params: {
    periodId: string;
    date: string;
  }
): Promise<ActiveSchedule[]> => {
  const result = await db.execute<ActiveScheduleRow>(sql`
    SELECT
      s.id,
      s.schedule_period_id,
      s.teacher_id,
      u.name AS teacher_name,
      t.username AS teacher_username,
      s.class_id,
      c.name AS class_name,
      s.room_id,
      r.name AS room_name,
      r.qr_token AS room_qr_token,
      s.time_slot_id,
      ts.label AS time_slot_label,
      ts.start_time::text AS start_time,
      ts.end_time::text AS end_time,
      ts.sort_order,
      s.day_of_week,
      s.subject,
      at.status::text AS attendance_status,
      at.checked_in_at::text AS attendance_checked_in_at,
      at.late_minutes AS attendance_late_minutes
    FROM schedules s
    INNER JOIN teachers t ON t.id = s.teacher_id
    INNER JOIN users u ON u.id = t.user_id
    INNER JOIN classes c ON c.id = s.class_id
    INNER JOIN rooms r ON r.id = s.room_id
    INNER JOIN time_slots ts ON ts.id = s.time_slot_id
    LEFT JOIN attendances_teacher at ON at.schedule_id = s.id AND at.date = ${params.date}
    WHERE s.schedule_period_id = ${params.periodId}
      AND s.day_of_week BETWEEN 1 AND 6
      AND s.is_active = true
    ORDER BY s.day_of_week ASC, ts.sort_order ASC, ts.start_time ASC, u.name ASC
  `);

  return getRows<ActiveScheduleRow>(result).map(mapActiveSchedule);
};

export const listTeachersCatalog = async (
  db: QueryExecutor
): Promise<TeacherCatalogItem[]> => {
  const result = await db.execute<TeacherCatalogRow>(sql`
    SELECT t.id, u.name, t.username, t.is_blocked, t.subjects
    FROM teachers t
    INNER JOIN users u ON u.id = t.user_id
    WHERE u.is_active = true
    ORDER BY u.name ASC
  `);

    return getRows<TeacherCatalogRow>(result).map(mapTeacherCatalogItem);
    // return getRows(result).map((row) => ({
    //   id: row.id,
    //   name: row.name,
    //   username: row.username,
    //   isBlocked: row.is_blocked,
    //   subjects: row.subjects ?? [],   // ← text[] PostgreSQL
    // }));
};

export const listClassesCatalog = async (
  db: QueryExecutor
): Promise<ClassCatalogItem[]> => {
  const result = await db.execute<ClassCatalogRow>(sql`
    SELECT id, name
    FROM classes
    ORDER BY name ASC
  `);

  return getRows<ClassCatalogRow>(result).map(mapClassCatalogItem);
};

export const listTimeSlotsCatalog = async (
  db: QueryExecutor
): Promise<TimeSlotCatalogItem[]> => {
  const result = await db.execute<TimeSlotCatalogRow>(sql`
    SELECT id, label, start_time::text AS start_time, end_time::text AS end_time, sort_order
    FROM time_slots
    ORDER BY sort_order ASC, start_time ASC
  `);

  return getRows<TimeSlotCatalogRow>(result).map(mapTimeSlotCatalogItem);
};

export const createSchedule = async (
  db: QueryExecutor,
  input: ScheduleMutationInput
): Promise<{ id: string }> => {
  const result = await db.execute<{ id: string }>(sql`
    INSERT INTO schedules (
      schedule_period_id,
      teacher_id,
      class_id,
      room_id,
      time_slot_id,
      day_of_week,
      subject,
      is_active
    )
    VALUES (
      ${input.schedulePeriodId},
      ${input.teacherId},
      ${input.classId},
      ${input.roomId},
      ${input.timeSlotId},
      ${input.dayOfWeek},
      ${input.subject},
      ${input.isActive ?? true}
    )
    RETURNING id
  `);

  const [row] = getRows<{ id: string }>(result);
  if (!row) {
    throw new Error('Failed to create schedule');
  }

  return row;
};

export const updateSchedule = async (
  db: QueryExecutor,
  scheduleId: string,
  input: ScheduleMutationInput
): Promise<{ id: string } | null> => {
  const result = await db.execute<{ id: string }>(sql`
    UPDATE schedules
    SET
      schedule_period_id = ${input.schedulePeriodId},
      teacher_id = ${input.teacherId},
      class_id = ${input.classId},
      room_id = ${input.roomId},
      time_slot_id = ${input.timeSlotId},
      day_of_week = ${input.dayOfWeek},
      subject = ${input.subject},
      is_active = ${input.isActive ?? true}
    WHERE id = ${scheduleId}
    RETURNING id
  `);

  const [row] = getRows<{ id: string }>(result);
  return row ?? null;
};

export const deleteScheduleById = async (
  db: QueryExecutor,
  scheduleId: string
): Promise<boolean> => {
  const result = await db.execute<{ id: string }>(sql`
    WITH clear_teacher_attendance AS (
      UPDATE attendances_teacher
      SET schedule_id = NULL
      WHERE schedule_id = ${scheduleId}
    ),
    clear_student_attendance AS (
      UPDATE attendances_student
      SET schedule_id = NULL
      WHERE schedule_id = ${scheduleId}
    ),
    deleted_schedule AS (
      DELETE FROM schedules
      WHERE id = ${scheduleId}
      RETURNING id
    )
    SELECT id
    FROM deleted_schedule
  `);

  return getRows<{ id: string }>(result).length > 0;
};

export const findTeacherIdByUserId = async (
  db: QueryExecutor,
  userId: string
): Promise<string | null> => {
  const result = await db.execute<{ id: string }>(sql`
    SELECT id
    FROM teachers
    WHERE user_id = ${userId}
    LIMIT 1
  `);

  const [row] = getRows<{ id: string }>(result);
  return row?.id ?? null;
};

export const listRooms = async (db: QueryExecutor): Promise<Room[]> => {
  const result = await db.execute<RoomRow>(sql`
    SELECT id, name, qr_token, building, capacity, is_active, created_at
    FROM rooms
    ORDER BY name ASC
  `);

  return getRows<RoomRow>(result).map(mapRoom);
};

export const createRoom = async (db: QueryExecutor, input: RoomInsertInput): Promise<Room> => {
  const result = await db.execute<RoomRow>(sql`
    INSERT INTO rooms (name, qr_token, building, capacity, is_active)
    VALUES (
      ${input.name},
      ${input.qrToken},
      ${input.building ?? null},
      ${input.capacity ?? null},
      ${input.isActive ?? true}
    )
    RETURNING id, name, qr_token, building, capacity, is_active, created_at
  `);

  const [row] = getRows<RoomRow>(result);
  if (!row) {
    throw new Error('Failed to create room');
  }

  return mapRoom(row);
};

export const updateRoom = async (
  db: QueryExecutor,
  roomId: string,
  input: RoomUpdateInput
): Promise<Room | null> => {
  const result = await db.execute<RoomRow>(sql`
    UPDATE rooms
    SET
      name = CASE WHEN ${input.name !== undefined} THEN ${input.name ?? null} ELSE name END,
      building = CASE WHEN ${input.building !== undefined} THEN ${
        input.building ?? null
      } ELSE building END,
      capacity = CASE WHEN ${input.capacity !== undefined} THEN ${
        input.capacity ?? null
      }::integer ELSE capacity END,
      is_active = CASE WHEN ${input.isActive !== undefined} THEN ${
        input.isActive ?? null
      }::boolean ELSE is_active END
    WHERE id = ${roomId}
    RETURNING id, name, qr_token, building, capacity, is_active, created_at
  `);

  const [row] = getRows<RoomRow>(result);
  return row ? mapRoom(row) : null;
};

export const findRoomById = async (db: QueryExecutor, roomId: string): Promise<Room | null> => {
  const result = await db.execute<RoomRow>(sql`
    SELECT id, name, qr_token, building, capacity, is_active, created_at
    FROM rooms
    WHERE id = ${roomId}
    LIMIT 1
  `);

  const [row] = getRows<RoomRow>(result);
  return row ? mapRoom(row) : null;
};

/**
 * Calcule le sort_order depuis une heure "HH:MM" (minutes depuis minuit).
 * Permet un tri naturel même pour des créneaux créés à la volée.
 */
const timeToSortOrder = (time: string): number => {
  const [h, m] = time.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/**
 * Génère le label affiché dans l'UI : "08:00 – 09:30"
 */
const buildTimeSlotLabel = (startTime: string, endTime: string): string =>
  `${startTime} – ${endTime}`;

export const findOrCreateTimeSlot = async (
  db: QueryExecutor,
  input: { startTime: string; endTime: string }
): Promise<TimeSlotCatalogItem> => {
  const label = buildTimeSlotLabel(input.startTime, input.endTime);
  const sortOrder = timeToSortOrder(input.startTime);

  // Upsert idempotent :
  // - ON CONFLICT sur (start_time, end_time) → DO NOTHING
  // - On récupère toujours la ligne via le SELECT final
  //
  // Note : la table time_slots a une contrainte UNIQUE sur `label`.
  // On utilise start_time + end_time comme clé naturelle de déduplication.
  // Si un label identique existe déjà avec des horaires différents, on le
  // distingue en suffixant — mais en pratique "08:00 – 09:30" est unique.
  const result = await db.execute<{
    id: string;
    label: string;
    start_time: string;
    end_time: string;
    sort_order: number;
  }>(sql`
    WITH inserted AS (
      INSERT INTO time_slots (label, start_time, end_time, sort_order)
      VALUES (
        ${label},
        ${input.startTime}::time,
        ${input.endTime}::time,
        ${sortOrder}
      )
      ON CONFLICT (label) DO NOTHING
      RETURNING id, label, start_time::text AS start_time, end_time::text AS end_time, sort_order
    )
    SELECT id, label, start_time::text AS start_time, end_time::text AS end_time, sort_order
    FROM inserted

    UNION ALL

    SELECT id, label, start_time::text AS start_time, end_time::text AS end_time, sort_order
    FROM time_slots
    WHERE start_time = ${input.startTime}::time
      AND end_time = ${input.endTime}::time

    LIMIT 1
  `);

  const [row] = result.rows;
  if (!row) {
    throw new Error(
      `findOrCreateTimeSlot: failed to upsert time_slot ${input.startTime}-${input.endTime}`
    );
  }

  return {
    id: row.id,
    label: row.label,
    startTime: row.start_time,
    endTime: row.end_time,
    sortOrder: Number(row.sort_order),
  };
};
