import { sql } from 'drizzle-orm';

import type {
  ImportType,
  ScheduleImportRow,
  StudentImportRow,
  TeacherImportRow,
} from './import.types.js';

export type QueryExecutor = {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
};

export type TransactionalQueryExecutor = QueryExecutor & {
  transaction: <T>(fn: (tx: QueryExecutor) => Promise<T>) => Promise<T>;
};

type ClassRow = { id: string; name: string };
type TeacherDirectoryRow = { teacher_id: string; user_id: string; name: string; username: string };
type RoomRow = { id: string; name: string; building: string | null; capacity: number | null; is_active: boolean };
type TimeSlotRow = { id: string; label: string; start_time: string; end_time: string };
type SchedulePeriodRow = { id: string; valid_from?: string; valid_to?: string };
type SchedulePeriodConflictRow = { id: string; name: string; valid_from: string; valid_to: string };
type ExistingStudentRow = { id: string; matricule: string | null };
type ExistingTeacherRow = { id: string; user_id: string };
type UserInsertRow = { id: string };
type TeacherInsertRow = { id: string; user_id: string };
type ScheduleInsertRow = { id: string };
type ImportHistoryRow = {
  id: string;
  imported_at: string;
  import_type: ImportType;
  imported_count: number;
  updated_count: number;
};

const getRows = <T>(result: unknown): T[] => {
  if (typeof result !== 'object' || result === null || !('rows' in result)) {
    return [];
  }

  const rows = (result as { rows?: T[] }).rows;
  return Array.isArray(rows) ? rows : [];
};

