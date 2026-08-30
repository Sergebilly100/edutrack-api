import { sql } from 'drizzle-orm';

import type { TenantDb } from '../../shared/database/db.js';
import type {
  ConductGradeBody,
  ConductInputBody,
  TeacherConductScopeItem,
  EducatorAssignmentItem,
} from './conduct.types.js';

type Rows<T> = { rows?: T[] };

const getRows = <T>(result: unknown): T[] => {
  if (typeof result !== 'object' || result === null || !('rows' in result)) {
    return [];
  }
  const rows = (result as Rows<T>).rows;
  return Array.isArray(rows) ? rows : [];
};

// Drizzle peut envelopper l'erreur pg d'origine dans `cause`.
const isUniqueViolation = (error: unknown, constraint: string): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    code?: string;
    constraint?: string;
    cause?: { code?: string; constraint?: string };
  };
  const code = candidate.code ?? candidate.cause?.code;
  const violated = candidate.constraint ?? candidate.cause?.constraint;
  return code === '23505' && violated === constraint;
};

export class ConductRepository {
  constructor(readonly db: TenantDb) {}

  async listEducatorAssignments(): Promise<EducatorAssignmentItem[]> {
    const result = await this.db.execute(sql`
      SELECT
        ea.id::text,
        ea.class_id::text,
        c.name AS class_name,
        ea.level_id::text,
        l.name AS level_name,
        ea.user_id::text,
        u.name AS user_name,
        ea.assigned_at::text
      FROM educator_assignments ea
      INNER JOIN users u ON u.id = ea.user_id AND u.is_active = true
      LEFT JOIN classes c ON c.id = ea.class_id
      LEFT JOIN levels l ON l.id = ea.level_id
      ORDER BY ea.assigned_at DESC
    `);

    return getRows<{
      id: string;
      class_id: string | null;
      class_name: string | null;
      level_id: string | null;
      level_name: string | null;
      user_id: string;
      user_name: string;
      assigned_at: string;
    }>(result).map((row) => ({
      id: row.id,
      classId: row.class_id,
      className: row.class_name,
      levelId: row.level_id,
      levelName: row.level_name,
      userId: row.user_id,
      userName: row.user_name,
      assignedAt: row.assigned_at,
    }));
  }

  async findEducatorAssignmentById(id: string): Promise<{ id: string } | null> {
    const result = await this.db.execute(sql`
      SELECT id::text FROM educator_assignments WHERE id = ${id}::uuid LIMIT 1
    `);
    return getRows<{ id: string }>(result)[0] ?? null;
  }

  async administrativeUserExists(userId: string): Promise<boolean> {
    const result = await this.db.execute(sql`
      SELECT 1 FROM users WHERE id = ${userId}::uuid AND is_active = true LIMIT 1
    `);
    return getRows(result).length > 0;
  }

