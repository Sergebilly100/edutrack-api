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
type TeacherDirectoryRow = {
  teacher_id: string;
  user_id: string;
  name: string;
  username: string;
  subjects: string[] | null;
};
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
  schedule_period: string | null;
  imported_by: string | null;
  imported_by_name: string | null;
  imported_by_role: string | null;
};

export type ImportHistoryFilter = {
  limit: number;
  page: number;
  month?: string;   // "YYYY-MM"
  type?: ImportType;
};

export type ImportHistoryPage = {
  items: ImportHistoryRow[];
  total: number;
};

const getRows = <T>(result: unknown): T[] => {
  if (typeof result !== 'object' || result === null || !('rows' in result)) {
    return [];
  }

  const rows = (result as { rows?: unknown[] }).rows;
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows as T[];
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
  findOrCreateTimeSlot: (
    db: QueryExecutor,
    input: { label: string; startTime: string; endTime: string }
  ) => Promise<TimeSlotRow>;
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
      parentEmail: string | null;
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
      startDate: string | null;
    }
  ) => Promise<{ result: 'inserted' | 'updated'; id: string }>;
  deactivateSchedulesByPeriodExcluding: (
    db: QueryExecutor,
    schedulePeriodId: string,
    keepIds: string[]
  ) => Promise<number>;
  createImportHistory: (
    db: QueryExecutor,
    entry: {
      importType: ImportType;
      importedCount: number;
      updatedCount: number;
      schedulePeriod: string | null;
      importedBy?: string;
      importedByRole?: string;
    }
  ) => Promise<void>;
  listImportHistory: (
    db: QueryExecutor,
    filter: ImportHistoryFilter
  ) => Promise<ImportHistoryPage>;
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
      SELECT t.id AS teacher_id, t.user_id, u.name, t.username, t.subjects
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
        building = CASE WHEN ${input.building ?? null} IS NOT NULL THEN ${input.building ?? null} ELSE rooms.building END,
        capacity = CASE WHEN ${input.capacity ?? null} IS NOT NULL THEN ${input.capacity ?? null} ELSE rooms.capacity END
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

  async findOrCreateTimeSlot(db, input) {
    const sortOrderParts = input.startTime.split(':').map(Number);
    const sortOrder = (sortOrderParts[0] ?? 0) * 60 + (sortOrderParts[1] ?? 0);

    const result = await db.execute(sql`
      WITH existing AS (
        SELECT id, label, start_time::text AS start_time, end_time::text AS end_time
        FROM time_slots
        WHERE start_time = ${input.startTime}::time
          AND end_time = ${input.endTime}::time
        LIMIT 1
      ),
      inserted AS (
        INSERT INTO time_slots (label, start_time, end_time, sort_order)
        SELECT ${input.label}, ${input.startTime}::time, ${input.endTime}::time, ${sortOrder}
        WHERE NOT EXISTS (SELECT 1 FROM existing)
        ON CONFLICT (label) DO NOTHING
        RETURNING id, label, start_time::text AS start_time, end_time::text AS end_time
      )
      SELECT id, label, start_time, end_time FROM existing
      UNION ALL
      SELECT id, label, start_time, end_time FROM inserted
      UNION ALL
      SELECT id, label, start_time::text AS start_time, end_time::text AS end_time
      FROM time_slots
      WHERE start_time = ${input.startTime}::time
        AND end_time = ${input.endTime}::time
      LIMIT 1
    `);

    const row = getRows<TimeSlotRow>(result)[0];
    if (!row) {
      throw new Error('Unable to find or create time slot');
    }

    return row;
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
        s.parent_email,
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
      parent_email: string | null;
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
      parentEmail: row.parent_email,
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
          parent_email = ${row.parentEmail ?? null},
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
        parent_email,
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
        ${row.parentEmail ?? null},
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

    // les enseignants sont aussi des utilisateurs dans notre système, il faut donc créer une entrée dans la table users avant de pouvoir créer l'enseignant lui-même 
    // dans la table teachers (qui référence la table users via user_id).
    // si plusieurs lignes du fichier d'import font référence au même enseignant (même username), cela ne posera pas de problème car la requête d'insertion dans users est protégée 
    // par une contrainte d'unicité sur le champ username, et nous faisons un upsert basé sur ce champ.
    // Sécurité : les profs importés partagent le même mot de passe par défaut
    // (IMPORT_TEACHER_DEFAULT_PASSWORD). On force must_change_password = true pour
    // qu'aucun compte ne reste accessible avec ce mot de passe partagé après la
    // première connexion (cf. même pattern parents subscriptions.repository.ts +
    // régénération credentials teachers.repository.ts).
    const userResult = await db.execute(sql`
      INSERT INTO users (
        role,
        name,
        phone,
        email,
        password_hash,
        is_active,
        must_change_password
      )
      VALUES (
        'teacher',
        ${params.displayName},
        null,
        null,
        ${params.passwordHash},
        true,
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
      RETURNING id, user_id
    `);

    const teacher = getRows<TeacherInsertRow>(teacherResult)[0];
    if (!teacher) {
      throw new Error('Unable to insert teacher');
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
        AND is_active = true
        AND end_date IS NULL
      LIMIT 1
    `);

    const existing = getRows<ScheduleInsertRow>(existingResult)[0];

    if (existing) {
      await db.execute(sql`
        UPDATE schedules
        SET
          class_id = ${params.classId},
          room_id = ${params.roomId},
          subject = ${row.subject},
          is_active = true,
          start_date = ${params.startDate}::date,
          end_date = NULL
        WHERE id = ${existing.id}
      `);
      return { result: 'updated', id: existing.id };
    }

    const insertResult = await db.execute(sql`
      INSERT INTO schedules (
        schedule_period_id,
        teacher_id,
        class_id,
        room_id,
        time_slot_id,
        day_of_week,
        subject,
        start_date,
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
        ${params.startDate}::date,
        true
      )
      RETURNING id
    `);

    const insertedId = getRows<ScheduleInsertRow>(insertResult)[0]?.id;
    if (!insertedId) {
      throw new Error('Unable to insert schedule');
    }

    return { result: 'inserted', id: insertedId };
  },

  async deactivateSchedulesByPeriodExcluding(db, schedulePeriodId, keepIds) {
    if (keepIds.length === 0) {
      const result = await db.execute(sql`
        WITH updated AS (
          UPDATE schedules
          SET is_active = false, end_date = CURRENT_DATE
          WHERE schedule_period_id = ${schedulePeriodId}
            AND is_active = true
          RETURNING id
        )
        SELECT COUNT(*)::int AS count FROM updated
      `);
      const row = getRows<{ count: string | number }>(result)[0];
      return Number.isFinite(Number(row?.count)) ? Number(row?.count) : 0;
    }

    const result = await db.execute(sql`
      WITH updated AS (
        UPDATE schedules
        SET is_active = false, end_date = CURRENT_DATE
        WHERE schedule_period_id = ${schedulePeriodId}
          AND is_active = true
          AND id NOT IN (${sql.join(keepIds.map((id) => sql`${id}`), sql`, `)})
        RETURNING id
      )
      SELECT COUNT(*)::int AS count FROM updated
    `);

    const row = getRows<{ count: string | number }>(result)[0];
    const value = row ? Number(row.count) : 0;
    return Number.isFinite(value) ? value : 0;
  },

  async createImportHistory(db, entry) {
    await db.execute(sql`
      INSERT INTO import_history (import_type, imported_count, updated_count, schedule_period, imported_by, imported_by_role)
      VALUES (
        ${entry.importType},
        ${entry.importedCount},
        ${entry.updatedCount},
        ${entry.schedulePeriod ?? null},
        ${entry.importedBy ?? null}::uuid,
        ${entry.importedByRole ?? null}
      )
    `);
  },

  // listImportHistory est un peu plus complexe que les autres méthodes du repository car elle doit construire dynamiquement 
  // la clause WHERE en fonction des filtres fournis (mois et type d'import), 
  // et elle doit aussi faire le lien avec la table des utilisateurs pour récupérer le nom et le rôle de l'importateur.
  async listImportHistory(db, filter) {
    const { limit, page, month, type } = filter;
    const offset = (page - 1) * limit;

    const conditions: ReturnType<typeof sql>[] = [];
    if (month) {
      conditions.push(sql`to_char(imported_at, 'YYYY-MM') = ${month}`);
    }
    if (type) {
      conditions.push(sql`import_type = ${type}`);
    }

    const where = conditions.length > 0
      ? sql`WHERE ${sql.join(conditions, sql` AND `)}`
      : sql``;

    const [itemsResult, countResult] = await Promise.all([
      db.execute(sql`
        SELECT
          ih.id,
          ih.imported_at::text AS imported_at,
          ih.import_type,
          ih.imported_count,
          ih.updated_count,
          ih.schedule_period,
          ih.imported_by::text,
          u.name AS imported_by_name,
          COALESCE(ih.imported_by_role, ap.name, u.role::text) AS imported_by_role
        FROM import_history ih
        LEFT JOIN users u ON u.id = ih.imported_by
        LEFT JOIN LATERAL (
          SELECT p.name
          FROM position_assignments pa
          INNER JOIN admin_positions p ON p.id = pa.position_id
          WHERE pa.user_id = ih.imported_by
          ORDER BY pa.created_at DESC
          LIMIT 1
        ) ap ON true
        ${where}
        ORDER BY ih.imported_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `),
      db.execute(sql`
        SELECT COUNT(*)::int AS total
        FROM import_history
        ${where}
      `),
    ]);

    const items = getRows<ImportHistoryRow>(itemsResult);
    const totalRow = getRows<{ total: number }>(countResult)[0];
    const total = totalRow ? Number(totalRow.total) : 0;

    return { items, total };
  },
};
