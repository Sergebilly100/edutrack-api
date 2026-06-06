import { sql, type SQL } from 'drizzle-orm';

import type {
  AbsenceStatsQuery,
  AttendanceHistoryQuery,
  AttendanceStudentRecord,
  BulkAttendanceInput,
  CreateStudentInput,
  ExcusedAbsenceRecord,
  StudentAbsenceDetailRecord,
  StudentAbsenceStatRecord,
  StudentDetailRecord,
  StudentDocumentRecord,
  StudentParentSmsRecord,
  StudentRecentAbsence,
  StudentAbsencesQuery,
  StudentRecord,
  StudentsListQuery,
  TodayAbsenceRow,
  UpdateStudentInput,
} from './students.types.js';

export type QueryExecutor = {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
};

// ─── Raw DB row types ─────────────────────────────────────────────────────────

type StudentRow = {
  id: string;
  class_id: string;
  class_name: string;
  first_name: string;
  last_name: string;
  matricule: string | null;
  birth_date: string | null;
  parent_name: string | null;
  parent_phone: string | null;
  parent_email: string | null;
  parent_name_2: string | null;
  parent_phone_2: string | null;
  notes: string | null;
  is_active: boolean;
  created_at: Date;
};

type TotalRow = { total: string | number };

type ExistingStudentRow = {
  id: string;
  class_id: string;
  first_name: string;
  last_name: string;
  matricule: string | null;
  birth_date: string | null;
  parent_name: string | null;
  parent_phone: string | null;
  parent_email: string | null;
  parent_name_2: string | null;
  parent_phone_2: string | null;
  notes: string | null;
  is_active: boolean;
};

type ScheduleRow = {
  id: string;
  class_id: string;
  subject: string;
};

type StudentAbsenceSourceRow = {
  id: string;
  first_name: string;
  parent_phone: string | null;
  parent_email: string | null;
};

type AttendanceRow = {
  id: string;
  date: string;
  schedule_id: string | null;
  student_id: string;
  student_first_name: string;
  student_last_name: string;
  class_id: string;
  class_name: string;
  status: 'present' | 'absent' | 'excused';
  marked_by: string | null;
  sms_status: 'queued' | 'sent' | 'failed' | 'delivered' | null;
  created_at: Date;
};

type TodayAbsenceDbRow = {
  class_id: string;
  class_name: string;
  student_id: string;
  student_first_name: string;
  student_last_name: string;
  schedule_id: string | null;
  date: string;
  created_at: Date;
  sms_status: 'queued' | 'sent' | 'failed' | 'delivered' | null;
  status: 'absent' | 'excused';
};

type TenantIdentityRow = {
  id: string;
};

type StudentAbsenceSummaryRow = {
  total_absences: string | number;
  excused_count: string | number;
  month_absences: string | number;
  week_absences: string | number;
};

type StudentRecentAbsenceRow = {
  id: string;
  date: string;
  subject: string | null;
  teacher_name: string | null;
  start_time: string | null;
  end_time: string | null;
  room_name: string | null;
  sms_status: 'queued' | 'sent' | 'failed' | 'delivered' | null;
  status: 'absent' | 'excused';
  excuse_reason: string | null;
};

type StudentDocumentRow = {
  id: string;
  file_name: string;
  uploaded_at: Date;
};

type StudentParentSmsRow = {
  id: string;
  date: Date | string;
  reason: string;
  recipient_phone: string;
  status: 'queued' | 'sent' | 'failed' | 'delivered';
};

type StudentAbsenceStatsDbRow = {
  student_id: string;
  student_name: string;
  class_name: string;
  class_id: string;
  parent_phone: string | null;
  parent_phone_2: string | null;
  absence_count: string | number;
  excused_count: string | number;
  total_scheduled: string | number;
  absence_rate: string | number | null;
  sms_summary: 'all_sent' | 'partial' | 'none';
};

type StudentAbsenceDetailDbRow = {
  id: string;
  date: string;
  subject: string;
  class_name: string;
  start_time: string;
  end_time: string;
  status: 'absent' | 'excused';
  excuse_reason: string | null;
  phone_1: string | null;
  phone_2: string | null;
  sms1_status: 'queued' | 'sent' | 'failed' | 'delivered' | null;
  sms1_sent_at: string | null;
  sms2_status: 'queued' | 'sent' | 'failed' | 'delivered' | null;
  sms2_sent_at: string | null;
};

type ExcuseAbsenceDbRow = {
  id: string;
  student_id: string;
  date: string;
  schedule_id: string | null;
  status: 'excused';
  excuse_reason: string;
  excused_at: string;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const getRows = <T>(result: unknown): T[] => {
  if (typeof result !== 'object' || result === null || !('rows' in result)) {
    return [];
  }

  const rows = (result as { rows?: T[] }).rows;
  return Array.isArray(rows) ? rows : [];
};

const toIsoDateTime = (value: Date | string): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`[students.repository] Invalid date value: ${String(value)}`);
  }

  return parsed.toISOString();
};

