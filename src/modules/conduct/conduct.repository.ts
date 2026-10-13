import { sql } from 'drizzle-orm';
import { confirmedSchoolStudent } from '../../shared/database/confirmed-school-membership.js';
import { authorizedConductClass } from '../../shared/database/conduct-decision-scope.js';

import type { TenantDb } from '../../shared/database/db.js';
import type {
  ConductGradeBody,
  ConductInputBody,
  TeacherConductScopeItem,
  EducatorAssignmentItem,
  ConductPolicyMode,
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

  async findPolicy(schoolYearId: string): Promise<{ mode: ConductPolicyMode; coefficient: number } | null> {
    const result = await this.db.execute<{ mode: ConductPolicyMode; coefficient: string }>(sql`
      SELECT conduct_decision_mode AS mode, conduct_coefficient::text AS coefficient
      FROM school_years WHERE id = ${schoolYearId}::uuid LIMIT 1
    `);
    const row = getRows<{ mode: ConductPolicyMode; coefficient: string }>(result)[0];
    return row ? { mode: row.mode, coefficient: Number(row.coefficient) } : null;
  }

  async findPolicyForPeriod(gradingPeriodId: string): Promise<{ mode: ConductPolicyMode; coefficient: number } | null> {
    const result = await this.db.execute<{ mode: ConductPolicyMode; coefficient: string }>(sql`
      SELECT sy.conduct_decision_mode AS mode, sy.conduct_coefficient::text AS coefficient
      FROM grading_periods gp INNER JOIN school_years sy ON sy.id = gp.school_year_id
      WHERE gp.id = ${gradingPeriodId}::uuid LIMIT 1
    `);
    const row = getRows<{ mode: ConductPolicyMode; coefficient: string }>(result)[0];
    return row ? { mode: row.mode, coefficient: Number(row.coefficient) } : null;
  }

  async updatePolicy(schoolYearId: string, mode: ConductPolicyMode, coefficient: number, actorId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const result = await tx.execute<{ mode: string; coefficient: string }>(sql`
        SELECT conduct_decision_mode AS mode, conduct_coefficient::text AS coefficient
        FROM school_years WHERE id = ${schoolYearId}::uuid FOR UPDATE
      `);
      const old = getRows<{ mode: string; coefficient: string }>(result)[0];
      if (!old) return false;
      if (old.mode === mode && Number(old.coefficient) === coefficient) return true;
      if (Number(old.coefficient) !== coefficient) {
        const cards = await tx.execute(sql`
          SELECT 1 FROM report_cards rc INNER JOIN grading_periods gp ON gp.id = rc.grading_period_id
          WHERE gp.school_year_id = ${schoolYearId}::uuid LIMIT 1
        `);
        if (getRows(cards).length > 0) {
          const error = new Error('Le coefficient ne peut plus changer après génération des bulletins') as Error & { statusCode: number; code: string };
          error.statusCode = 409;
          error.code = 'CONDUCT_COEFFICIENT_LOCKED';
          throw error;
        }
      }
      await tx.execute(sql`
        UPDATE school_years SET conduct_decision_mode = ${mode}, conduct_coefficient = ${coefficient}, updated_at = now()
        WHERE id = ${schoolYearId}::uuid
      `);
      await tx.execute(sql`
        INSERT INTO conduct_policy_audit
          (school_year_id, changed_by_user_id, old_mode, new_mode, old_coefficient, new_coefficient)
        VALUES (${schoolYearId}::uuid, ${actorId}::uuid, ${old.mode}, ${mode}, ${old.coefficient}, ${coefficient})
      `);
      if (Number(old.coefficient) !== coefficient) {
        await tx.execute(sql`
          UPDATE conduct_grades cg SET coefficient = ${coefficient}, updated_at = now()
          FROM grading_periods gp WHERE gp.id = cg.grading_period_id AND gp.school_year_id = ${schoolYearId}::uuid
        `);
        await tx.execute(sql`
          WITH recomputed AS (
            SELECT cg.student_id, cg.grading_period_id,
              (SUM(spa.average * sub.coefficient) + cg.note * ${coefficient}::numeric)
              / (SUM(sub.coefficient) + ${coefficient}::numeric) AS average
            FROM conduct_grades cg
            INNER JOIN grading_periods gp ON gp.id = cg.grading_period_id AND gp.school_year_id = ${schoolYearId}::uuid
            INNER JOIN student_period_averages spa ON spa.student_id = cg.student_id AND spa.grading_period_id = cg.grading_period_id AND spa.subject_id IS NOT NULL
            INNER JOIN subjects sub ON sub.id = spa.subject_id
            GROUP BY cg.student_id, cg.grading_period_id, cg.note
          )
          UPDATE student_period_averages spa SET average = r.average, rank = NULL, computed_at = now()
          FROM recomputed r WHERE spa.student_id = r.student_id AND spa.grading_period_id = r.grading_period_id AND spa.subject_id IS NULL
        `);
        await tx.execute(sql`
          WITH ranked AS (
            SELECT spa.id, DENSE_RANK() OVER (
              PARTITION BY e.class_id, spa.grading_period_id ORDER BY ROUND(spa.average, 2) DESC
            )::int AS position
            FROM student_period_averages spa
            INNER JOIN grading_periods gp ON gp.id = spa.grading_period_id AND gp.school_year_id = ${schoolYearId}::uuid
            INNER JOIN enrollments e ON e.student_id = spa.student_id
              AND e.school_year_id = gp.school_year_id AND e.status = 'confirmed'
            WHERE spa.subject_id IS NULL
          )
          UPDATE student_period_averages spa SET rank = ranked.position
          FROM ranked WHERE spa.id = ranked.id
        `);
      }
      return true;
    });
  }

  async listDecisionClasses(userId: string, canFinalize: boolean): Promise<Array<{ id: string; name: string; schoolYearId: string }>> {
    const result = await this.db.execute<{ id: string; name: string; school_year_id: string }>(sql`
      SELECT c.id::text, c.name, c.school_year_id::text
      FROM classes c
      INNER JOIN school_years sy ON sy.id = c.school_year_id
      WHERE ${authorizedConductClass(userId, canFinalize)} ORDER BY c.name
    `);
    return getRows<{ id: string; name: string; school_year_id: string }>(result).map(row => ({ id: row.id, name: row.name, schoolYearId: row.school_year_id }));
  }

  async canDecideClass(userId: string, canFinalize: boolean, classId: string, gradingPeriodId: string): Promise<boolean> {
    const result = await this.db.execute(sql`
      SELECT 1 FROM classes c
      INNER JOIN school_years sy ON sy.id = c.school_year_id
      INNER JOIN grading_periods gp ON gp.school_year_id = sy.id
      WHERE c.id = ${classId}::uuid AND gp.id = ${gradingPeriodId}::uuid
        AND ${authorizedConductClass(userId, canFinalize)}
      LIMIT 1
    `);
    return getRows(result).length > 0;
  }

  async listDecisionPeriods(classIds: string[]): Promise<Array<{ id: string; label: string; schoolYearId: string; conductReviewOpen: boolean; closedClassIds: string[] }>> {
    if (classIds.length === 0) return [];
    const ids = sql.join(classIds.map(id => sql`${id}::uuid`), sql`, `);
    const result = await this.db.execute<{ id: string; label: string; school_year_id: string; review_open: boolean; closed_class_ids: string[] }>(sql`
      SELECT gp.id::text, gp.label, gp.school_year_id::text,
        gp.review_start_date <= CURRENT_DATE AS review_open,
        COALESCE(array_agg(DISTINCT gcc.class_id::text) FILTER (WHERE gcc.class_id IS NOT NULL), ARRAY[]::text[]) AS closed_class_ids
      FROM grading_periods gp INNER JOIN classes c ON c.school_year_id = gp.school_year_id AND c.id IN (${ids})
      LEFT JOIN grading_period_class_closures gcc ON gcc.grading_period_id = gp.id AND gcc.class_id = c.id
      GROUP BY gp.id ORDER BY gp.review_start_date DESC
    `);
    return getRows<{ id: string; label: string; school_year_id: string; review_open: boolean; closed_class_ids: string[] }>(result)
      .map(row => ({ id: row.id, label: row.label, schoolYearId: row.school_year_id,
        conductReviewOpen: row.review_open, closedClassIds: row.closed_class_ids }));
  }

  async listDecisionStudents(classId: string, gradingPeriodId: string): Promise<Array<{ id: string; fullName: string }>> {
    const result = await this.db.execute<{ id: string; full_name: string }>(sql`
      SELECT s.id::text, concat_ws(' ', s.first_name, s.last_name) AS full_name
      FROM classes c INNER JOIN grading_periods gp ON gp.school_year_id = c.school_year_id
      INNER JOIN students s ON ${confirmedSchoolStudent(sql`s.id`, sql`c.school_year_id`, sql`c.id`)}
      WHERE c.id = ${classId}::uuid AND gp.id = ${gradingPeriodId}::uuid
      ORDER BY s.last_name, s.first_name
    `);
    return getRows<{ id: string; full_name: string }>(result).map(row => ({ id: row.id, fullName: row.full_name }));
  }

  async listEligibleEducators(): Promise<Array<{ id: string; name: string }>> {
    const result = await this.db.execute<{ id: string; name: string }>(sql`
      SELECT DISTINCT u.id::text, u.name FROM users u
      INNER JOIN position_assignments pa ON pa.user_id = u.id
      INNER JOIN admin_positions ap ON ap.id = pa.position_id
      WHERE u.is_active = true AND u.role = 'staff' AND ap.permissions @> '["conduct.finalize"]'::jsonb
      ORDER BY u.name
    `);
    return getRows<{ id: string; name: string }>(result);
  }

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
      SELECT 1 FROM users WHERE id = ${userId}::uuid AND is_active = true AND role = 'staff' LIMIT 1
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

  async findStudentContext(studentId: string, gradingPeriodId: string): Promise<{
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
      INNER JOIN grading_periods gp ON gp.id = ${gradingPeriodId}::uuid
      INNER JOIN classes c ON c.school_year_id = gp.school_year_id
      WHERE s.id = ${studentId}::uuid
        AND ${confirmedSchoolStudent(sql`s.id`, sql`gp.school_year_id`, sql`c.id`)}
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
      SELECT 1
      WHERE EXISTS (
        SELECT 1
        FROM teacher_subject_assignments
        WHERE teacher_id = ${teacherId}::uuid AND class_id = ${classId}::uuid
      ) OR EXISTS (
        SELECT 1
        FROM schedules
        WHERE teacher_id = ${teacherId}::uuid
          AND class_id = ${classId}::uuid
          AND is_active = true
      )
      LIMIT 1
    `);
    return getRows(result).length > 0;
  }

  async educatorTargetExists(classId?: string, levelId?: string): Promise<boolean> {
    const result = await this.db.execute(sql`
      SELECT 1 WHERE
        (${classId ?? null}::uuid IS NOT NULL AND EXISTS (SELECT 1 FROM classes WHERE id = ${classId ?? null}::uuid AND is_active = true))
        OR (${levelId ?? null}::uuid IS NOT NULL AND EXISTS (SELECT 1 FROM levels WHERE id = ${levelId ?? null}::uuid))
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
      WHERE csc.class_id = ${classId}::uuid
        AND csc.grading_period_id = ${gradingPeriodId}::uuid
        AND (
          EXISTS (
            SELECT 1
            FROM teacher_subject_assignments tsa
            WHERE tsa.class_id = csc.class_id
              AND tsa.subject_id = csc.subject_id
              AND tsa.teacher_id = ${teacherId}::uuid
          )
          OR EXISTS (
            SELECT 1
            FROM schedules sch
            INNER JOIN classes class ON class.id = sch.class_id
            INNER JOIN subjects subject
              ON subject.level_id = class.level_id AND subject.name = sch.subject
            WHERE sch.teacher_id = ${teacherId}::uuid
              AND sch.class_id = ${classId}::uuid
              AND sch.is_active = true
              AND subject.id = csc.subject_id
          )
        )
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

  async isGradingPeriodCompleted(gradingPeriodId: string, classId: string): Promise<boolean> {
    const result = await this.db.execute<{ is_completed: boolean }>(sql`
      WITH target_period AS (
        SELECT id, school_year_id FROM grading_periods WHERE id = ${gradingPeriodId}::uuid
      ), class_progress AS (
        SELECT c.id AS class_id,
               COUNT(s.id)::int AS student_count,
               COUNT(rc.id) FILTER (WHERE rc.status IN ('generated', 'published'))::int AS card_count
        FROM target_period gp
        INNER JOIN classes c ON c.school_year_id = gp.school_year_id AND c.id = ${classId}::uuid
        LEFT JOIN students s ON ${confirmedSchoolStudent(sql`s.id`, sql`c.school_year_id`, sql`c.id`)}
        LEFT JOIN report_cards rc ON rc.student_id = s.id AND rc.grading_period_id = gp.id
        GROUP BY c.id
      )
      SELECT (
        EXISTS (
          SELECT 1 FROM grading_period_class_closures closure
          WHERE closure.grading_period_id = ${gradingPeriodId}::uuid
            AND closure.class_id = ${classId}::uuid
        ) OR COALESCE(BOOL_AND(student_count > 0 AND card_count >= student_count), false)
          OR EXISTS (SELECT 1 FROM report_cards WHERE class_id = ${classId}::uuid AND grading_period_id = ${gradingPeriodId}::uuid)
      ) AS is_completed
      FROM class_progress
    `);
    return getRows<{ is_completed: boolean }>(result)[0]?.is_completed ?? false;
  }

  async isConductReviewOpen(gradingPeriodId: string): Promise<boolean> {
    const result = await this.db.execute<{ open: boolean }>(sql`
      SELECT review_start_date <= CURRENT_DATE AS open
      FROM grading_periods WHERE id = ${gradingPeriodId}::uuid LIMIT 1
    `);
    return getRows<{ open: boolean }>(result)[0]?.open ?? false;
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
      FROM students s
      INNER JOIN classes c ON c.id = ${classId}::uuid
      WHERE s.id IN (${ids}) AND ${confirmedSchoolStudent(sql`s.id`, sql`c.school_year_id`, sql`c.id`)}
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
      note: string | null; observation: string | null; created_at: string | null; is_locked: boolean;
    }>(sql`
      SELECT s.id::text AS student_id,
             concat_ws(' ', s.first_name, s.last_name) AS full_name,
             s.matricule,
             tci.note::text,
             tci.observation,
             tci.created_at::text,
             (cg.id IS NOT NULL OR EXISTS (
               SELECT 1 FROM report_cards rc WHERE rc.class_id = c.id AND rc.grading_period_id = ${gradingPeriodId}::uuid
             )) AS is_locked
      FROM students s
      INNER JOIN classes c ON c.id = ${classId}::uuid
      LEFT JOIN teacher_conduct_inputs tci
        ON tci.student_id = s.id
       AND tci.teacher_id = ${teacherId}::uuid
       AND tci.grading_period_id = ${gradingPeriodId}::uuid
      LEFT JOIN conduct_grades cg ON cg.student_id = s.id AND cg.grading_period_id = ${gradingPeriodId}::uuid
      WHERE ${confirmedSchoolStudent(sql`s.id`, sql`c.school_year_id`, sql`c.id`)}
      ORDER BY s.last_name, s.first_name
    `);
    return getRows<{
      student_id: string; full_name: string; matricule: string | null;
      note: string | null; observation: string | null; created_at: string | null; is_locked: boolean;
    }>(result).map((row) => ({
      studentId: row.student_id,
      fullName: row.full_name,
      matricule: row.matricule,
      isLocked: row.is_locked,
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
    const result = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.student_id}), hashtext(${input.grading_period_id}))`);
      return tx.execute<{ id: string }>(sql`
      INSERT INTO teacher_conduct_inputs (student_id, teacher_id, class_id, grading_period_id, note, observation)
      SELECT
        ${input.student_id}::uuid,
        ${input.teacherId}::uuid,
        c.id,
        ${input.grading_period_id}::uuid,
        ${input.note},
        ${input.observation ?? null}
      FROM classes c INNER JOIN grading_periods gp ON gp.school_year_id = c.school_year_id
      WHERE gp.id = ${input.grading_period_id}::uuid
        AND gp.review_start_date <= CURRENT_DATE
        AND ${confirmedSchoolStudent(sql`${input.student_id}::uuid`, sql`gp.school_year_id`, sql`c.id`)}
        AND NOT EXISTS (SELECT 1 FROM conduct_grades cg WHERE cg.student_id = ${input.student_id}::uuid AND cg.grading_period_id = gp.id)
        AND NOT EXISTS (SELECT 1 FROM report_cards rc WHERE rc.class_id = c.id AND rc.grading_period_id = gp.id)
      ON CONFLICT ON CONSTRAINT teacher_conduct_inputs_once_per_period
      DO UPDATE SET note = EXCLUDED.note, observation = EXCLUDED.observation, updated_at = now()
      RETURNING id::text
      `);
    });
    if (getRows(result).length === 0) {
      const error = new Error('Cet avis est verrouillé par la note finale ou par les bulletins') as Error & { statusCode: number; code: string };
      error.statusCode = 409;
      error.code = 'CONDUCT_INPUT_LOCKED';
      throw error;
    }
  }

  async listConductInputsForStudent(studentId: string, gradingPeriodId: string) {
    const result = await this.db.execute<{
      id: string | null;
      teacher_id: string;
      teacher_name: string;
      subject_label: string | null;
      note: string | null;
      observation: string | null;
      created_at: string | null;
    }>(sql`
      WITH target_student AS (
        SELECT c.id AS class_id
        FROM classes c INNER JOIN grading_periods gp ON gp.school_year_id = c.school_year_id
        WHERE gp.id = ${gradingPeriodId}::uuid
          AND ${confirmedSchoolStudent(sql`${studentId}::uuid`, sql`gp.school_year_id`, sql`c.id`)}
      ), expected_teachers AS (
        SELECT DISTINCT tsa.teacher_id, tsa.class_id
        FROM teacher_subject_assignments tsa
        INNER JOIN target_student student ON student.class_id = tsa.class_id
        UNION
        SELECT DISTINCT sch.teacher_id, sch.class_id
        FROM schedules sch
        INNER JOIN target_student student ON student.class_id = sch.class_id
        WHERE sch.is_active = true
      )
      SELECT
        tci.id::text,
        t.id::text AS teacher_id,
        u.name AS teacher_name,
        (
          SELECT string_agg(labels.subject_name, ', ' ORDER BY labels.subject_name)
          FROM (
            SELECT DISTINCT subject.name AS subject_name
            FROM teacher_subject_assignments tsa
            INNER JOIN subjects subject ON subject.id = tsa.subject_id
            WHERE tsa.teacher_id = t.id AND tsa.class_id = expected.class_id
            UNION
            SELECT DISTINCT sch.subject AS subject_name
            FROM schedules sch
            WHERE sch.teacher_id = t.id AND sch.class_id = expected.class_id
              AND sch.is_active = true
          ) labels
        ) AS subject_label,
        tci.note::text,
        tci.observation,
        tci.created_at::text
      FROM expected_teachers expected
      INNER JOIN teachers t ON t.id = expected.teacher_id
      INNER JOIN users u ON u.id = t.user_id AND u.is_active = true
      LEFT JOIN teacher_conduct_inputs tci
        ON tci.teacher_id = expected.teacher_id
       AND tci.class_id = expected.class_id
       AND tci.student_id = ${studentId}::uuid
       AND tci.grading_period_id = ${gradingPeriodId}::uuid
      ORDER BY u.name, t.id
    `);

    return getRows<{
      id: string | null;
      teacher_id: string;
      teacher_name: string;
      subject_label: string | null;
      note: string | null;
      observation: string | null;
      created_at: string | null;
    }>(result).map((row) => ({
      id: row.id,
      teacherId: row.teacher_id,
      teacherName: row.teacher_name,
      subjectLabel: row.subject_label,
      note: row.note === null ? null : Number(row.note),
      observation: row.observation,
      createdAt: row.created_at,
      isSubmitted: row.note !== null,
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
    input: ConductGradeBody & { decidedByUserId: string; coefficient: number; canFinalize: boolean }
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.student_id}), hashtext(${input.grading_period_id}))`);
      const coefficientResult = await tx.execute<{ coefficient: string; allowed: boolean }>(sql`
        SELECT sy.conduct_coefficient::text AS coefficient,
          ${authorizedConductClass(input.decidedByUserId, input.canFinalize)} AS allowed
        FROM grading_periods gp INNER JOIN school_years sy ON sy.id = gp.school_year_id
        INNER JOIN classes c ON c.school_year_id = sy.id
        WHERE gp.id = ${input.grading_period_id}::uuid
          AND ${confirmedSchoolStudent(sql`${input.student_id}::uuid`, sql`gp.school_year_id`, sql`c.id`)}
        LIMIT 1 FOR SHARE OF sy
      `);
      const permission = getRows<{ coefficient: string; allowed: boolean }>(coefficientResult)[0];
      if (permission?.allowed !== true) {
        const error = new Error('Décision non autorisée pour cette classe') as Error & { statusCode: number; code: string };
        error.statusCode = 403;
        error.code = 'NOT_CONDUCT_DECIDER';
        throw error;
      }
      const currentCoefficient = Number(permission.coefficient);
      if (!Number.isFinite(currentCoefficient) || currentCoefficient <= 0) throw new Error('Invalid conduct coefficient');
      const existing = await tx.execute<{ id: string; note: string }>(sql`
        SELECT id::text, note::text FROM conduct_grades
        WHERE student_id = ${input.student_id}::uuid AND grading_period_id = ${input.grading_period_id}::uuid FOR UPDATE
      `);
      const previous = getRows<{ id: string; note: string }>(existing)[0];
      const writable = await tx.execute<{ allowed: boolean }>(sql`
        SELECT gp.review_start_date <= CURRENT_DATE
          AND NOT EXISTS (SELECT 1 FROM report_cards rc WHERE rc.grading_period_id = gp.id AND rc.class_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM grading_period_class_closures gcc WHERE gcc.grading_period_id = gp.id AND gcc.class_id = c.id)
          AS allowed
        FROM grading_periods gp INNER JOIN classes c ON c.school_year_id = gp.school_year_id
        WHERE gp.id = ${input.grading_period_id}::uuid
          AND ${confirmedSchoolStudent(sql`${input.student_id}::uuid`, sql`gp.school_year_id`, sql`c.id`)}
        LIMIT 1
      `);
      if (getRows<{ allowed: boolean }>(writable)[0]?.allowed !== true) {
        const error = new Error('La revue de cette classe est fermée') as Error & { statusCode: number; code: string };
        error.statusCode = 409;
        error.code = 'CONDUCT_REVIEW_CLOSED';
        throw error;
      }
      const updated = await tx.execute<{ id: string }>(sql`
      INSERT INTO conduct_grades (student_id, grading_period_id, note, coefficient, decided_by_user_id)
      VALUES (
        ${input.student_id}::uuid,
        ${input.grading_period_id}::uuid,
        ${input.note},
        ${currentCoefficient},
        ${input.decidedByUserId}::uuid
      )
      ON CONFLICT ("student_id", "grading_period_id")
      DO UPDATE SET
        note = EXCLUDED.note,
        coefficient = EXCLUDED.coefficient,
        decided_by_user_id = EXCLUDED.decided_by_user_id,
        decided_at = NOW(),
        updated_at = NOW()
      RETURNING id::text
      `);
      const gradeId = getRows<{ id: string }>(updated)[0]?.id;
      if (gradeId && (!previous || Number(previous.note) !== input.note)) {
        await tx.execute(sql`
          INSERT INTO conduct_grade_audit (conduct_grade_id, changed_by_user_id, old_note, new_note)
          VALUES (${gradeId}::uuid, ${input.decidedByUserId}::uuid, ${previous?.note ?? null}, ${input.note})
        `);
      }
      await tx.execute(sql`
        INSERT INTO student_period_averages (student_id, subject_id, grading_period_id, average, computed_at)
        SELECT ${input.student_id}::uuid, NULL, ${input.grading_period_id}::uuid,
          (SUM(spa.average * sub.coefficient) + ${input.note}::numeric * ${currentCoefficient}::numeric)
          / (SUM(sub.coefficient) + ${currentCoefficient}::numeric), now()
        FROM student_period_averages spa INNER JOIN subjects sub ON sub.id = spa.subject_id
        WHERE spa.student_id = ${input.student_id}::uuid AND spa.grading_period_id = ${input.grading_period_id}::uuid
        HAVING COUNT(*) > 0
        ON CONFLICT (student_id, grading_period_id) WHERE subject_id IS NULL
        DO UPDATE SET average = EXCLUDED.average, rank = NULL, computed_at = now()
      `);
      await tx.execute(sql`
        WITH class_students AS (
          SELECT e.student_id FROM enrollments e
          INNER JOIN grading_periods gp ON gp.school_year_id = e.school_year_id
          WHERE gp.id = ${input.grading_period_id}::uuid AND e.class_id = (
            SELECT e2.class_id FROM enrollments e2 WHERE e2.student_id = ${input.student_id}::uuid
              AND e2.school_year_id = gp.school_year_id AND e2.status = 'confirmed' LIMIT 1
          ) AND e.status = 'confirmed'
        ), ranked AS (
          SELECT spa.id, DENSE_RANK() OVER (ORDER BY ROUND(spa.average, 2) DESC)::int AS position
          FROM student_period_averages spa INNER JOIN class_students cs ON cs.student_id = spa.student_id
          WHERE spa.grading_period_id = ${input.grading_period_id}::uuid AND spa.subject_id IS NULL
        )
        UPDATE student_period_averages spa SET rank = ranked.position FROM ranked WHERE spa.id = ranked.id
      `);
    });
  }


}
