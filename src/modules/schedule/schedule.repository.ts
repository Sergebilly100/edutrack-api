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
  start_date: string | null;
  end_date: string | null;
  attendance_status: 'present' | 'absent' | 'late' | null;
  attendance_checked_in_at: string | null;
  attendance_late_minutes: number | null;
  past_attendance_count: number;
};

export type ActiveSchedule = {
  id: string;
  schedulePeriodId: string;
  dayOfWeek: number;
  subject: string;
  startDate: string | null;
  endDate: string | null;
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
    status: 'present' | 'absent' | 'late' | null;
    checkedInAt: string | null;
    lateMinutes: number | null;
  };
  pastAttendanceCount: number;
  hasPastAttendance: boolean;
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
  teaching_assignments: Array<{ subjectId: string; subjectName: string; classId: string; className: string }>;
};

export type TeacherCatalogItem = {
  id: string;
  name: string;
  username: string;
  isBlocked?: boolean;
  subjects: string[];
  teachingAssignments: Array<{ subjectId: string; subjectName: string; classId: string; className: string }>;
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

type TimeSlotByIdRow = {
  id: string;
  start_time: string;
  end_time: string;
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
  startDate?: string | null;
  endDate?: string | null;
  isActive?: boolean;
};

export type ScheduleConflictResult = {
  teacherConflict: boolean;
  roomConflict: boolean;
  classConflict: boolean;
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
  teachingAssignments: row.teaching_assignments ?? [],
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
  startDate: row.start_date,
  endDate: row.end_date,
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
  pastAttendanceCount: row.past_attendance_count,
  hasPastAttendance: row.past_attendance_count > 0,
});

const buildActiveScheduleClause = (
  input: { date: string } | { fromDate: string; toDate: string }
) => {
  if ('date' in input) {
    return sql`
      s.is_active = true
      AND (s.start_date IS NULL OR s.start_date <= ${input.date}::date)
      AND (s.end_date IS NULL OR s.end_date > ${input.date}::date)
    `;
  }

  return sql`
    s.is_active = true
    AND (s.start_date IS NULL OR s.start_date <= ${input.toDate}::date)
    AND (s.end_date IS NULL OR s.end_date > ${input.fromDate}::date)
  `;
};

export const ensureScheduleTemporalColumns = async (db: QueryExecutor): Promise<void> => {
  await db.execute(sql`
    ALTER TABLE schedules
    ADD COLUMN IF NOT EXISTS start_date date
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS schedule_exceptions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      schedule_id uuid NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
      exception_date date NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS schedule_exceptions_schedule_date_unique
      ON schedule_exceptions (schedule_id, exception_date)
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_schedule_exceptions_schedule
      ON schedule_exceptions (schedule_id)
  `);
};

// Ajouter une exception pour un créneau récurrent à une date donnée (utilisé pour masquer une occurrence d'un créneau récurrent en cas de modification avec portée "this" ou de suppression d'une occurrence spécifique). 
// L'exception est ajoutée dans la table schedule_exceptions, et la requête de récupération des créneaux actifs doit être modifiée pour exclure les créneaux qui ont une exception pour la date concernée.
export const addScheduleException = async (
  db: QueryExecutor,
  scheduleId: string,
  exceptionDate: string
): Promise<void> => {
  await db.execute(sql`
    INSERT INTO schedule_exceptions (schedule_id, exception_date)
    VALUES (${scheduleId}, ${exceptionDate}::date)
    ON CONFLICT (schedule_id, exception_date) DO NOTHING
  `);
};

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