const mapStudent = (row: StudentRow): StudentRecord => ({
  id: row.id,
  classId: row.class_id,
  className: row.class_name,
  firstName: row.first_name,
  lastName: row.last_name,
  matricule: row.matricule,
  birthDate: row.birth_date,
  parentName: row.parent_name,
  parentPhone: row.parent_phone,
  parentEmail: row.parent_email,
  parentName2: row.parent_name_2,
  parentPhone2: row.parent_phone_2,
  note: row.notes,
  isActive: row.is_active,
  createdAt: toIsoDateTime(row.created_at),
});

const mapAttendance = (row: AttendanceRow): AttendanceStudentRecord => ({
  id: row.id,
  date: row.date,
  scheduleId: row.schedule_id,
  studentId: row.student_id,
  studentFirstName: row.student_first_name,
  studentLastName: row.student_last_name,
  classId: row.class_id,
  className: row.class_name,
  status: row.status,
  markedBy: row.marked_by,
  smsStatus: row.sms_status,
  smsNotified: row.sms_status === 'sent' || row.sms_status === 'delivered',
  createdAt: toIsoDateTime(row.created_at),
});

const toTotal = (row: TotalRow | undefined): number => {
  if (!row) return 0;
  const value = typeof row.total === 'string' ? Number(row.total) : row.total;
  return Number.isFinite(value) ? value : 0;
};

const toNumber = (value: string | number | null | undefined): number => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const toSmsStatus = (
  value: 'queued' | 'sent' | 'failed' | 'delivered' | null
): 'sent' | 'failed' | 'not_sent' => {
  if (value === 'sent' || value === 'delivered') return 'sent';
  if (value === 'failed') return 'failed';
  return 'not_sent';
};

const toRecentSmsStatus = (
  value: 'queued' | 'sent' | 'failed' | 'delivered' | null
): StudentRecentAbsence['smsStatus'] => {
  if (value === 'sent' || value === 'delivered') return 'sent';
  if (value === 'failed') return 'failed';
  return 'not_sent';
};

const buildStudentsWhere = (query: StudentsListQuery): SQL[] => {
  const where: SQL[] = [];
  if (query.class_id) where.push(sql`s.class_id = ${query.class_id}`);
  if (typeof query.is_active === 'boolean') where.push(sql`s.is_active = ${query.is_active}`);
  if (query.search) {
    where.push(
      sql`(s.first_name ILIKE ${`%${query.search}%`} OR s.last_name ILIKE ${`%${query.search}%`} OR s.matricule ILIKE ${`%${query.search}%`})`
    );
  }
  return where;
};

const buildAttendanceWhere = (query: AttendanceHistoryQuery): SQL[] => {
  const where: SQL[] = [sql`a.status IN ('absent', 'excused')`];
  if (query.class_id) where.push(sql`c.id = ${query.class_id}`);
  if (query.student_id) where.push(sql`s.id = ${query.student_id}`);
  if (query.schedule_id) where.push(sql`a.schedule_id = ${query.schedule_id}`);
  if (query.date_from) where.push(sql`a.date >= ${query.date_from}`);
  if (query.date_to) where.push(sql`a.date <= ${query.date_to}`);
  return where;
};

const makeWhereClause = (conditions: SQL[]): SQL => {
  if (conditions.length === 0) return sql``;
  return sql`WHERE ${sql.join(conditions, sql` AND `)}`;
};

const deduplicateIds = (ids: string[]): string[] => Array.from(new Set(ids));

// ─── Repository ───────────────────────────────────────────────────────────────

export class StudentsRepository {
  constructor(
    private readonly db: QueryExecutor,
    private readonly globalDb: QueryExecutor
  ) {}

  async getTenantIdBySchemaName(schemaName: string): Promise<string | null> {
    const result = await this.globalDb.execute(sql`
      SELECT id
      FROM public.tenants
      WHERE schema_name = ${schemaName}
      LIMIT 1
    `);

    return getRows<TenantIdentityRow>(result)[0]?.id ?? null;
  }

  async listStudents(query: StudentsListQuery): Promise<{ rows: StudentRecord[]; total: number }> {
    const offset = (query.page - 1) * query.limit;
    const where = makeWhereClause(buildStudentsWhere(query));

    const [items, total] = await Promise.all([
      this.db.execute(sql`
        SELECT
          s.id,
          s.class_id,
          c.name AS class_name,
          s.first_name,
          s.last_name,
          s.matricule,
          s.birth_date::text AS birth_date,
          s.parent_name,
          s.parent_phone,
          s.parent_email,
          s.parent_name_2,
          s.parent_phone_2,
          s.notes,
          s.is_active,
          s.created_at
        FROM students s
        INNER JOIN classes c ON c.id = s.class_id
        ${where}
        ORDER BY s.created_at DESC
        LIMIT ${query.limit}
        OFFSET ${offset}
      `),
      this.db.execute(sql`
        SELECT COUNT(*) AS total
        FROM students s
        INNER JOIN classes c ON c.id = s.class_id
        ${where}
      `),
    ]);

    return {
      rows: getRows<StudentRow>(items).map(mapStudent),
      total: toTotal(getRows<TotalRow>(total)[0]),
    };
  }