  // Le détenteur effectif de conduct.finalize est un directeur (toutes les
  // permissions) ou un staff assigné à un poste portant cette permission.
  async userHoldsConductFinalize(userId: string): Promise<boolean> {
    const result = await this.db.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM users WHERE id = ${userId}::uuid AND is_active = true AND role IN ('director', 'super_admin')
      ) OR EXISTS (
        SELECT 1
        FROM position_assignments pa
        INNER JOIN admin_positions ap ON ap.id = pa.position_id
        WHERE pa.user_id = ${userId}::uuid
          AND ap.permissions @> ${JSON.stringify(['conduct.finalize'])}::jsonb
      ) AS holds
    `);
    const row = getRows<{ holds: boolean }>(result)[0];
    return row?.holds === true;
  }

  async insertEducatorAssignment(input: {
    classId?: string;
    levelId?: string;
    userId: string;
    assignedBy: string | null;
  }): Promise<void> {
    try {
      await this.db.execute(sql`
        INSERT INTO educator_assignments (class_id, level_id, user_id, assigned_by)
        VALUES (
          ${input.classId ?? null}::uuid,
          ${input.levelId ?? null}::uuid,
          ${input.userId}::uuid,
          ${input.assignedBy ?? null}::uuid
        )
      `);
    } catch (error) {
      if (
        isUniqueViolation(error, 'educator_assignments_class_unique') ||
        isUniqueViolation(error, 'educator_assignments_level_unique')
      ) {
        const conflict = new Error('Un éducateur est déjà assigné à cette classe ou ce niveau') as Error & {
          statusCode?: number;
          code?: string;
        };
        conflict.statusCode = 409;
        conflict.code = 'EDUCATOR_ASSIGNMENT_CONFLICT';
        throw conflict;
      }
      throw error;
    }
  }

  async deleteEducatorAssignment(id: string): Promise<boolean> {
    const result = await this.db.execute(sql`
      DELETE FROM educator_assignments WHERE id = ${id}::uuid RETURNING id::text
    `);
    return getRows(result).length > 0;
  }

  async findStudentContext(studentId: string): Promise<{
    studentId: string;
    fullName: string;
    classId: string;
    className: string;
    levelId: string;
  } | null> {
    const result = await this.db.execute<{
      student_id: string;
      full_name: string;
      class_id: string;
      class_name: string;
      level_id: string;
    }>(sql`
      SELECT s.id::text AS student_id,
             concat_ws(' ', s.first_name, s.last_name) AS full_name,
             c.id::text AS class_id,
             c.name AS class_name,
             c.level_id::text AS level_id
      FROM students s
      INNER JOIN classes c ON c.id = s.class_id
      WHERE s.id = ${studentId}::uuid
      LIMIT 1
    `);
    const row = getRows<{
      student_id: string;
      full_name: string;
      class_id: string;
      class_name: string;
      level_id: string;
    }>(result)[0];
    if (!row) return null;
    return {
      studentId: row.student_id,
      fullName: row.full_name,
      classId: row.class_id,
      className: row.class_name,
      levelId: row.level_id,
    };
  }

  async findTeacherByUserId(userId: string): Promise<{ id: string; name: string } | null> {
    const result = await this.db.execute<{ id: string; name: string }>(sql`
      SELECT t.id::text, u.name
      FROM teachers t
      INNER JOIN users u ON u.id = t.user_id
      WHERE t.user_id = ${userId}::uuid
      LIMIT 1
    `);
    return getRows<{ id: string; name: string }>(result)[0] ?? null;
  }

  async teacherTeachesClass(teacherId: string, classId: string): Promise<boolean> {
    const result = await this.db.execute(sql`
      SELECT 1 FROM schedules WHERE teacher_id = ${teacherId}::uuid AND class_id = ${classId}::uuid LIMIT 1
    `);
    return getRows(result).length > 0;
  }

  async teacherHasOpenAverageCalculation(
    teacherId: string,
    classId: string,
    gradingPeriodId: string
  ): Promise<boolean> {
    const result = await this.db.execute(sql`
      SELECT 1
      FROM class_subject_completion csc
      INNER JOIN teacher_subject_assignments tsa
        ON tsa.class_id = csc.class_id AND tsa.subject_id = csc.subject_id
      WHERE csc.class_id = ${classId}::uuid
        AND csc.grading_period_id = ${gradingPeriodId}::uuid
        AND csc.status = 'in_progress'::class_subject_completion_status
        AND tsa.teacher_id = ${teacherId}::uuid
      LIMIT 1
    `);
    return getRows(result).length > 0;
  }

  async teacherHasAverageCalculation(
    teacherId: string,
    classId: string,
    gradingPeriodId: string
  ): Promise<boolean> {
    const result = await this.db.execute(sql`
      SELECT 1
      FROM class_subject_completion csc
      INNER JOIN teacher_subject_assignments tsa
        ON tsa.class_id = csc.class_id AND tsa.subject_id = csc.subject_id
      WHERE csc.class_id = ${classId}::uuid
        AND csc.grading_period_id = ${gradingPeriodId}::uuid
        AND tsa.teacher_id = ${teacherId}::uuid
      LIMIT 1
    `);
    return getRows(result).length > 0;
  }

  async gradingPeriodExists(gradingPeriodId: string): Promise<boolean> {
    const result = await this.db.execute(sql`
      SELECT 1 FROM grading_periods WHERE id = ${gradingPeriodId}::uuid LIMIT 1
    `);
    return getRows(result).length > 0;
  }

  async gradingPeriodEndDate(gradingPeriodId: string): Promise<string | null> {
    const result = await this.db.execute<{ end_date: string }> (sql`
      SELECT end_date::text
      FROM grading_periods
      WHERE id = ${gradingPeriodId}::uuid
      LIMIT 1
    `);
    return getRows<{ end_date: string }>(result)[0]?.end_date ?? null;
  }

  async gradingPeriodMatchesClass(gradingPeriodId: string, classId: string): Promise<boolean> {
    const result = await this.db.execute(sql`
      SELECT 1
      FROM grading_periods gp
      INNER JOIN classes c ON c.school_year_id = gp.school_year_id
      WHERE gp.id = ${gradingPeriodId}::uuid AND c.id = ${classId}::uuid
      LIMIT 1
    `);
    return getRows(result).length > 0;
  }

  async studentsBelongToClass(studentIds: string[], classId: string): Promise<boolean> {
    if (studentIds.length === 0) return false;
    const ids = sql.join(studentIds.map((studentId) => sql`${studentId}::uuid`), sql`, `);
    const result = await this.db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count
      FROM students
      WHERE id IN (${ids}) AND class_id = ${classId}::uuid AND is_active = true
    `);
    return Number(getRows<{ count: string }>(result)[0]?.count ?? 0) === studentIds.length;
  }

  async listTeacherConductScope(
    teacherId: string,
    classId: string,
    gradingPeriodId: string
  ): Promise<TeacherConductScopeItem[]> {
    const result = await this.db.execute<{
      student_id: string; full_name: string; matricule: string | null;
      note: string | null; observation: string | null; created_at: string | null;
    }>(sql`
      SELECT s.id::text AS student_id,
             concat_ws(' ', s.first_name, s.last_name) AS full_name,
             s.matricule,
             tci.note::text,
             tci.observation,
             tci.created_at::text
      FROM students s
      LEFT JOIN teacher_conduct_inputs tci
        ON tci.student_id = s.id
       AND tci.teacher_id = ${teacherId}::uuid
       AND tci.grading_period_id = ${gradingPeriodId}::uuid
      WHERE s.class_id = ${classId}::uuid AND s.is_active = true
      ORDER BY s.last_name, s.first_name
    `);
    return getRows<{
      student_id: string; full_name: string; matricule: string | null;
      note: string | null; observation: string | null; created_at: string | null;
    }>(result).map((row) => ({
      studentId: row.student_id,
      fullName: row.full_name,
      matricule: row.matricule,
      input: row.note === null ? null : {
        note: Number(row.note),
        observation: row.observation,
        createdAt: row.created_at ?? '',
      },
    }));
  }

  async gradingPeriodLabel(gradingPeriodId: string): Promise<{ id: string; label: string } | null> {
    const result = await this.db.execute<{ id: string; label: string }>(sql`
      SELECT id::text, label FROM grading_periods WHERE id = ${gradingPeriodId}::uuid LIMIT 1
    `);
    return getRows<{ id: string; label: string }>(result)[0] ?? null;
  }

  async insertTeacherConductInput(
    input: ConductInputBody & { teacherId: string }
  ): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO teacher_conduct_inputs (student_id, teacher_id, class_id, grading_period_id, note, observation)
      VALUES (
        ${input.student_id}::uuid,
        ${input.teacherId}::uuid,
        (SELECT class_id FROM students WHERE id = ${input.student_id}::uuid),
        ${input.grading_period_id}::uuid,
        ${input.note},
        ${input.observation ?? null}
      )
      ON CONFLICT ON CONSTRAINT teacher_conduct_inputs_once_per_period
      DO UPDATE SET note = EXCLUDED.note, observation = EXCLUDED.observation, updated_at = now()
    `);
  }

  async listConductInputsForStudent(studentId: string, gradingPeriodId: string) {
    const result = await this.db.execute<{
      id: string;
      teacher_name: string;
      subject_label: string | null;
      note: string;
      observation: string | null;
      created_at: string;
    }>(sql`
      SELECT
        tci.id::text,
        u.name AS teacher_name,
        (
          SELECT DISTINCT sch.subject
          FROM schedules sch
          WHERE sch.teacher_id = tci.teacher_id AND sch.class_id = tci.class_id
          LIMIT 1
        ) AS subject_label,
        tci.note::text,
        tci.observation,
        tci.created_at::text
      FROM teacher_conduct_inputs tci
      INNER JOIN teachers t ON t.id = tci.teacher_id
      INNER JOIN users u ON u.id = t.user_id
      WHERE tci.student_id = ${studentId}::uuid
        AND tci.grading_period_id = ${gradingPeriodId}::uuid
      ORDER BY tci.created_at ASC
    `);

    return getRows<{
      id: string;
      teacher_name: string;
      subject_label: string | null;
      note: string;
      observation: string | null;
      created_at: string;
    }>(result).map((row) => ({
      id: row.id,
      teacherName: row.teacher_name,
      subjectLabel: row.subject_label,
      note: Number(row.note),
      observation: row.observation,
      createdAt: row.created_at,
    }));
  }

  async listSpontaneousEvaluationsForStudent(studentId: string, gradingPeriodId: string) {
    const result = await this.db.execute<{
      id: string;
      label: string;
      score: string;
      max_score: string;
      comment: string | null;
      created_at: string;
    }>(sql`
      SELECT
        eg.id::text,
        e.label,
        eg.score::text,
        eg.max_score::text,
        eg.comment,
        eg.created_at::text
      FROM evaluation_grades eg
      INNER JOIN evaluations e ON e.id = eg.evaluation_id
      WHERE eg.student_id = ${studentId}::uuid
        AND e.grading_period_id = ${gradingPeriodId}::uuid
        AND e.type = 'spontaneous'
      ORDER BY eg.created_at ASC
    `);

    return getRows<{
      id: string;
      label: string;
      score: string;
      max_score: string;
      comment: string | null;
      created_at: string;
    }>(result).map((row) => ({
      id: row.id,
      label: row.label,
      score: Number(row.score),
      maxScore: Number(row.max_score),
      comment: row.comment,
      createdAt: row.created_at,
    }));
  }

  async findFinalGrade(studentId: string, gradingPeriodId: string) {
    const result = await this.db.execute<{
      note: string;
      coefficient: string;
      decided_by_user_id: string;
      decided_at: string;
    }>(sql`
      SELECT note::text, coefficient::text, decided_by_user_id::text, decided_at::text
      FROM conduct_grades
      WHERE student_id = ${studentId}::uuid AND grading_period_id = ${gradingPeriodId}::uuid
      LIMIT 1
    `);
    const row = getRows<{
      note: string;
      coefficient: string;
      decided_by_user_id: string;
      decided_at: string;
    }>(result)[0];
    if (!row) return null;
    return {
      note: Number(row.note),
      coefficient: Number(row.coefficient),
      decidedByUserId: row.decided_by_user_id,
      decidedAt: row.decided_at,
    };
  }

  async upsertConductGrade(
    input: ConductGradeBody & { decidedByUserId: string; coefficient: number }
  ): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO conduct_grades (student_id, grading_period_id, note, coefficient, decided_by_user_id)
      VALUES (
        ${input.student_id}::uuid,
        ${input.grading_period_id}::uuid,
        ${input.note},
        ${input.coefficient},
        ${input.decidedByUserId}::uuid
      )
      ON CONFLICT ("student_id", "grading_period_id")
      DO UPDATE SET
        note = EXCLUDED.note,
        coefficient = EXCLUDED.coefficient,
        decided_by_user_id = EXCLUDED.decided_by_user_id,
        decided_at = NOW(),
        updated_at = NOW()
    `);
  }

  // L'éducateur décideur doit être assigné à la classe de l'élève OU à son niveau.
  async isAssignedEducatorForStudent(userId: string, studentId: string): Promise<boolean> {
    const result = await this.db.execute(sql`
      SELECT 1
      FROM educator_assignments ea
      INNER JOIN students s ON s.id = ${studentId}::uuid
      INNER JOIN classes c ON c.id = s.class_id
      WHERE ea.user_id = ${userId}::uuid
        AND (ea.class_id = c.id OR ea.level_id = c.level_id)
      LIMIT 1
    `);
    return getRows(result).length > 0;
  }
}
