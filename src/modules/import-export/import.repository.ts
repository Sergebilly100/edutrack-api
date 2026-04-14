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
type RoomRow = { id: string; name: string };
type TimeSlotRow = { id: string; label: string };
type SchedulePeriodRow = { id: string };
type ExistingStudentRow = { id: string };
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
  listTimeSlots: (db: QueryExecutor) => Promise<TimeSlotRow[]>;
  findActiveSchedulePeriodId: (db: QueryExecutor, date: string) => Promise<string | null>;
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
      SELECT id, name
      FROM rooms
      WHERE is_active = true
    `);

    return getRows<RoomRow>(result);
  },

  async listTimeSlots(db) {
    const result = await db.execute(sql`
      SELECT id, label
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

  async upsertStudent(db, row) {
    const existingResult = await db.execute(sql`
      SELECT id
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
          parent_phone = ${row.parentPhone},
          is_active = true
        WHERE id = ${existing.id}
      `);

      return 'updated';
    }

    await db.execute(sql`
      INSERT INTO students (
        class_id,
        first_name,
        last_name,
        parent_phone,
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
        ${row.firstName},
        ${row.lastName},
        ${row.parentPhone},
        null,
        true
      )
    `);

    return 'inserted';
  },

  async upsertTeacher(db, row, params) {
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
          type = ${row.type},
          subjects = ${row.subjects},
          hourly_rate = ${row.hourlyRate}
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
        type,
        subjects,
        hourly_rate
      )
      VALUES (
        ${user.id},
        ${row.username},
        ${row.type},
        ${row.subjects},
        ${row.hourlyRate}
      )
      ON CONFLICT (username)
      DO UPDATE SET
        type = EXCLUDED.type,
        subjects = EXCLUDED.subjects,
        hourly_rate = EXCLUDED.hourly_rate
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