  async teacherHasClassAccess(input: {
    teacherUserId: string;
    classId: string;
    date: string;
  }): Promise<boolean> {
    const result = await this.db.execute(sql`
      SELECT EXISTS (
        SELECT 1
        FROM teachers t
        INNER JOIN schedules s ON s.teacher_id = t.id
        INNER JOIN schedule_periods sp ON sp.id = s.schedule_period_id
        WHERE t.user_id = ${input.teacherUserId}
          AND s.class_id = ${input.classId}
          AND s.is_active = true
          AND (s.end_date IS NULL OR s.end_date >= ${input.date}::date)
          AND sp.is_active = true
          AND sp.valid_from <= ${input.date}::date
          AND sp.valid_to >= ${input.date}::date
        LIMIT 1
      ) AS has_access
    `);

    const [row] = getRows<{ has_access: boolean }>(result);
    return row?.has_access ?? false;
  }

  async createStudent(input: CreateStudentInput): Promise<StudentRecord> {
    const result = await this.db.execute(sql`
      INSERT INTO students (
        class_id, first_name, last_name, matricule, birth_date,
        parent_name, parent_phone, parent_email,
        parent_name_2, parent_phone_2,
        notes, is_active
      )
      VALUES (
        ${input.class_id}, ${input.first_name}, ${input.last_name},
        ${input.matricule ?? null}, ${input.birth_date ?? null},
        ${input.parent_name}, ${input.parent_phone}, ${input.parent_email ?? null},
        ${input.parent_name_2}, ${input.parent_phone_2},
        ${input.notes}, ${input.is_active}
      )
      RETURNING
        id, class_id,
        (SELECT name FROM classes WHERE id = class_id) AS class_name,
        first_name, last_name, matricule, birth_date::text AS birth_date,
        parent_name, parent_phone, parent_email,
        parent_name_2, parent_phone_2,
        notes, is_active, created_at
    `);

    const created = getRows<StudentRow>(result)[0];
    if (!created) throw new Error('Unable to create student');
    if (!created.class_name) throw new Error('Class not found');

    if (created.is_active) {
      await this.adjustClassStudentCount(created.class_id, 1);
    }

    return mapStudent(created);
  }

  async findStudentById(studentId: string): Promise<StudentRecord | null> {
    const result = await this.db.execute(sql`
      SELECT
        s.id, s.class_id, c.name AS class_name,
        s.first_name, s.last_name, s.matricule, s.birth_date::text AS birth_date,
        s.parent_name, s.parent_phone, s.parent_email,
        s.parent_name_2, s.parent_phone_2,
        s.notes, s.is_active, s.created_at
      FROM students s
      INNER JOIN classes c ON c.id = s.class_id
      WHERE s.id = ${studentId}
      LIMIT 1
    `);

    const row = getRows<StudentRow>(result)[0];
    return row ? mapStudent(row) : null;
  }

  async updateStudent(
    studentId: string,
    input: UpdateStudentInput
  ): Promise<StudentRecord | null> {
    const currentResult = await this.db.execute(sql`
      SELECT id, class_id, first_name, last_name, matricule, birth_date::text AS birth_date,
             parent_name, parent_phone, parent_email,
             parent_name_2, parent_phone_2,
             notes, is_active
      FROM students
      WHERE id = ${studentId}
      LIMIT 1
    `);

    const current = getRows<ExistingStudentRow>(currentResult)[0];
    if (!current) return null;

    const nextClassId = input.class_id ?? current.class_id;
    const nextIsActive = input.is_active ?? current.is_active;
    // undefined = conserver ; null/valeur = écraser.
    const nextMatricule = input.matricule === undefined ? current.matricule : input.matricule;
    const matriculeSql = nextMatricule === null ? sql`NULL` : sql`${nextMatricule}`;
    const nextBirthDate = input.birth_date === undefined ? current.birth_date : input.birth_date;
    const birthDateSql = nextBirthDate === null ? sql`NULL` : sql`${nextBirthDate}::date`;
    const nextParentName =
      input.parent_name !== undefined ? input.parent_name : current.parent_name;
    const nextParentPhone =
      input.parent_phone !== undefined ? input.parent_phone : current.parent_phone;
    const nextParentEmail =
      input.parent_email !== undefined ? input.parent_email : current.parent_email;
    const nextParentName2 =
      input.parent_name_2 !== undefined ? input.parent_name_2 : current.parent_name_2;
    const nextParentPhone2 =
      input.parent_phone_2 !== undefined ? input.parent_phone_2 : current.parent_phone_2;
    const nextNotes = input.notes !== undefined ? input.notes : current.notes;

    const updateResult = await this.db.execute(sql`
      UPDATE students
      SET
        class_id = ${nextClassId},
        first_name = ${input.first_name ?? current.first_name},
        last_name = ${input.last_name ?? current.last_name},
        matricule = ${matriculeSql},
        birth_date = ${birthDateSql},
        parent_name = ${nextParentName},
        parent_phone = ${nextParentPhone},
        parent_email = ${nextParentEmail},
        parent_name_2 = ${nextParentName2},
        parent_phone_2 = ${nextParentPhone2},
        notes = ${nextNotes},
        is_active = ${nextIsActive}
      WHERE id = ${studentId}
      RETURNING id
    `);

    if (!getRows<{ id: string }>(updateResult)[0]) return null;

    if (current.class_id !== nextClassId) {
      if (current.is_active) await this.adjustClassStudentCount(current.class_id, -1);
      if (nextIsActive) await this.adjustClassStudentCount(nextClassId, 1);
    } else if (current.is_active !== nextIsActive) {
      await this.adjustClassStudentCount(nextClassId, nextIsActive ? 1 : -1);
    }

    return this.findStudentById(studentId);
  }