export const listActiveSchedulePeriods = async (
  db: QueryExecutor,
  todayIso: string
): Promise<SchedulePeriod[]> => {
  const result = await db.execute<SchedulePeriodRow>(sql`
    SELECT id, name, valid_from, valid_to, is_active, created_by, created_at
    FROM schedule_periods
    WHERE is_active = true
      AND valid_to >= ${todayIso}
    ORDER BY valid_from ASC, created_at DESC
  `);

  return getRows<SchedulePeriodRow>(result).map(mapPeriod);
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

export const findActiveSchedulePeriodByWeek = async (
  db: QueryExecutor,
  weekStart: string,
  weekEnd: string
): Promise<SchedulePeriod | null> => {
  const result = await db.execute<SchedulePeriodRow>(sql`
    SELECT id, name, valid_from, valid_to, is_active, created_by, created_at
    FROM schedule_periods
    WHERE is_active = true
      AND valid_from <= ${weekEnd}
      AND valid_to >= ${weekStart}
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
        end_date,
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
        s.end_date,
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
      s.start_date::text AS start_date,
      s.end_date::text AS end_date,
      at.status::text AS attendance_status,
      at.checked_in_at::text AS attendance_checked_in_at,
      at.late_minutes AS attendance_late_minutes,
      COALESCE(history.past_attendance_count, 0)::int AS past_attendance_count
    FROM schedules s
    INNER JOIN teachers t ON t.id = s.teacher_id
    INNER JOIN users u ON u.id = t.user_id
    INNER JOIN classes c ON c.id = s.class_id
    INNER JOIN rooms r ON r.id = s.room_id
    INNER JOIN time_slots ts ON ts.id = s.time_slot_id
    LEFT JOIN attendances_teacher at ON at.schedule_id = s.id AND at.date = ${params.date}
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS past_attendance_count
      FROM attendances_teacher ath
      WHERE ath.schedule_id = s.id
        AND ath.date < CURRENT_DATE
    ) history ON true
    WHERE s.schedule_period_id = ${params.periodId}
      AND s.day_of_week = ${params.dayOfWeek}
      AND ${buildActiveScheduleClause({ date: params.date })}
      AND NOT EXISTS (
        SELECT 1 FROM schedule_exceptions se
        WHERE se.schedule_id = s.id AND se.exception_date = ${params.date}::date
      )
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
    weekStart?: string;
    weekEnd?: string;
  }
): Promise<ActiveSchedule[]> => {
  const dayFilter =
    params.weekStart && params.weekEnd // Si on a une plage de semaine, on filtre les créneaux pour ne récupérer que ceux qui ont un jour de semaine correspondant à au moins une date de la plage (pour éviter de récupérer des créneaux qui ne sont pas actifs du tout sur la plage, même s'ils sont actifs à la date ciblée).
      ? sql`
        AND s.day_of_week IN (
          SELECT DISTINCT EXTRACT(ISODOW FROM d)::int
          FROM generate_series(
            GREATEST(sp.valid_from, ${params.weekStart}::date),
            LEAST(sp.valid_to, ${params.weekEnd}::date),
            interval '1 day'
          ) AS d
          WHERE EXTRACT(ISODOW FROM d)::int BETWEEN 1 AND 6
        )
      `
      : sql``;

  const temporalFilter = params.weekStart && params.weekEnd // Si on a une plage de semaine, on doit vérifier que le créneau est actif sur au moins une date de la plage (en vérifiant que la date de début et de fin du créneau recouvre au moins une date de la plage). Si on n'a pas de plage de semaine, on vérifie juste que le créneau est actif à la date ciblée.
    ? sql`
      (
        s.start_date IS NULL OR s.start_date <= (${params.weekStart}::date + ((s.day_of_week - 1) * INTERVAL '1 day'))::date
      )
      AND (
        s.end_date IS NULL OR s.end_date > (${params.weekStart}::date + ((s.day_of_week - 1) * INTERVAL '1 day'))::date
      )
    `
    : buildActiveScheduleClause({ date: params.date });

  const exceptionFilter = params.weekStart // Si on a une plage de semaine, on doit exclure les créneaux qui ont une exception sur au moins une date de la plage (pour éviter d'inclure des créneaux qui sont actifs à la date ciblée mais qui ont une exception sur une autre date de la semaine, ce qui fait que le créneau n'est pas actif du tout sur la semaine). Si on n'a pas de plage de semaine, on exclut juste les créneaux qui ont une exception à la date ciblée.
    ? sql`
      AND NOT EXISTS (
        SELECT 1 FROM schedule_exceptions se
        WHERE se.schedule_id = s.id
          AND se.exception_date = (${params.weekStart}::date + ((s.day_of_week - 1) * INTERVAL '1 day'))::date
      )
    `
    : sql`
      AND NOT EXISTS (
        SELECT 1 FROM schedule_exceptions se
        WHERE se.schedule_id = s.id AND se.exception_date = ${params.date}::date
      )
    `;

  // la logique de filtrage temporel est un peu complexe pour gérer à la fois le cas où on veut récupérer les créneaux actifs à une date donnée (dans ce cas on vérifie que le créneau est actif à cette date) et le cas où on veut récupérer les créneaux actifs sur une semaine donnée (dans ce cas on vérifie que le créneau est actif sur au moins une date de la semaine, et on exclut les créneaux qui ont une exception sur au moins une date de la semaine).
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
      s.start_date::text AS start_date,
      s.end_date::text AS end_date,
      at.status::text AS attendance_status,
      at.checked_in_at::text AS attendance_checked_in_at,
      at.late_minutes AS attendance_late_minutes,
      COALESCE(history.past_attendance_count, 0)::int AS past_attendance_count
    FROM schedules s
    INNER JOIN teachers t ON t.id = s.teacher_id
    INNER JOIN users u ON u.id = t.user_id
    INNER JOIN classes c ON c.id = s.class_id
    INNER JOIN rooms r ON r.id = s.room_id
    INNER JOIN time_slots ts ON ts.id = s.time_slot_id
    INNER JOIN schedule_periods sp ON sp.id = s.schedule_period_id
    LEFT JOIN attendances_teacher at ON at.schedule_id = s.id AND at.date = ${params.date}
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS past_attendance_count
      FROM attendances_teacher ath
      WHERE ath.schedule_id = s.id
        AND ath.date < CURRENT_DATE
    ) history ON true
    WHERE s.schedule_period_id = ${params.periodId}
      AND s.day_of_week BETWEEN 1 AND 6
      AND ${temporalFilter}
      ${exceptionFilter}
      ${dayFilter}
    ORDER BY s.day_of_week ASC, ts.sort_order ASC, ts.start_time ASC, u.name ASC
  `);

  return getRows<ActiveScheduleRow>(result).map(mapActiveSchedule);
};

export const listTeachersCatalog = async (
  db: QueryExecutor
): Promise<TeacherCatalogItem[]> => {
  const result = await db.execute<TeacherCatalogRow>(sql`
    SELECT
      t.id, u.name, t.username, t.is_blocked, t.subjects,
      COALESCE((
        SELECT json_agg(json_build_object(
          'subjectId', tsa.subject_id::text,
          'subjectName', sub.name,
          'classId', tsa.class_id::text,
          'className', c.name
        ) ORDER BY sub.name, c.name)
        FROM teacher_subject_assignments tsa
        INNER JOIN subjects sub ON sub.id = tsa.subject_id
        INNER JOIN classes c ON c.id = tsa.class_id
        WHERE tsa.teacher_id = t.id
      ), '[]'::json) AS teaching_assignments
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
    SELECT c.id, c.name
    FROM classes c
    WHERE c.is_active = true
      AND (
        c.school_year_id IS NULL
        OR c.school_year_id = (SELECT id FROM school_years WHERE status = 'active' LIMIT 1)
      )
    ORDER BY c.name ASC
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

export const findTimeSlotById = async (
  db: QueryExecutor,
  timeSlotId: string
): Promise<{ id: string; startTime: string; endTime: string } | null> => {
  const result = await db.execute<TimeSlotByIdRow>(sql`
    SELECT id, start_time::text AS start_time, end_time::text AS end_time
    FROM time_slots
    WHERE id = ${timeSlotId}
    LIMIT 1
  `);

  const [row] = getRows<TimeSlotByIdRow>(result);
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    startTime: row.start_time,
    endTime: row.end_time,
  };
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
      start_date,
      end_date,
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
      ${input.startDate ?? null}::date,
      ${input.endDate ?? null}::date,
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
      start_date = CASE
        WHEN ${input.startDate !== undefined}
          THEN ${input.startDate ?? null}::date
        ELSE start_date
      END,
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

export const findScheduleConflicts = async (
  db: QueryExecutor,
  input: ScheduleMutationInput & { excludeScheduleId?: string; referenceDate: string }
): Promise<ScheduleConflictResult> => {
  const result = await db.execute<{
    teacher_conflict: boolean;
    room_conflict: boolean;
    class_conflict: boolean;
  }>(sql`
    WITH target_period AS (
      SELECT valid_from, valid_to
      FROM schedule_periods
      WHERE id = ${input.schedulePeriodId}
      LIMIT 1
    ),
    overlapping_periods AS (
      SELECT sp.id
      FROM schedule_periods sp
      CROSS JOIN target_period tp
      WHERE sp.is_active = true
        AND sp.valid_from <= tp.valid_to
        AND sp.valid_to >= tp.valid_from
    )
    SELECT
      EXISTS (
        SELECT 1
        FROM schedules s
        WHERE s.is_active = true
          AND (s.start_date IS NULL OR s.start_date <= ${input.referenceDate}::date)
          AND (s.end_date IS NULL OR s.end_date > ${input.referenceDate}::date)
          AND s.schedule_period_id IN (SELECT id FROM overlapping_periods)
          AND s.day_of_week = ${input.dayOfWeek}
          AND s.time_slot_id = ${input.timeSlotId}
          AND s.teacher_id = ${input.teacherId}
          AND (${input.excludeScheduleId ?? null}::uuid IS NULL OR s.id <> ${input.excludeScheduleId ?? null}::uuid)
      ) AS teacher_conflict,
      EXISTS (
        SELECT 1
        FROM schedules s
        WHERE s.is_active = true
          AND (s.start_date IS NULL OR s.start_date <= ${input.referenceDate}::date)
          AND (s.end_date IS NULL OR s.end_date > ${input.referenceDate}::date)
          AND s.schedule_period_id IN (SELECT id FROM overlapping_periods)
          AND s.day_of_week = ${input.dayOfWeek}
          AND s.time_slot_id = ${input.timeSlotId}
          AND s.room_id = ${input.roomId}
          AND (${input.excludeScheduleId ?? null}::uuid IS NULL OR s.id <> ${input.excludeScheduleId ?? null}::uuid)
      ) AS room_conflict,
      EXISTS (
        SELECT 1
        FROM schedules s
        WHERE s.is_active = true
          AND (s.start_date IS NULL OR s.start_date <= ${input.referenceDate}::date)
          AND (s.end_date IS NULL OR s.end_date > ${input.referenceDate}::date)
          AND s.schedule_period_id IN (SELECT id FROM overlapping_periods)
          AND s.day_of_week = ${input.dayOfWeek}
          AND s.time_slot_id = ${input.timeSlotId}
          AND s.class_id = ${input.classId}
          AND (${input.excludeScheduleId ?? null}::uuid IS NULL OR s.id <> ${input.excludeScheduleId ?? null}::uuid)
      ) AS class_conflict
  `);

  const [row] = getRows(result);
  return {
    teacherConflict: row?.teacher_conflict ?? false,
    roomConflict: row?.room_conflict ?? false,
    classConflict: row?.class_conflict ?? false,
  };
};

export const hasPastOccurrences = async (
  db: QueryExecutor,
  scheduleId: string,
  today: string
): Promise<boolean> => {
  const result = await db.execute<{ has_past_occurrence: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1
      FROM attendances_teacher at
      WHERE at.schedule_id = ${scheduleId}
        AND at.date < ${today}::date
      LIMIT 1
    ) AS has_past_occurrence
  `);

  const [row] = getRows(result);
  return row?.has_past_occurrence ?? false;
};

export const countPastTeacherAttendancesForSchedule = async (
  db: QueryExecutor,
  scheduleId: string,
  today: string
): Promise<number> => {
  const result = await db.execute<{ count: string | number }>(sql`
    SELECT COUNT(*)::int AS count
    FROM attendances_teacher at
    WHERE at.schedule_id = ${scheduleId}
      AND at.date < ${today}::date
  `);

  const [row] = getRows(result);
  const value = Number(row?.count ?? 0);
  return Number.isFinite(value) ? value : 0;
};

export const hasAnyAttendanceForSchedule = async (
  db: QueryExecutor,
  scheduleId: string
): Promise<boolean> => {
  const result = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM attendances_teacher WHERE schedule_id = ${scheduleId}
    ) AS exists
  `);
  const [row] = getRows<{ exists: boolean }>(result);
  return !!row?.exists;
};

export const hasScheduleOccurrenceBeforeDate = async (
  db: QueryExecutor,
  scheduleId: string,
  beforeDate: string
): Promise<boolean> => {
  const result = await db.execute<{ has_occurrence: boolean }>(sql`
    WITH target AS (
      SELECT
        s.day_of_week,
        COALESCE(s.start_date, sp.valid_from) AS effective_start_date,
        COALESCE(s.end_date, (sp.valid_to + INTERVAL '1 day')::date) AS effective_end_date,
        sp.valid_to
      FROM schedules s
      INNER JOIN schedule_periods sp ON sp.id = s.schedule_period_id
      WHERE s.id = ${scheduleId}
      LIMIT 1
    ),
    bounded AS (
      SELECT
        day_of_week,
        effective_start_date AS from_date,
        LEAST(
          (${beforeDate}::date - INTERVAL '1 day')::date,
          (effective_end_date - INTERVAL '1 day')::date,
          valid_to
        ) AS to_date
      FROM target
    )
    SELECT EXISTS (
      SELECT 1
      FROM bounded b
      WHERE b.from_date <= b.to_date
        AND EXISTS (
          SELECT 1
          FROM generate_series(b.from_date, b.to_date, INTERVAL '1 day') AS d
          WHERE EXTRACT(ISODOW FROM d)::int = b.day_of_week
          LIMIT 1
        )
    ) AS has_occurrence
  `);

  const [row] = getRows(result);
  return row?.has_occurrence ?? false;
};

export const closeScheduleAtDate = async (
  db: QueryExecutor,
  scheduleId: string,
  endDate: string
): Promise<{ id: string } | null> => {
  const result = await db.execute<{ id: string }>(sql`
    UPDATE schedules
    SET end_date = ${endDate}::date
    WHERE id = ${scheduleId}
    RETURNING id
  `);

  const [row] = getRows(result);
  return row ?? null;
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
  // distingue en suffixant - mais en pratique "08:00 – 09:30" est unique.
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