const ensureImportHistoryInfrastructure = async (db: QueryExecutor): Promise<void> => {
  await db.execute(sql.raw(`
    DO $$
    BEGIN
      CREATE TYPE import_type AS ENUM ('students', 'teachers', 'schedule');
    EXCEPTION
      WHEN duplicate_object THEN null;
    END
    $$;
  `));

  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS import_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      import_type import_type NOT NULL,
      imported_count integer DEFAULT 0 NOT NULL,
      updated_count integer DEFAULT 0 NOT NULL,
      imported_at timestamp with time zone DEFAULT now() NOT NULL
    );
  `));
};

export type ImportRepository = {
  listClasses: (db: QueryExecutor) => Promise<ClassRow[]>;
  listTeacherDirectory: (db: QueryExecutor) => Promise<TeacherDirectoryRow[]>;
  listRooms: (db: QueryExecutor) => Promise<RoomRow[]>;
  upsertRoom: (
    db: QueryExecutor,
    input: { name: string; qrToken: string; building?: string | null; capacity?: number | null }
  ) => Promise<{ id: string; name: string }>;
  listTimeSlots: (db: QueryExecutor) => Promise<TimeSlotRow[]>;
  findActiveSchedulePeriodId: (db: QueryExecutor, date: string) => Promise<string | null>;
  findSchedulePeriodById: (
    db: QueryExecutor,
    periodId: string
  ) => Promise<{ id: string; valid_from: string; valid_to: string } | null>;
  findOverlappingSchedulePeriods: (
    db: QueryExecutor,
    weekStart: string,
    weekEnd: string
  ) => Promise<SchedulePeriodConflictRow[]>;
  findOrCreateSchedulePeriod: (
    db: QueryExecutor,
    params: { name: string; validFrom: string; validTo: string }
  ) => Promise<string>;
  listExistingStudents: (
    db: QueryExecutor
  ) => Promise<
    Array<{
      id: string;
      key: string;
      matricule: string | null;
      firstName: string;
      lastName: string;
      className: string;
      birthDate: string | null;
      parentName: string | null;
      parentPhone: string | null;
      parentName2: string | null;
      parentPhone2: string | null;
      isActive: boolean;
    }>
  >;
  deactivateStudentsByIds: (db: QueryExecutor, ids: string[]) => Promise<number>;
  listExistingTeachers: (
    db: QueryExecutor
  ) => Promise<
    Array<{
      id: string;
      userId: string;
      key: string;
      name: string;
      username: string;
      matricule: string | null;
      type: 'vacataire' | 'permanent';
      subjects: string[];
      hourlyRate: number | null;
      monthlySalary: number | null;
      isActive: boolean;
    }>
  >;
  deactivateTeachersByIds: (db: QueryExecutor, ids: string[]) => Promise<number>;
  upsertStudent: (db: QueryExecutor, row: StudentImportRow) => Promise<'inserted' | 'updated'>;
  upsertTeacher: (
    db: QueryExecutor,
    row: TeacherImportRow,
    params: { displayName: string; passwordHash: string }
  ) => Promise<'inserted' | 'updated'>;
  upsertSchedule: (
    db: QueryExecutor,
    row: ScheduleImportRow,
    params: {
      schedulePeriodId: string;
      teacherId: string;
      classId: string;
      timeSlotId: string;
      roomId: string;
    }
  ) => Promise<'inserted' | 'updated'>;
  createImportHistory: (
    db: QueryExecutor,
    entry: {
      importType: ImportType;
      importedCount: number;
      updatedCount: number;
    }
  ) => Promise<void>;
  listImportHistory: (
    db: QueryExecutor,
    limit: number
  ) => Promise<ImportHistoryRow[]>;
};

export const defaultImportRepository: ImportRepository = {
  async listClasses(db) {
    const result = await db.execute(sql`
      SELECT id, name
      FROM classes
    `);

    return getRows<ClassRow>(result);
  },

  async listTeacherDirectory(db) {
    const result = await db.execute(sql`
      SELECT t.id AS teacher_id, t.user_id, u.name, t.username
      FROM teachers t
      INNER JOIN users u ON u.id = t.user_id
    `);

    return getRows<TeacherDirectoryRow>(result);
  },

  async listRooms(db) {
    const result = await db.execute(sql`
      SELECT id, name, building, capacity, is_active
      FROM rooms
    `);

    return getRows<RoomRow>(result);
  },

  async upsertRoom(db, input) {
    const result = await db.execute(sql`
      INSERT INTO rooms (name, qr_token, building, capacity, is_active)
      VALUES (${input.name}, ${input.qrToken}, ${input.building ?? null}, ${input.capacity ?? null}, true)
      ON CONFLICT (name)
      DO UPDATE SET
        is_active = true,
        building = COALESCE(EXCLUDED.building, rooms.building),
        capacity = COALESCE(EXCLUDED.capacity, rooms.capacity)
      RETURNING id, name
    `);

    const row = getRows<{ id: string; name: string }>(result)[0];
    if (!row) {
      throw new Error('Unable to upsert room');
    }

    return row;
  },

  async listTimeSlots(db) {
    const result = await db.execute(sql`
      SELECT id, label, start_time::text AS start_time, end_time::text AS end_time
      FROM time_slots
    `);

    return getRows<TimeSlotRow>(result);
  },

  async findActiveSchedulePeriodId(db, date) {
    const result = await db.execute(sql`
      SELECT id
      FROM schedule_periods
      WHERE is_active = true
        AND valid_from <= ${date}
        AND valid_to >= ${date}
      ORDER BY created_at DESC
      LIMIT 1
    `);

    return getRows<SchedulePeriodRow>(result)[0]?.id ?? null;
  },

  async findSchedulePeriodById(db, periodId) {
    const result = await db.execute(sql`
      SELECT id, valid_from::text AS valid_from, valid_to::text AS valid_to
      FROM schedule_periods
      WHERE id = ${periodId}
      LIMIT 1
    `);

    const row = getRows<{ id: string; valid_from: string; valid_to: string }>(result)[0];
    return row ?? null;
  },

  async findOverlappingSchedulePeriods(db, weekStart, weekEnd) {
    const result = await db.execute(sql`
      SELECT id, name, valid_from::text, valid_to::text
      FROM schedule_periods
      WHERE is_active = true
        AND valid_from <= ${weekEnd}
        AND valid_to >= ${weekStart}
      ORDER BY valid_from ASC, created_at ASC
    `);

    return getRows<SchedulePeriodConflictRow>(result);
  },

  async findOrCreateSchedulePeriod(db, params) {
    const existing = await db.execute(sql`
      SELECT id
      FROM schedule_periods
      WHERE valid_from = ${params.validFrom}
        AND valid_to = ${params.validTo}
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const existingId = getRows<SchedulePeriodRow>(existing)[0]?.id;
    if (existingId) {
      return existingId;
    }

    const created = await db.execute(sql`
      INSERT INTO schedule_periods (name, valid_from, valid_to, is_active)
      VALUES (${params.name}, ${params.validFrom}, ${params.validTo}, true)
      RETURNING id
    `);

    const createdId = getRows<SchedulePeriodRow>(created)[0]?.id;
    if (!createdId) {
      throw new Error('Unable to create schedule period');
    }

    return createdId;
  },

  async listExistingStudents(db) {
    const result = await db.execute(sql`
      SELECT
        s.id,
        LOWER(CONCAT(c.name, '::', s.first_name, '::', s.last_name)) AS key,
        s.matricule,
        s.first_name,
        s.last_name,
        c.name AS class_name,
        s.birth_date::text AS birth_date,
        s.parent_name,
        s.parent_phone,
        s.parent_name_2,
        s.parent_phone_2,
        s.is_active
      FROM students s
      INNER JOIN classes c ON c.id = s.class_id
    `);

    return getRows<{
      id: string;
      key: string;
      matricule: string | null;
      first_name: string;
      last_name: string;
      class_name: string;
      birth_date: string | null;
      parent_name: string | null;
      parent_phone: string | null;
      parent_name_2: string | null;
      parent_phone_2: string | null;
      is_active: boolean;
    }>(result).map((row) => ({
      id: row.id,
      key: row.key,
      matricule: row.matricule,
      firstName: row.first_name,
      lastName: row.last_name,
      className: row.class_name,
      birthDate: row.birth_date,
      parentName: row.parent_name,
      parentPhone: row.parent_phone,
      parentName2: row.parent_name_2,
      parentPhone2: row.parent_phone_2,
      isActive: row.is_active,
    }));
  },

  async deactivateStudentsByIds(db, ids) {
    if (ids.length === 0) {
      return 0;
    }

    const result = await db.execute(sql`
      WITH updated AS (
        UPDATE students
        SET is_active = false
        WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
          AND is_active = true
        RETURNING id
      )
      SELECT COUNT(*)::int AS count FROM updated
    `);

    const row = getRows<{ count: string | number }>(result)[0];
    const value = row ? Number(row.count) : 0;
    return Number.isFinite(value) ? value : 0;
  },

  async listExistingTeachers(db) {
    const result = await db.execute(sql`
      SELECT
        t.id,
        t.user_id,
        LOWER(u.name) AS key,
        u.name,
        t.username,
        t.matricule,
        t.type,
        t.subjects,
        t.hourly_rate,
        t.monthly_salary,
        u.is_active
      FROM teachers t
      INNER JOIN users u ON u.id = t.user_id
    `);

    return getRows<{
      id: string;
      user_id: string;
      key: string;
      name: string;
      username: string;
      matricule: string | null;
      type: 'vacataire' | 'permanent';
      subjects: string[] | null;
      hourly_rate: number | null;
      monthly_salary: number | null;
      is_active: boolean;
    }>(result).map((row) => ({
      id: row.id,
      userId: row.user_id,
      key: row.key,
      name: row.name,
      username: row.username,
      matricule: row.matricule,
      type: row.type,
      subjects: row.subjects ?? [],
      hourlyRate: row.hourly_rate,
      monthlySalary: row.monthly_salary,
      isActive: row.is_active,
    }));
  },

  async deactivateTeachersByIds(db, ids) {
    if (ids.length === 0) {
      return 0;
    }

    const result = await db.execute(sql`
      WITH updated AS (
        UPDATE users
        SET is_active = false
        WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
          AND is_active = true
        RETURNING id
      )
      SELECT COUNT(*)::int AS count FROM updated
    `);

    const row = getRows<{ count: string | number }>(result)[0];
    const value = row ? Number(row.count) : 0;
    return Number.isFinite(value) ? value : 0;
  },

  async upsertStudent(db, row) {
    const existingResult = row.matricule
      ? await db.execute(sql`
          SELECT id, matricule
          FROM students
          WHERE LOWER(matricule) = LOWER(${row.matricule})
          LIMIT 1
        `)
      : await db.execute(sql`
          SELECT id, matricule
          FROM students
          WHERE class_id = (
            SELECT c.id
            FROM classes c
            WHERE LOWER(c.name) = LOWER(${row.className})
            LIMIT 1
          )
            AND LOWER(first_name) = LOWER(${row.firstName})
            AND LOWER(last_name) = LOWER(${row.lastName})
          LIMIT 1
        `);

    const existing = getRows<ExistingStudentRow>(existingResult)[0];

    if (existing) {
      await db.execute(sql`
        UPDATE students
        SET
          matricule = ${row.matricule},
          birth_date = ${row.birthDate},
          parent_name = ${row.parentName},
          parent_phone = ${row.parentPhone},
          parent_name_2 = ${row.parentName2},
          parent_phone_2 = ${row.parentPhone2},
          is_active = true
        WHERE id = ${existing.id}
      `);

      return 'updated';
    }

    await db.execute(sql`
      INSERT INTO students (
        class_id,
        matricule,
        first_name,
        last_name,
        birth_date,
        parent_name,
        parent_phone,
        parent_name_2,
        parent_phone_2,
        is_active
      )
      VALUES (
        (
          SELECT c.id
          FROM classes c
          WHERE LOWER(c.name) = LOWER(${row.className})
          LIMIT 1
        ),
        ${row.matricule},
        ${row.firstName},
        ${row.lastName},
        ${row.birthDate},
        ${row.parentName},
        ${row.parentPhone},
        ${row.parentName2},
        ${row.parentPhone2},
        true
      )
    `);

    return 'inserted';
  },

  async upsertTeacher(db, row, params) {
    const subjectsSql =
      row.subjects.length > 0
        ? sql`ARRAY[${sql.join(row.subjects.map((subject) => sql`${subject}`), sql`, `)}]::text[]`
        : sql`'{}'::text[]`;

    const existingResult = await db.execute(sql`
      SELECT id, user_id
      FROM teachers
      WHERE username = ${row.username}
      LIMIT 1
    `);

    const existing = getRows<ExistingTeacherRow>(existingResult)[0];

    if (existing) {
      await db.execute(sql`
        UPDATE users
        SET name = ${params.displayName}
        WHERE id = ${existing.user_id}
      `);

      await db.execute(sql`
        UPDATE teachers
        SET
          matricule = ${row.matricule},
          type = ${row.type},
          subjects = ${subjectsSql},
          hourly_rate = ${row.hourlyRate},
          monthly_salary = ${row.monthlySalary}
        WHERE id = ${existing.id}
      `);

      return 'updated';
    }

    const userResult = await db.execute(sql`
      INSERT INTO users (
        role,
        name,
        phone,
        email,
        password_hash,
        is_active
      )
      VALUES (
        'teacher',
        ${params.displayName},
        null,
        null,
        ${params.passwordHash},
        true
      )
      RETURNING id
    `);

    const user = getRows<UserInsertRow>(userResult)[0];
    if (!user) {
      throw new Error('Unable to create teacher user');
    }

    const teacherResult = await db.execute(sql`
      INSERT INTO teachers (
        user_id,
        username,
        matricule,
        type,
        subjects,
        hourly_rate,
        monthly_salary
      )
      VALUES (
        ${user.id},
        ${row.username},
        ${row.matricule},
        ${row.type},
        ${subjectsSql},
        ${row.hourlyRate},
        ${row.monthlySalary}
      )
      ON CONFLICT (username)
      DO UPDATE SET
        matricule = EXCLUDED.matricule,
        type = EXCLUDED.type,
        subjects = EXCLUDED.subjects,
        hourly_rate = EXCLUDED.hourly_rate,
        monthly_salary = EXCLUDED.monthly_salary
      RETURNING id, user_id
    `);

    const teacher = getRows<TeacherInsertRow>(teacherResult)[0];
    if (!teacher) {
      throw new Error('Unable to upsert teacher');
    }

    return 'inserted';
  },

  async upsertSchedule(db, row, params) {
    const existingResult = await db.execute(sql`
      SELECT id
      FROM schedules
      WHERE schedule_period_id = ${params.schedulePeriodId}
        AND teacher_id = ${params.teacherId}
        AND time_slot_id = ${params.timeSlotId}
        AND day_of_week = ${row.dayOfWeek}
      LIMIT 1
    `);

    const existing = getRows<ScheduleInsertRow>(existingResult)[0];

    await db.execute(sql`
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
        ${params.schedulePeriodId},
        ${params.teacherId},
        ${params.classId},
        ${params.roomId},
        ${params.timeSlotId},
        ${row.dayOfWeek},
        ${row.subject},
        true
      )
      ON CONFLICT (schedule_period_id, teacher_id, time_slot_id, day_of_week)
      DO UPDATE SET
        class_id = EXCLUDED.class_id,
        room_id = EXCLUDED.room_id,
        subject = EXCLUDED.subject,
        is_active = true
    `);

    return existing ? 'updated' : 'inserted';
  },

  async createImportHistory(db, entry) {
    try {
      await db.execute(sql`
        INSERT INTO import_history (import_type, imported_count, updated_count)
        VALUES (${entry.importType}, ${entry.importedCount}, ${entry.updatedCount})
      `);
    } catch (error) {
      const pgError = error as { code?: string };
      if (pgError.code === '42P01' || pgError.code === '42704') {
        await ensureImportHistoryInfrastructure(db);
        await db.execute(sql`
          INSERT INTO import_history (import_type, imported_count, updated_count)
          VALUES (${entry.importType}, ${entry.importedCount}, ${entry.updatedCount})
        `);
        return;
      }
      throw error;
    }
  },

  async listImportHistory(db, limit) {
    try {
      const result = await db.execute(sql`
        SELECT id, imported_at::text AS imported_at, import_type, imported_count, updated_count
        FROM import_history
        ORDER BY imported_at DESC
        LIMIT ${limit}
      `);

      return getRows<ImportHistoryRow>(result);
    } catch (error) {
      const pgError = error as { code?: string };
      if (pgError.code === '42P01' || pgError.code === '42704') {
        await ensureImportHistoryInfrastructure(db);
        const retryResult = await db.execute(sql`
          SELECT id, imported_at::text AS imported_at, import_type, imported_count, updated_count
          FROM import_history
          ORDER BY imported_at DESC
          LIMIT ${limit}
        `);
        return getRows<ImportHistoryRow>(retryResult);
      }
      throw error;
    }
  },
};