  async softDeleteStudent(studentId: string): Promise<StudentRecord | null> {
    const result = await this.db.execute(sql`
      UPDATE students s
      SET is_active = false
      FROM classes c
      WHERE s.id = ${studentId}
        AND s.is_active = true
        AND c.id = s.class_id
      RETURNING
        s.id, s.class_id, c.name AS class_name,
        s.first_name, s.last_name, s.matricule, s.birth_date::text AS birth_date,
        s.parent_name, s.parent_phone, s.parent_email,
        s.parent_name_2, s.parent_phone_2,
        s.notes, s.is_active, s.created_at
    `);

    const row = getRows<StudentRow>(result)[0];
    if (!row) return null;

    await this.adjustClassStudentCount(row.class_id, -1);
    return mapStudent(row);
  }

  async findStudentDetailById(studentId: string): Promise<StudentDetailRecord | null> {
    const student = await this.findStudentById(studentId);
    if (!student) return null;

    const [summaryResult, recentAbsencesResult, documentsResult, parentSmsResult] =
      await Promise.all([
        this.db.execute(sql`
          SELECT
            COUNT(*) FILTER (WHERE a.status = 'absent') AS total_absences,
            COUNT(*) FILTER (WHERE a.status = 'excused') AS excused_count,
            COUNT(*) FILTER (
              WHERE a.status IN ('absent', 'excused')
                AND a.date >= date_trunc('month', CURRENT_DATE)::date
                AND a.date <= CURRENT_DATE
            ) AS month_absences,
            COUNT(*) FILTER (
              WHERE a.status IN ('absent', 'excused')
                AND a.date >= date_trunc('week', CURRENT_DATE)::date
                AND a.date <= CURRENT_DATE
            ) AS week_absences
          FROM attendances_student a
          WHERE a.student_id = ${studentId}
        `),
        this.db.execute(sql`
          SELECT
            a.id,
            a.date::text AS date,
            sch.subject,
            u.name AS teacher_name,
            ts.start_time::text AS start_time,
            ts.end_time::text AS end_time,
            r.name AS room_name,
            a.status::text AS status,
            a.excuse_reason,
            sms_log.status::text AS sms_status
          FROM attendances_student a
          INNER JOIN students s ON s.id = a.student_id
          LEFT JOIN schedules sch ON sch.id = a.schedule_id
          LEFT JOIN time_slots ts ON ts.id = sch.time_slot_id
          LEFT JOIN rooms r ON r.id = sch.room_id
          LEFT JOIN teachers t ON t.id = sch.teacher_id
          LEFT JOIN users u ON u.id = t.user_id
          LEFT JOIN LATERAL (
            SELECT n.status
            FROM notifications_log n
            WHERE n.type = 'student_absent_parent'
              AND n.recipient_phone IN (s.parent_phone, s.parent_phone_2)
              AND COALESCE(n.sent_at::date, n.created_at::date) = a.date::date
              AND (a.schedule_id IS NULL OR n.related_id = a.schedule_id)
            ORDER BY n.created_at DESC
            LIMIT 1
          ) sms_log ON true
          WHERE a.student_id = ${studentId}
            AND a.status IN ('absent', 'excused')
          ORDER BY a.date DESC, a.created_at DESC
          LIMIT 20
        `),
        this.db.execute(sql`
          SELECT
            d.id,
            d.name AS file_name,
            d.created_at AS uploaded_at
          FROM documents d
          WHERE d.entity_type = 'student'
            AND d.entity_id = ${studentId}
          ORDER BY d.created_at DESC
        `),
        // FIX B3: use sub-select, not INNER JOIN acting as cross join
        this.db.execute(sql`
          SELECT
            n.id,
            COALESCE(n.sent_at, n.created_at) AS date,
            n.message AS reason,
            n.recipient_phone,
            n.status::text AS status
          FROM notifications_log n
          WHERE n.type = 'student_absent_parent'
            AND n.recipient_phone IN (
              SELECT parent_phone FROM students WHERE id = ${studentId}
              UNION
              SELECT parent_phone_2 FROM students WHERE id = ${studentId}
            )
          ORDER BY COALESCE(n.sent_at, n.created_at) DESC, n.created_at DESC
          LIMIT 50
        `),
      ]);

    const summaryRow = getRows<StudentAbsenceSummaryRow>(summaryResult)[0];
    const recentAbsences = getRows<StudentRecentAbsenceRow>(recentAbsencesResult).map(
      (row): StudentRecentAbsence => ({
        id: row.id,
        date: row.date,
        subject: row.subject ?? 'Matière non renseignée',
        teacherName: row.teacher_name ?? 'Professeur non renseigné',
        startTime: row.start_time,
        endTime: row.end_time,
        roomName: row.room_name,
        smsStatus: toRecentSmsStatus(row.sms_status),
        status: row.status,
        excuseReason: row.excuse_reason,
      })
    );
    const documents = getRows<StudentDocumentRow>(documentsResult).map(
      (row): StudentDocumentRecord => ({
        id: row.id,
        fileName: row.file_name,
        fileUrl: `/api/v1/documents/${row.id}/download`,
        uploadedAt: toIsoDateTime(row.uploaded_at),
      })
    );
    const parentSms = getRows<StudentParentSmsRow>(parentSmsResult).map(
      (row): StudentParentSmsRecord => ({
        id: row.id,
        date: toIsoDateTime(row.date),
        reason: row.reason,
        recipientPhone: row.recipient_phone,
        status: row.status,
      })
    );

    return {
      id: student.id,
      firstName: student.firstName,
      lastName: student.lastName,
      matricule: student.matricule,
      birthDate: student.birthDate,
      className: student.className,
      classId: student.classId,
      isActive: student.isActive,
      parentPhone: student.parentPhone,
      parentEmail: student.parentEmail ?? null,
      parentPhone2: student.parentPhone2,
      parentName: student.parentName ?? null,
      parentName2: student.parentName2 ?? null,
      note: student.note ?? null,
      createdAt: student.createdAt,
      absenceSummary: {
        total: summaryRow ? toTotal({ total: summaryRow.total_absences }) : 0,
        excused: summaryRow ? toTotal({ total: summaryRow.excused_count }) : 0,
        thisMonth: summaryRow ? toTotal({ total: summaryRow.month_absences }) : 0,
        thisWeek: summaryRow ? toTotal({ total: summaryRow.week_absences }) : 0,
      },
      recentAbsences,
      documents,
      parentSms,
    };
  }

  async findScheduleById(
    scheduleId: string
  ): Promise<{ id: string; classId: string; subject: string } | null> {
    const result = await this.db.execute(sql`
      SELECT id, class_id, subject
      FROM schedules
      WHERE id = ${scheduleId}
      LIMIT 1
    `);

    const row = getRows<ScheduleRow>(result)[0];
    if (!row) return null;
    return { id: row.id, classId: row.class_id, subject: row.subject };
  }

  async findStudentsForAbsence(
    classId: string,
    studentIds: string[]
  ): Promise<
    Array<{ id: string; firstName: string; parentPhone: string | null; parentEmail: string | null }>
  > {
    const ids = deduplicateIds(studentIds);
    if (ids.length === 0) return [];

    const placeholders = sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `
    );

    const result = await this.db.execute(sql`
      SELECT
        st.id,
        st.first_name,
        st.parent_phone,
        parent_contact.email AS parent_email
      FROM students st
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
      WHERE st.class_id = ${classId}
        AND st.is_active = true
        AND st.id IN (${placeholders})
    `);

    return getRows<StudentAbsenceSourceRow>(result).map((row) => ({
      id: row.id,
      firstName: row.first_name,
      parentPhone: row.parent_phone,
      parentEmail: row.parent_email,
    }));
  }

  async upsertStudentAbsences(input: {
    scheduleId: BulkAttendanceInput['scheduleId'];
    date: BulkAttendanceInput['date'];
    studentIds: string[];
    markedBy: string;
  }): Promise<number> {
    const ids = deduplicateIds(input.studentIds);
    if (ids.length === 0) return 0;

    const values = sql.join(
      ids.map(
        (id) => sql`(${id}, ${input.scheduleId}, ${input.date}, 'absent', ${input.markedBy})`
      ),
      sql`, `
    );

    // FIX B4: preserve 'excused' status - never downgrade it back to 'absent'
    const result = await this.db.execute(sql`
      INSERT INTO attendances_student (student_id, schedule_id, date, status, marked_by)
      VALUES ${values}
      ON CONFLICT (student_id, schedule_id, date)
      DO UPDATE SET
        status = CASE
          WHEN attendances_student.status = 'excused' THEN 'excused'
          ELSE EXCLUDED.status
        END,
        marked_by = EXCLUDED.marked_by
      RETURNING id
    `);

    return getRows<{ id: string }>(result).length;
  }

  async findAbsenceById(attendanceId: string): Promise<{
    id: string;
    studentId: string;
    date: string;
    scheduleId: string | null;
    status: 'present' | 'absent' | 'excused';
  } | null> {
    const result = await this.db.execute(sql`
      SELECT id, student_id, date::text AS date, schedule_id, status::text AS status
      FROM attendances_student
      WHERE id = ${attendanceId}
      LIMIT 1
    `);

    const row = getRows<{
      id: string;
      student_id: string;
      date: string;
      schedule_id: string | null;
      status: 'present' | 'absent' | 'excused';
    }>(result)[0];

    if (!row) return null;
    return {
      id: row.id,
      studentId: row.student_id,
      date: row.date,
      scheduleId: row.schedule_id,
      status: row.status,
    };
  }

  async excuseAbsence(
    attendanceId: string,
    reason: string,
    excusedBy: string
  ): Promise<ExcusedAbsenceRecord | null> {
    const result = await this.db.execute(sql`
      UPDATE attendances_student
      SET
        status = 'excused',
        excuse_reason = ${reason},
        excused_by = ${excusedBy},
        excused_at = NOW()
      WHERE id = ${attendanceId}
        AND status = 'absent'
      RETURNING
        id,
        student_id,
        date::text AS date,
        schedule_id,
        status::text AS status,
        excuse_reason,
        excused_at::text AS excused_at
    `);

    const row = getRows<ExcuseAbsenceDbRow>(result)[0];
    if (!row) return null;

    return {
      id: row.id,
      studentId: row.student_id,
      date: row.date,
      scheduleId: row.schedule_id,
      status: 'excused',
      excuseReason: row.excuse_reason,
      excusedAt: row.excused_at,
    };
  }

  async getSchoolPhone(): Promise<string | null> {
    const result = await this.db.execute(sql`
      SELECT phone
      FROM users
      WHERE role = 'director'
        AND phone IS NOT NULL
      ORDER BY created_at ASC
      LIMIT 1
    `);

    return getRows<{ phone: string | null }>(result)[0]?.phone ?? null;
  }

  async listAttendanceHistory(
    query: AttendanceHistoryQuery
  ): Promise<{ rows: AttendanceStudentRecord[]; total: number }> {
    const offset = (query.page - 1) * query.limit;
    const where = makeWhereClause(buildAttendanceWhere(query));

    const [items, total] = await Promise.all([
      this.db.execute(sql`
        SELECT
          a.id,
          a.date,
          a.schedule_id,
          a.student_id,
          s.first_name AS student_first_name,
          s.last_name AS student_last_name,
          c.id AS class_id,
          c.name AS class_name,
          a.status,
          a.marked_by,
          sms_log.status::text AS sms_status,
          a.created_at
        FROM attendances_student a
        INNER JOIN students s ON s.id = a.student_id
        INNER JOIN classes c ON c.id = s.class_id
        LEFT JOIN LATERAL (
          SELECT n.status
          FROM notifications_log n
          WHERE n.type = 'student_absent_parent'
            AND n.related_id = a.schedule_id
            AND n.recipient_phone = s.parent_phone
            AND COALESCE(n.sent_at::date, n.created_at::date) = a.date::date
          ORDER BY n.created_at DESC
          LIMIT 1
        ) sms_log ON true
        ${where}
        ORDER BY a.date DESC, a.created_at DESC
        LIMIT ${query.limit}
        OFFSET ${offset}
      `),
      this.db.execute(sql`
        SELECT COUNT(*) AS total
        FROM attendances_student a
        INNER JOIN students s ON s.id = a.student_id
        INNER JOIN classes c ON c.id = s.class_id
        ${where}
      `),
    ]);

    return {
      rows: getRows<AttendanceRow>(items).map(mapAttendance),
      total: toTotal(getRows<TotalRow>(total)[0]),
    };
  }

  async listTodayAbsences(date?: string): Promise<TodayAbsenceRow[]> {
    const result = await this.db.execute(sql`
      SELECT
        c.id AS class_id,
        c.name AS class_name,
        s.id AS student_id,
        s.first_name AS student_first_name,
        s.last_name AS student_last_name,
        a.schedule_id,
        a.date::text AS date,
        a.created_at,
        a.status::text AS status,
        sms_log.status::text AS sms_status
      FROM attendances_student a
      INNER JOIN students s ON s.id = a.student_id
      INNER JOIN classes c ON c.id = s.class_id
      LEFT JOIN LATERAL (
        SELECT n.status
        FROM notifications_log n
        WHERE n.type = 'student_absent_parent'
          AND n.related_id = a.schedule_id
          AND n.recipient_phone = s.parent_phone
          AND COALESCE(n.sent_at::date, n.created_at::date) = a.date::date
        ORDER BY n.created_at DESC
        LIMIT 1
      ) sms_log ON true
      WHERE a.status IN ('absent', 'excused')
        AND a.date = COALESCE(${date ?? null}::date, CURRENT_DATE)
      ORDER BY a.created_at DESC, s.last_name ASC, s.first_name ASC
    `);

    return getRows<TodayAbsenceDbRow>(result).map((row) => ({
      classId: row.class_id,
      className: row.class_name,
      studentId: row.student_id,
      studentFirstName: row.student_first_name,
      studentLastName: row.student_last_name,
      scheduleId: row.schedule_id,
      date: row.date,
      createdAt: toIsoDateTime(row.created_at),
      smsStatus: row.sms_status,
      smsNotified: row.sms_status === 'sent' || row.sms_status === 'delivered',
      status: row.status,
    }));
  }

  async getStudentAbsenceStats(query: AbsenceStatsQuery): Promise<StudentAbsenceStatRecord[]> {
    const filters: SQL[] = [
      sql`st.is_active = true`,
      sql`(sa.absence_count + sa.excused_count) >= ${query.min_absences}`,
    ];

    if (query.class_id) {
      filters.push(sql`st.class_id = ${query.class_id}::uuid`);
    }

    if (query.sms_status === 'sent') {
      filters.push(sql`sa.sms_sent_count = sa.absence_count`);
    } else if (query.sms_status === 'not_sent') {
      filters.push(sql`sa.sms_sent_count = 0`);
    } else if (query.sms_status === 'failed') {
      filters.push(sql`sa.has_failed = true`);
    }

    const subjectScheduledFilter = query.subject
      ? sql`AND s.subject = ${query.subject}`
      : sql``;
    const subjectAbsenceFilter = query.subject ? sql`AND s.subject = ${query.subject}` : sql``;

    const result = await this.db.execute(sql`
      WITH active_period AS (
        SELECT id
        FROM schedule_periods
        WHERE is_active = true
          AND valid_from <= ${query.to}::date
          AND valid_to >= ${query.from}::date
        ORDER BY created_at DESC
        LIMIT 1
      ),
      dates AS (
        SELECT generate_series(${query.from}::date, ${query.to}::date, INTERVAL '1 day')::date AS date
      ),
      class_scheduled AS (
        SELECT s.class_id, COUNT(*)::int AS total
        FROM dates d
        INNER JOIN active_period ap ON true
        INNER JOIN schedules s
          ON s.schedule_period_id = ap.id
         AND s.day_of_week = EXTRACT(ISODOW FROM d.date)::int
         AND s.is_active = true
         AND (s.end_date IS NULL OR s.end_date >= d.date)
        ${subjectScheduledFilter}
        GROUP BY s.class_id
      ),
      absence_rows AS (
        SELECT
          ast.student_id,
          ast.status,
          CASE WHEN COALESCE(nl.sent_count, 0) > 0 THEN 1 ELSE 0 END AS has_sent,
          CASE WHEN COALESCE(nl.failed_count, 0) > 0 THEN 1 ELSE 0 END AS has_failed
        FROM attendances_student ast
        INNER JOIN schedules s ON s.id = ast.schedule_id
        INNER JOIN students st ON st.id = ast.student_id
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) FILTER (WHERE n.status IN ('sent', 'delivered'))::int AS sent_count,
            COUNT(*) FILTER (WHERE n.status = 'failed')::int AS failed_count
          FROM notifications_log n
          WHERE n.related_id = ast.id
            AND n.type = 'student_absent_parent'
            AND n.recipient_phone IN (st.parent_phone, st.parent_phone_2)
        ) nl ON true
        WHERE ast.status IN ('absent', 'excused')
          AND ast.date BETWEEN ${query.from}::date AND ${query.to}::date
          ${subjectAbsenceFilter}
      ),
      student_absences AS (
        SELECT
          student_id,
          COUNT(*) FILTER (WHERE status = 'absent')::int AS absence_count,
          COUNT(*) FILTER (WHERE status = 'excused')::int AS excused_count,
          COUNT(*) FILTER (WHERE has_sent = 1)::int AS sms_sent_count,
          BOOL_OR(has_failed = 1) AS has_failed
        FROM absence_rows
        GROUP BY student_id
      )
      SELECT
        st.id::text AS student_id,
        (st.last_name || ' ' || st.first_name) AS student_name,
        c.name AS class_name,
        c.id::text AS class_id,
        st.parent_phone,
        st.parent_phone_2,
        sa.absence_count,
        sa.excused_count,
        COALESCE(cs.total, 0) AS total_scheduled,
        ROUND(
          100.0 * (sa.absence_count + sa.excused_count)::numeric / NULLIF(COALESCE(cs.total, 0), 0),
          2
        )::float AS absence_rate,
        CASE
          WHEN sa.sms_sent_count = sa.absence_count THEN 'all_sent'
          WHEN sa.sms_sent_count > 0 THEN 'partial'
          ELSE 'none'
        END AS sms_summary
      FROM student_absences sa
      INNER JOIN students st ON st.id = sa.student_id
      INNER JOIN classes c ON c.id = st.class_id
      LEFT JOIN class_scheduled cs ON cs.class_id = st.class_id
      WHERE ${sql.join(filters, sql` AND `)}
      ORDER BY (sa.absence_count + sa.excused_count) DESC, student_name ASC
    `);

    return getRows<StudentAbsenceStatsDbRow>(result).map((row) => ({
      studentId: row.student_id,
      studentName: row.student_name,
      className: row.class_name,
      classId: row.class_id,
      parentPhone: row.parent_phone,
      parentPhone2: row.parent_phone_2,
      absenceCount: toNumber(row.absence_count),
      excusedCount: toNumber(row.excused_count),
      totalScheduled: toNumber(row.total_scheduled),
      absenceRate: toNumber(row.absence_rate),
      smsSummary: row.sms_summary,
    }));
  }

  async getStudentAbsenceDetails(
    studentId: string,
    query: StudentAbsencesQuery
  ): Promise<StudentAbsenceDetailRecord[]> {
    const subjectFilter = query.subject ? sql`AND s.subject = ${query.subject}` : sql``;

    const result = await this.db.execute(sql`
      SELECT
        ast.id,
        ast.date::text AS date,
        s.subject,
        c.name AS class_name,
        ts.start_time::text AS start_time,
        ts.end_time::text AS end_time,
        ast.status::text AS status,
        ast.excuse_reason,
        st.parent_phone AS phone_1,
        st.parent_phone_2 AS phone_2,
        nl1.status::text AS sms1_status,
        nl1.sent_at::text AS sms1_sent_at,
        nl2.status::text AS sms2_status,
        nl2.sent_at::text AS sms2_sent_at
      FROM attendances_student ast
      INNER JOIN students st ON st.id = ast.student_id
      -- FIX B1: LEFT JOIN instead of INNER JOIN so absences without schedule_id are included
      LEFT JOIN schedules s ON s.id = ast.schedule_id
      LEFT JOIN classes c ON c.id = s.class_id
      LEFT JOIN time_slots ts ON ts.id = s.time_slot_id
      LEFT JOIN LATERAL (
        SELECT n.status, n.sent_at
        FROM notifications_log n
        WHERE n.related_id = ast.id
          AND n.type = 'student_absent_parent'
          AND n.recipient_phone = st.parent_phone
        ORDER BY COALESCE(n.sent_at, n.created_at) DESC, n.created_at DESC
        LIMIT 1
      ) nl1 ON true
      LEFT JOIN LATERAL (
        SELECT n.status, n.sent_at
        FROM notifications_log n
        WHERE n.related_id = ast.id
          AND n.type = 'student_absent_parent'
          AND n.recipient_phone = st.parent_phone_2
        ORDER BY COALESCE(n.sent_at, n.created_at) DESC, n.created_at DESC
        LIMIT 1
      ) nl2 ON true
      WHERE ast.student_id = ${studentId}::uuid
        AND ast.status IN ('absent', 'excused')
        AND ast.date BETWEEN ${query.from}::date AND ${query.to}::date
        ${subjectFilter}
      ORDER BY ast.date DESC
    `);

    return getRows<StudentAbsenceDetailDbRow>(result).map((row) => ({
      id: row.id,
      date: row.date,
      subject: row.subject ?? 'Non renseigné',
      className: row.class_name ?? 'Non renseignée',
      startTime: row.start_time ?? '—',
      endTime: row.end_time ?? '—',
      status: row.status,
      excuseReason: row.excuse_reason,
      smsPhone1: {
        phone: row.phone_1,
        status: toSmsStatus(row.sms1_status),
        sentAt: row.sms1_sent_at,
      },
      smsPhone2: {
        phone: row.phone_2,
        status: toSmsStatus(row.sms2_status),
        sentAt: row.sms2_sent_at,
      },
    }));
  }

  private async adjustClassStudentCount(classId: string, delta: number): Promise<void> {
    await this.db.execute(sql`
      UPDATE classes
      SET student_count = GREATEST(student_count + ${delta}, 0)
      WHERE id = ${classId}
    `);
  }
}
