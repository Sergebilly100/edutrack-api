import { sql } from 'drizzle-orm';
import { confirmedSchoolStudent } from '../../shared/database/confirmed-school-membership.js';

import type { TenantDb } from '../../shared/database/db.js';

type Rows<T> = { rows?: T[] };
type ClaimRow = {
  id: string; class_id: string; student_id: string | null; subject_id: string; grading_period_id: string;
  requested_by_user_id: string; reason: string; status: string; phase: string | null;
};
type ClaimListRow = ClaimRow & {
  school_year_id: string; subject_name: string; class_name: string; student_name: string | null;
  decided_by_user_id: string | null; decision_reason: string | null;
  created_at: string; decided_at: string | null; revalidated_at: string | null;
  regenerated_at: string | null; republished_at: string | null;
};

const getRows = <T>(result: unknown): T[] => {
  if (typeof result !== 'object' || result === null || !('rows' in result)) {
    return [];
  }
  const rows = (result as Rows<T>).rows;
  return Array.isArray(rows) ? rows : [];
};

export class ReportCardsRepository {
  constructor(readonly db: TenantDb) {}

  async transaction<T>(work: (repository: ReportCardsRepository) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => work(new ReportCardsRepository(tx as TenantDb)));
  }

  async lockClassPeriod(classId: string, gradingPeriodId: string): Promise<void> {
    await this.db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${classId}), hashtext(${gradingPeriodId}))`);
  }

  async schoolYearExists(schoolYearId: string): Promise<boolean> {
    const result = await this.db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM school_years WHERE id = ${schoolYearId}::uuid) AS exists
    `);
    return getRows<{ exists: boolean }>(result)[0]?.exists ?? false;
  }

  async schoolYearStatus(schoolYearId: string): Promise<string | null> {
    const result = await this.db.execute<{ status: string }>(sql`
      SELECT status::text FROM school_years WHERE id = ${schoolYearId}::uuid LIMIT 1
    `);
    return getRows<{ status: string }>(result)[0]?.status ?? null;
  }

  async listReportCardClasses(schoolYearId: string): Promise<Array<{
    id: string; name: string; isActive: boolean; level: { id: string; name: string; orderIndex: number };
  }>> {
    const result = await this.db.execute<{
      id: string; name: string; is_active: boolean;
      level_id: string; level_name: string; level_order_index: number;
    }>(sql`
      SELECT c.id::text, c.name, c.is_active,
        l.id::text AS level_id, l.name AS level_name, l.order_index AS level_order_index
      FROM classes c
      JOIN levels l ON l.id = c.level_id
      JOIN school_years sy ON sy.id = c.school_year_id
      WHERE c.school_year_id = ${schoolYearId}::uuid
        AND ((sy.status <> 'closed' AND c.is_active = true)
          OR EXISTS (SELECT 1 FROM report_cards rc
            JOIN grading_periods gp ON gp.id = rc.grading_period_id
            WHERE rc.class_id = c.id AND gp.school_year_id = c.school_year_id)
          OR EXISTS (SELECT 1 FROM grading_period_class_closures gcc
            JOIN grading_periods gp ON gp.id = gcc.grading_period_id
            WHERE gcc.class_id = c.id AND gp.school_year_id = c.school_year_id))
      ORDER BY l.order_index, c.name
    `);
    return getRows<{
      id: string; name: string; is_active: boolean;
      level_id: string; level_name: string; level_order_index: number;
    }>(result).map((row) => ({
      id: row.id, name: row.name, isActive: row.is_active,
      level: { id: row.level_id, name: row.level_name, orderIndex: row.level_order_index },
    }));
  }

  async isAssignedSubject(classId: string, subjectId: string): Promise<boolean> {
    const result = await this.db.execute<{ allowed: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM teacher_subject_assignments tsa
        INNER JOIN teachers t ON t.id = tsa.teacher_id AND t.is_blocked = false
        INNER JOIN users u ON u.id = t.user_id AND u.is_active = true
        WHERE tsa.class_id = ${classId}::uuid AND tsa.subject_id = ${subjectId}::uuid
      ) AS allowed
    `);
    return getRows<{ allowed: boolean }>(result)[0]?.allowed ?? false;
  }

  async subjectBelongsToClass(classId: string, subjectId: string): Promise<boolean> {
    const result = await this.db.execute<{ allowed: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM classes c JOIN subjects s ON s.level_id = c.level_id
        WHERE c.id = ${classId}::uuid AND s.id = ${subjectId}::uuid
      ) AS allowed
    `);
    return getRows<{ allowed: boolean }>(result)[0]?.allowed ?? false;
  }

  async isSubjectCompleted(classId: string, subjectId: string, gradingPeriodId: string): Promise<boolean> {
    const result = await this.db.execute<{ completed: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM class_subject_completion
        WHERE class_id = ${classId}::uuid AND subject_id = ${subjectId}::uuid
          AND grading_period_id = ${gradingPeriodId}::uuid AND status = 'completed') AS completed
    `);
    return getRows<{ completed: boolean }>(result)[0]?.completed ?? false;
  }

  async createClaim(input: { classId: string; studentId?: string; subjectId: string; gradingPeriodId: string; userId: string; reason: string; status: 'open' | 'pending_exceptional_authorization'; phase: 'before' | 'generated' | 'published' }) {
    const result = await this.db.execute<{ id: string }>(sql`
      INSERT INTO report_card_claims (class_id, student_id, subject_id, grading_period_id, requested_by_user_id, reason, status, phase)
      VALUES (${input.classId}::uuid, ${input.studentId ?? null}::uuid, ${input.subjectId}::uuid, ${input.gradingPeriodId}::uuid,
        ${input.userId}::uuid, ${input.reason}, ${input.status}, ${input.phase}) RETURNING id::text
    `);
    const claimId = getRows<{ id: string }>(result)[0]!.id;
    await this.db.execute(sql`
      INSERT INTO academic_change_audit (actor_user_id, class_id, subject_id, grading_period_id,
        claim_id, operation, old_value, new_value)
      VALUES (${input.userId}::uuid, ${input.classId}::uuid, ${input.subjectId}::uuid,
        ${input.gradingPeriodId}::uuid, ${claimId}::uuid, 'claim_created', NULL,
        jsonb_build_object('status', ${input.status}::text, 'phase', ${input.phase}::text,
          'studentId', ${input.studentId ?? null}::text, 'reason', ${input.reason}::text))
    `);
    return claimId;
  }

  async findClaim(claimId: string, forUpdate = false) {
    const result = await this.db.execute<ClaimRow>(sql`
      SELECT id::text, class_id::text, student_id::text, subject_id::text, grading_period_id::text,
        requested_by_user_id::text, reason, status, phase
      FROM report_card_claims WHERE id = ${claimId}::uuid
      ${forUpdate ? sql`FOR UPDATE` : sql``}
    `);
    return getRows<ClaimRow>(result)[0] ?? null;
  }

  async listClaims(filters: { schoolYearId?: string; gradingPeriodId?: string; classId?: string; studentId?: string; subjectId?: string; status?: string }) {
    const result = await this.db.execute<ClaimListRow>(sql`
      SELECT r.id::text, r.class_id::text, r.student_id::text, r.subject_id::text, r.grading_period_id::text,
        gp.school_year_id::text, s.name AS subject_name, c.name AS class_name,
        CASE WHEN student.id IS NULL THEN NULL ELSE concat_ws(' ', student.first_name, student.last_name) END AS student_name,
        r.status, r.reason, r.phase, r.requested_by_user_id::text,
        r.decided_by_user_id::text, r.decision_reason, r.created_at::text,
        r.decided_at::text, r.revalidated_at::text, r.regenerated_at::text, r.republished_at::text
      FROM report_card_claims r
      JOIN classes c ON c.id = r.class_id
      JOIN subjects s ON s.id = r.subject_id
      LEFT JOIN students student ON student.id = r.student_id
      JOIN grading_periods gp ON gp.id = r.grading_period_id AND gp.school_year_id = c.school_year_id
      WHERE (${filters.schoolYearId ?? null}::uuid IS NULL OR gp.school_year_id = ${filters.schoolYearId ?? null}::uuid)
        AND (${filters.gradingPeriodId ?? null}::uuid IS NULL OR r.grading_period_id = ${filters.gradingPeriodId ?? null}::uuid)
        AND (${filters.classId ?? null}::uuid IS NULL OR r.class_id = ${filters.classId ?? null}::uuid)
        AND (${filters.studentId ?? null}::uuid IS NULL OR r.student_id = ${filters.studentId ?? null}::uuid)
        AND (${filters.subjectId ?? null}::uuid IS NULL OR r.subject_id = ${filters.subjectId ?? null}::uuid)
        AND (${filters.status ?? null}::text IS NULL OR r.status = ${filters.status ?? null})
      ORDER BY r.created_at DESC
    `);
    return getRows<ClaimListRow>(result);
  }

  async getCardsPhase(classId: string, gradingPeriodId: string): Promise<'published' | 'generated' | 'before'> {
    const result = await this.db.execute<{ published: number; generated: number }>(sql`
      SELECT count(*) FILTER (WHERE status = 'published')::int AS published,
             count(*) FILTER (WHERE status = 'generated')::int AS generated
      FROM report_cards WHERE class_id = ${classId}::uuid AND grading_period_id = ${gradingPeriodId}::uuid
    `);
    const row = getRows<{ published: number; generated: number }>(result)[0];
    return row?.published ? 'published' : row?.generated ? 'generated' : 'before';
  }

  async setClaimDecision(claimId: string, input: { status: 'approved' | 'refused'; phase: string; userId: string; reason: string; oldStatus: string }): Promise<void> {
    await this.db.execute(sql`
      UPDATE report_card_claims SET status = ${input.status}, phase = ${input.phase},
        decided_by_user_id = ${input.userId}::uuid, decision_reason = ${input.reason}, decided_at = now()
      WHERE id = ${claimId}::uuid
    `);
    await this.db.execute(sql`
      INSERT INTO academic_change_audit (actor_user_id, class_id, subject_id, grading_period_id,
        claim_id, operation, old_value, new_value)
      SELECT ${input.userId}::uuid, class_id, subject_id, grading_period_id, id,
        ${input.status === 'approved' ? 'claim_approved' : 'claim_refused'},
        jsonb_build_object('status', ${input.oldStatus}::text),
        jsonb_build_object('status', ${input.status}::text, 'phase', ${input.phase}::text, 'reason', ${input.reason}::text)
      FROM report_card_claims WHERE id = ${claimId}::uuid
    `);
  }

  async snapshotPublishedCards(classId: string, gradingPeriodId: string): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO report_card_versions (card_id, student_id, class_id, grading_period_id,
        revision, snapshot, published_at, published_by_user_id)
      SELECT rc.id, rc.student_id, rc.class_id, rc.grading_period_id,
        COALESCE((SELECT max(v.revision) FROM report_card_versions v
          WHERE v.student_id = rc.student_id AND v.grading_period_id = rc.grading_period_id), 0) + 1,
        jsonb_build_object('card', to_jsonb(rc), 'lines', COALESCE(
          (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.created_at) FROM report_card_lines l WHERE l.report_card_id = rc.id), '[]'::jsonb)),
        rc.published_at, rc.published_by_user_id
      FROM report_cards rc
      WHERE rc.class_id = ${classId}::uuid AND rc.grading_period_id = ${gradingPeriodId}::uuid
        AND rc.status = 'published' AND rc.published_at IS NOT NULL AND rc.published_by_user_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM report_card_versions v WHERE v.card_id = rc.id AND v.invalidated_at IS NULL)
    `);
  }

  async invalidateClassCards(input: { classId: string; gradingPeriodId: string; subjectId: string; claimId: string; userId: string; reason: string }): Promise<void> {
    await this.snapshotPublishedCards(input.classId, input.gradingPeriodId);
    await this.db.execute(sql`
      UPDATE report_card_versions SET invalidated_at = now(), invalidated_by_user_id = ${input.userId}::uuid,
        invalidation_claim_id = ${input.claimId}::uuid, invalidation_reason = ${input.reason}
      WHERE class_id = ${input.classId}::uuid AND grading_period_id = ${input.gradingPeriodId}::uuid
        AND invalidated_at IS NULL
    `);
    await this.db.execute(sql`DELETE FROM report_cards WHERE class_id = ${input.classId}::uuid AND grading_period_id = ${input.gradingPeriodId}::uuid`);
    await this.db.execute(sql`DELETE FROM grading_period_class_closures WHERE class_id = ${input.classId}::uuid AND grading_period_id = ${input.gradingPeriodId}::uuid`);
    await this.reopenSubject(input);
  }

  async reopenSubject(input: { classId: string; gradingPeriodId: string; subjectId: string; claimId: string; userId: string }): Promise<void> {
    const result = await this.db.execute(sql`
      UPDATE class_subject_completion SET status = 'in_progress', completed_at = NULL, updated_at = now()
      WHERE class_id = ${input.classId}::uuid AND subject_id = ${input.subjectId}::uuid
        AND grading_period_id = ${input.gradingPeriodId}::uuid AND status = 'completed'
      RETURNING id
    `);
    if (getRows(result).length !== 1) throw new Error('Subject was not completed at correction approval');
    await this.db.execute(sql`
      INSERT INTO academic_change_audit (actor_user_id, class_id, subject_id, grading_period_id,
        claim_id, operation, old_value, new_value)
      VALUES (${input.userId}::uuid, ${input.classId}::uuid, ${input.subjectId}::uuid,
        ${input.gradingPeriodId}::uuid, ${input.claimId}::uuid, 'correction_opened',
        '"completed"'::jsonb, '"in_progress"'::jsonb)
    `);
  }

  async markRegenerated(classId: string, gradingPeriodId: string, userId?: string): Promise<void> {
    if (!userId) return;
    await this.db.execute(sql`
      WITH changed AS (
        UPDATE report_card_claims SET status = 'regenerated', regenerated_at = now()
        WHERE class_id = ${classId}::uuid AND grading_period_id = ${gradingPeriodId}::uuid
          AND status = 'corrected' AND phase <> 'before'
        RETURNING id, class_id, subject_id, grading_period_id
      )
      INSERT INTO academic_change_audit (actor_user_id, class_id, subject_id, grading_period_id,
        claim_id, operation, old_value, new_value)
      SELECT ${userId}::uuid, class_id, subject_id, grading_period_id, id,
        'cards_regenerated', '"corrected"'::jsonb, '"regenerated"'::jsonb FROM changed
    `);
  }

  async markRepublished(classId: string, gradingPeriodId: string, userId: string): Promise<void> {
    await this.db.execute(sql`
      WITH changed AS (
        UPDATE report_card_claims SET status = 'republished', republished_at = now()
        WHERE class_id = ${classId}::uuid AND grading_period_id = ${gradingPeriodId}::uuid
          AND status = 'regenerated'
          AND NOT EXISTS (SELECT 1 FROM report_cards rc WHERE rc.class_id = ${classId}::uuid
            AND rc.grading_period_id = ${gradingPeriodId}::uuid AND rc.status <> 'published')
        RETURNING id, class_id, subject_id, grading_period_id
      )
      INSERT INTO academic_change_audit (actor_user_id, class_id, subject_id, grading_period_id,
        claim_id, operation, old_value, new_value)
      SELECT ${userId}::uuid, class_id, subject_id, grading_period_id, id,
        'cards_republished', '"regenerated"'::jsonb, '"republished"'::jsonb FROM changed
    `);
  }

  async getCorrectionPublicationState(classId: string, gradingPeriodId: string): Promise<string | null> {
    const result = await this.db.execute<{ status: string }>(sql`
      SELECT status FROM report_card_claims
      WHERE class_id = ${classId}::uuid AND grading_period_id = ${gradingPeriodId}::uuid
        AND phase <> 'before'
        AND status IN ('approved', 'corrected', 'regenerated')
      ORDER BY created_at DESC LIMIT 1
    `);
    return getRows<{ status: string }>(result)[0]?.status ?? null;
  }

  async listVersions(classId: string, gradingPeriodId: string) {
    const result = await this.db.execute<{ id: string; student_id: string; revision: number; snapshot: unknown; published_at: string; invalidated_at: string | null; invalidation_reason: string | null }>(sql`
      SELECT id::text, student_id::text, revision, snapshot, published_at::text,
        invalidated_at::text, invalidation_reason FROM report_card_versions
      WHERE class_id = ${classId}::uuid AND grading_period_id = ${gradingPeriodId}::uuid
      ORDER BY student_id, revision
    `);
    return getRows(result);
  }

  async listAcademicAudit(classId: string, gradingPeriodId: string) {
    const result = await this.db.execute<{
      id: string; actor_user_id: string; class_id: string; subject_id: string;
      grading_period_id: string; evaluation_id: string | null; student_id: string | null;
      claim_id: string | null; operation: string; old_value: unknown; new_value: unknown; created_at: string;
    }>(sql`
      SELECT id::text, actor_user_id::text, class_id::text, subject_id::text,
        grading_period_id::text, evaluation_id::text, student_id::text, claim_id::text,
        operation, old_value, new_value, created_at::text
      FROM academic_change_audit
      WHERE class_id = ${classId}::uuid AND grading_period_id = ${gradingPeriodId}::uuid
      ORDER BY created_at, id
    `);
    return getRows(result);
  }

  async isStudentReportInRevision(studentId: string): Promise<boolean> {
    const result = await this.db.execute<{ active: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM report_card_claims r
        JOIN enrollments e ON e.class_id = r.class_id AND e.student_id = ${studentId}::uuid
        JOIN classes c ON c.id = r.class_id AND c.school_year_id = e.school_year_id
        JOIN grading_periods gp ON gp.id = r.grading_period_id AND gp.school_year_id = c.school_year_id
        WHERE e.status = 'confirmed' AND r.phase = 'published'
          AND r.status IN ('approved', 'corrected', 'regenerated')
      ) AS active
    `);
    return getRows<{ active: boolean }>(result)[0]?.active ?? false;
  }

  async findClassContext(classId: string): Promise<{ id: string; name: string; levelId: string; schoolYearId: string } | null> {
    const result = await this.db.execute<{
      id: string;
      name: string;
      level_id: string;
      school_year_id: string;
    }>(sql`
      SELECT id::text, name, level_id::text, school_year_id::text
      FROM classes WHERE id = ${classId}::uuid LIMIT 1
    `);
    const row = getRows<{ id: string; name: string; level_id: string; school_year_id: string }>(result)[0];
    if (!row) return null;
    return { id: row.id, name: row.name, levelId: row.level_id, schoolYearId: row.school_year_id };
  }

  async findGradingPeriod(gradingPeriodId: string): Promise<{
    id: string;
    label: string;
    orderIndex: number;
    schoolYearId: string;
    yearLabel: string;
  } | null> {
    const result = await this.db.execute<{
      id: string;
      label: string;
      order_index: number;
      school_year_id: string;
      year_label: string;
    }>(sql`
      SELECT gp.id::text, gp.label, gp.order_index, gp.school_year_id::text, sy.label AS year_label
      FROM grading_periods gp
      INNER JOIN school_years sy ON sy.id = gp.school_year_id
      WHERE gp.id = ${gradingPeriodId}::uuid
      LIMIT 1
    `);
    const row = getRows<{
      id: string;
      label: string;
      order_index: number;
      school_year_id: string;
      year_label: string;
    }>(result)[0];
    if (!row) return null;
    return {
      id: row.id,
      label: row.label,
      orderIndex: row.order_index,
      schoolYearId: row.school_year_id,
      yearLabel: row.year_label,
    };
  }

  /** La période donnée est-elle la dernière de l'année scolaire (décision affichée) ? */
  async isLastPeriodOfYear(schoolYearId: string, gradingPeriodId: string): Promise<boolean> {
    const result = await this.db.execute<{ max_order: number; current_order: number }>(sql`
      SELECT MAX(order_index)::int AS max_order,
             MAX(CASE WHEN id = ${gradingPeriodId}::uuid THEN order_index END)::int AS current_order
      FROM grading_periods
      WHERE school_year_id = ${schoolYearId}::uuid
    `);
    const row = getRows<{ max_order: number; current_order: number }>(result)[0];
    return row !== undefined && row.current_order !== null && row.current_order === row.max_order;
  }

  /** La génération est disponible dès le début de revue de la période. */
  async isBulletinGenerationAvailable(schoolYearId: string, gradingPeriodId: string): Promise<boolean> {
    const result = await this.db.execute<{ open: boolean }>(sql`
      SELECT review_start_date <= CURRENT_DATE AS open
      FROM grading_periods
      WHERE school_year_id = ${schoolYearId}::uuid AND id = ${gradingPeriodId}::uuid
      LIMIT 1
    `);
    return getRows<{ open: boolean }>(result)[0]?.open ?? false;
  }

  async isClassReviewClosed(gradingPeriodId: string, classId: string): Promise<boolean> {
    const result = await this.db.execute<{ closed: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM grading_period_class_closures
        WHERE grading_period_id = ${gradingPeriodId}::uuid AND class_id = ${classId}::uuid
      ) AS closed
    `);
    return getRows<{ closed: boolean }>(result)[0]?.closed ?? false;
  }

  async closeClassReview(gradingPeriodId: string, classId: string): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO grading_period_class_closures (grading_period_id, class_id)
      VALUES (${gradingPeriodId}::uuid, ${classId}::uuid)
      ON CONFLICT (grading_period_id, class_id) DO NOTHING
    `);
  }

  async listClassStudents(classId: string): Promise<Array<{ id: string; fullName: string }>> {
    const result = await this.db.execute<{ id: string; full_name: string }>(sql`
      SELECT s.id::text, concat_ws(' ', s.first_name, s.last_name) AS full_name
      FROM students s
      INNER JOIN classes c ON c.id = ${classId}::uuid
      WHERE ${confirmedSchoolStudent(sql`s.id`, sql`c.school_year_id`, sql`c.id`)}
      ORDER BY s.last_name ASC, s.first_name ASC
    `);
    return getRows<{ id: string; full_name: string }>(result).map((row) => ({
      id: row.id,
      fullName: row.full_name,
    }));
  }

  async listIncompleteSubjects(classId: string, gradingPeriodId: string): Promise<string[]> {
    const result = await this.db.execute<{ name: string }>(sql`
      SELECT s.name
      FROM classes c
      INNER JOIN subjects s ON s.level_id = c.level_id
      LEFT JOIN class_subject_completion csc
        ON csc.class_id = c.id
        AND csc.subject_id = s.id
        AND csc.grading_period_id = ${gradingPeriodId}::uuid
      WHERE c.id = ${classId}::uuid
        AND COALESCE(csc.status, 'in_progress'::class_subject_completion_status)
          <> 'completed'::class_subject_completion_status
      ORDER BY s.name
    `);
    return getRows<{ name: string }>(result).map((row) => row.name);
  }

  /** Moyennes par matière déjà calculées (module academic) pour toute la classe. */
  async listSubjectAverages(
    classId: string,
    gradingPeriodId: string
  ): Promise<Array<{ studentId: string; subjectId: string; average: number }>> {
    const result = await this.db.execute<{ student_id: string; subject_id: string; average: string }>(sql`
      SELECT spa.student_id::text, spa.subject_id::text, spa.average::text
      FROM student_period_averages spa
      INNER JOIN students s ON s.id = spa.student_id
      INNER JOIN classes c ON c.id = ${classId}::uuid
      WHERE ${confirmedSchoolStudent(sql`s.id`, sql`c.school_year_id`, sql`c.id`)}
        AND spa.grading_period_id = ${gradingPeriodId}::uuid
        AND spa.subject_id IS NOT NULL
        AND s.is_active = true
    `);
    return getRows<{ student_id: string; subject_id: string; average: string }>(result).map((row) => ({
      studentId: row.student_id,
      subjectId: row.subject_id,
      average: Number(row.average),
    }));
  }

  /** Moyennes générales (subject_id IS NULL) pour toute la classe. */
  async listGeneralAverages(
    classId: string,
    gradingPeriodId: string
  ): Promise<Array<{ studentId: string; average: number }>> {
    const result = await this.db.execute<{ student_id: string; average: string }>(sql`
      SELECT spa.student_id::text, spa.average::text
      FROM student_period_averages spa
      INNER JOIN students s ON s.id = spa.student_id
      INNER JOIN classes c ON c.id = ${classId}::uuid
      WHERE ${confirmedSchoolStudent(sql`s.id`, sql`c.school_year_id`, sql`c.id`)}
        AND spa.grading_period_id = ${gradingPeriodId}::uuid
        AND spa.subject_id IS NULL
        AND s.is_active = true
    `);
    return getRows<{ student_id: string; average: string }>(result).map((row) => ({
      studentId: row.student_id,
      average: Number(row.average),
    }));
  }

  async listLevelSubjects(levelId: string): Promise<Array<{ id: string; name: string; coefficient: number }>> {
    const result = await this.db.execute<{ id: string; name: string; coefficient: string }>(sql`
      SELECT id::text, name, coefficient::text FROM subjects WHERE level_id = ${levelId}::uuid ORDER BY name ASC
    `);
    return getRows<{ id: string; name: string; coefficient: string }>(result).map((row) => ({
      id: row.id,
      name: row.name,
      coefficient: Number(row.coefficient),
    }));
  }

  async findConductGrade(studentId: string, gradingPeriodId: string): Promise<{
    note: number;
    coefficient: number;
  } | null> {
    const result = await this.db.execute<{ note: string; coefficient: string }>(sql`
      SELECT cg.note::text, sy.conduct_coefficient::text AS coefficient
      FROM conduct_grades cg
      INNER JOIN grading_periods gp ON gp.id = cg.grading_period_id
      INNER JOIN school_years sy ON sy.id = gp.school_year_id
      WHERE cg.student_id = ${studentId}::uuid AND cg.grading_period_id = ${gradingPeriodId}::uuid
      LIMIT 1
    `);
    const row = getRows<{ note: string; coefficient: string }>(result)[0];
    if (!row) return null;
    return { note: Number(row.note), coefficient: Number(row.coefficient) };
  }

  async findValidatedDecision(studentId: string, schoolYearId: string): Promise<{ id: string; decision: string } | null> {
    const result = await this.db.execute<{ id: string; decision: string }>(sql`
      SELECT id::text, final_decision::text AS decision
      FROM class_decisions
      WHERE student_id = ${studentId}::uuid
        AND school_year_id = ${schoolYearId}::uuid
        AND final_decision IS NOT NULL
        AND validated_at IS NOT NULL
      LIMIT 1
    `);
    return getRows<{ id: string; decision: string }>(result)[0] ?? null;
  }

  async findExistingCard(studentId: string, gradingPeriodId: string): Promise<{ id: string; status: 'generated' | 'published' } | null> {
    const result = await this.db.execute<{ id: string; status: string }>(sql`
      SELECT id::text, status::text
      FROM report_cards
      WHERE student_id = ${studentId}::uuid AND grading_period_id = ${gradingPeriodId}::uuid
      LIMIT 1
    `);
    const row = getRows<{ id: string; status: string }>(result)[0];
    if (!row) return null;
    return { id: row.id, status: row.status as 'generated' | 'published' };
  }

  /**
   * Snapshot complet d'un bulletin dans une transaction : remplace la carte
   * générée existante ; refuse d'écraser un bulletin publié.
   */
  async replaceGeneratedCard(input: {
    studentId: string;
    classId: string;
    gradingPeriodId: string;
    generalAverage: number;
    rank: number;
    classAverage: number;
    classMinAverage: number;
    classMaxAverage: number;
    classHeadcount: number;
    classDecisionId: string | null;
    lines: Array<{
      subjectId: string | null;
      lineType: 'subject' | 'conduct';
      average: number;
      coefficient: number;
      rank: number | null;
    }>;
  }): Promise<string> {
    return this.db.transaction(async (tx) => {
      const txDb = tx as TenantDb;

      const existing = await txDb.execute<{ id: string; status: string }>(sql`
        SELECT id::text, status::text FROM report_cards
        WHERE student_id = ${input.studentId}::uuid AND grading_period_id = ${input.gradingPeriodId}::uuid
        FOR UPDATE
        LIMIT 1
      `);
      const existingRow = getRows<{ id: string; status: string }>(existing)[0];

      let cardId: string;
      if (existingRow) {
        if (existingRow.status === 'published') {
          const conflict = new Error('Ce bulletin est déjà publié et ne peut plus être régénéré') as Error & {
            statusCode?: number;
            code?: string;
          };
          conflict.statusCode = 409;
          conflict.code = 'REPORT_CARD_ALREADY_PUBLISHED';
          throw conflict;
        }
        // Snapshot : on repart de zéro (les lignes partent en cascade).
        await txDb.execute(sql`DELETE FROM report_cards WHERE id = ${existingRow.id}::uuid`);
        cardId = existingRow.id;
      } else {
        cardId = crypto.randomUUID();
      }

      const inserted = await txDb.execute(sql`
        INSERT INTO report_cards (
          id, student_id, class_id, grading_period_id,
          general_average, rank, class_average, class_min_average, class_max_average,
          class_headcount, class_decision_id, status, generated_at, created_at, updated_at
        ) SELECT
          ${cardId}::uuid, ${input.studentId}::uuid, ${input.classId}::uuid, ${input.gradingPeriodId}::uuid,
          ${input.generalAverage}, ${input.rank}, ${input.classAverage}, ${input.classMinAverage},
          ${input.classMaxAverage}, ${input.classHeadcount}, ${input.classDecisionId ?? null}::uuid,
          'generated', NOW(), NOW(), NOW()
        FROM classes c JOIN grading_periods gp ON gp.id = ${input.gradingPeriodId}::uuid
        WHERE c.id = ${input.classId}::uuid AND c.school_year_id = gp.school_year_id
          AND ${confirmedSchoolStudent(sql`${input.studentId}::uuid`, sql`c.school_year_id`, sql`c.id`)}
        RETURNING id
      `);
      if (getRows(inserted).length !== 1) {
        const conflict = new Error('Inscription confirmée requise pour générer le bulletin') as Error & {
          statusCode?: number;
          code?: string;
        };
        conflict.statusCode = 409;
        conflict.code = 'CONFIRMED_ENROLLMENT_REQUIRED';
        throw conflict;
      }

      for (const line of input.lines) {
        await txDb.execute(sql`
          INSERT INTO report_card_lines (
            report_card_id, subject_id, line_type, subject_average, subject_coefficient, subject_rank
          ) VALUES (
            ${cardId}::uuid, ${line.subjectId ?? null}::uuid, ${line.lineType}, ${line.average},
            ${line.coefficient}, ${line.rank}
          )
        `);
      }

      return cardId;
    });
  }

  async publishCard(cardId: string, userId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
    const txDb = tx as TenantDb;
    const result = await txDb.execute(sql`
      UPDATE report_cards
      SET status = 'published', published_at = NOW(), published_by_user_id = ${userId}::uuid, updated_at = NOW()
      WHERE id = ${cardId}::uuid AND status = 'generated'
        AND EXISTS (SELECT 1 FROM classes c JOIN grading_periods gp ON gp.id = report_cards.grading_period_id
          WHERE c.id = report_cards.class_id AND c.school_year_id = gp.school_year_id
            AND ${confirmedSchoolStudent(sql`report_cards.student_id`, sql`c.school_year_id`, sql`c.id`)})
      RETURNING id::text
    `);
    if (getRows(result).length === 0) {
      const conflict = new Error('Ce bulletin est introuvable ou déjà publié') as Error & {
        statusCode?: number;
        code?: string;
      };
      conflict.statusCode = 409;
      conflict.code = 'REPORT_CARD_NOT_PUBLISHABLE';
      throw conflict;
    }
    await txDb.execute(sql`
      INSERT INTO report_card_versions (card_id, student_id, class_id, grading_period_id,
        revision, snapshot, published_at, published_by_user_id)
      SELECT rc.id, rc.student_id, rc.class_id, rc.grading_period_id,
        COALESCE((SELECT max(v.revision) FROM report_card_versions v
          WHERE v.student_id = rc.student_id AND v.grading_period_id = rc.grading_period_id), 0) + 1,
        jsonb_build_object('card', to_jsonb(rc), 'lines', COALESCE(
          (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.created_at) FROM report_card_lines l WHERE l.report_card_id = rc.id), '[]'::jsonb)),
        rc.published_at, rc.published_by_user_id
      FROM report_cards rc WHERE rc.id = ${cardId}::uuid
    `);
    });
  }

  async listPublishableCardsOfClass(classId: string, gradingPeriodId: string): Promise<string[]> {
    const result = await this.db.execute<{ id: string }>(sql`
      SELECT rc.id::text FROM report_cards rc
      INNER JOIN classes c ON c.id = rc.class_id
      INNER JOIN grading_periods gp ON gp.id = rc.grading_period_id AND gp.school_year_id = c.school_year_id
      WHERE rc.class_id = ${classId}::uuid AND rc.grading_period_id = ${gradingPeriodId}::uuid AND rc.status = 'generated'
        AND ${confirmedSchoolStudent(sql`rc.student_id`, sql`c.school_year_id`, sql`c.id`)}
    `);
    return getRows<{ id: string }>(result).map((row) => row.id);
  }

  async listCardsOfClass(classId: string, gradingPeriodId: string): Promise<
    Array<{ id: string; studentName: string; generalAverage: number; rank: number; status: 'generated' | 'published' }>
  > {
    const result = await this.db.execute<{
      id: string;
      student_name: string;
      general_average: string;
      rank: number;
      status: string;
    }>(sql`
      SELECT rc.id::text,
             concat_ws(' ', s.first_name, s.last_name) AS student_name,
             rc.general_average::text, rc.rank, rc.status::text
      FROM report_cards rc
      INNER JOIN students s ON s.id = rc.student_id
      INNER JOIN classes c ON c.id = rc.class_id
      INNER JOIN grading_periods gp ON gp.id = rc.grading_period_id AND gp.school_year_id = c.school_year_id
      WHERE rc.class_id = ${classId}::uuid AND rc.grading_period_id = ${gradingPeriodId}::uuid
        AND EXISTS (SELECT 1 FROM enrollments e
          WHERE e.student_id = rc.student_id AND e.class_id = rc.class_id
            AND e.school_year_id = c.school_year_id AND e.status = 'confirmed')
      ORDER BY rc.rank ASC
    `);
    return getRows<{
      id: string;
      student_name: string;
      general_average: string;
      rank: number;
      status: string;
    }>(result).map((row) => ({
      id: row.id,
      studentName: row.student_name,
      generalAverage: Number(row.general_average),
      rank: row.rank,
      status: row.status as 'generated' | 'published',
    }));
  }

  async listClassReadiness(gradingPeriodId: string, schoolYearId: string) {
    const result = await this.db.execute<{
      class_id: string;
      class_name: string;
      headcount: number;
      with_general: number;
      with_conduct: number;
    }>(sql`
      SELECT c.id::text AS class_id, c.name AS class_name,
             COUNT(DISTINCT s.id)::int AS headcount,
             COUNT(DISTINCT spa.student_id)::int AS with_general
             ,COUNT(DISTINCT cg.student_id)::int AS with_conduct
      FROM classes c
      LEFT JOIN students s ON ${confirmedSchoolStudent(sql`s.id`, sql`c.school_year_id`, sql`c.id`)}
      LEFT JOIN student_period_averages spa
        ON spa.student_id = s.id AND spa.grading_period_id = ${gradingPeriodId}::uuid AND spa.subject_id IS NULL
      LEFT JOIN conduct_grades cg ON cg.student_id = s.id AND cg.grading_period_id = ${gradingPeriodId}::uuid
      WHERE c.school_year_id = ${schoolYearId}::uuid AND c.is_active = true
      GROUP BY c.id, c.name
      ORDER BY c.name ASC
    `);
    return getRows<{
      class_id: string;
      class_name: string;
      headcount: number;
      with_general: number;
      with_conduct: number;
    }>(result);
  }

  async upsertGeneralAverage(studentId: string, gradingPeriodId: string, average: number, rank: number): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO student_period_averages (student_id, subject_id, grading_period_id, average, rank, computed_at)
      VALUES (${studentId}::uuid, NULL, ${gradingPeriodId}::uuid, ${average}, ${rank}, now())
      ON CONFLICT (student_id, grading_period_id) WHERE subject_id IS NULL
      DO UPDATE SET average = EXCLUDED.average, rank = EXCLUDED.rank, computed_at = now()
    `);
  }

  async listConductAmbiguities(): Promise<Array<{ gradingPeriodId: string; periodLabel: string; generatedCount: number; publishedCount: number }>> {
    const result = await this.db.execute<{
      grading_period_id: string; period_label: string; generated_count: number; published_count: number;
    }>(sql`
      WITH cards AS (
        SELECT rc.id, rc.grading_period_id, rc.status,
          cg.id IS NULL AS no_grade,
          COALESCE(lines.conduct_count, 0) <> 1 AS invalid_line,
          lines.computed_average IS NULL OR ABS(lines.computed_average - rc.general_average) > 0.002 AS invalid_average
        FROM report_cards rc
        LEFT JOIN conduct_grades cg ON cg.student_id = rc.student_id AND cg.grading_period_id = rc.grading_period_id
        LEFT JOIN LATERAL (
          SELECT COUNT(*) FILTER (WHERE line_type = 'conduct')::int AS conduct_count,
            SUM(subject_average * subject_coefficient) / NULLIF(SUM(subject_coefficient), 0) AS computed_average
          FROM report_card_lines WHERE report_card_id = rc.id
        ) lines ON true
      )
      SELECT gp.id::text AS grading_period_id, gp.label AS period_label,
        COUNT(*) FILTER (WHERE cards.status = 'generated')::int AS generated_count,
        COUNT(*) FILTER (WHERE cards.status = 'published')::int AS published_count
      FROM cards INNER JOIN grading_periods gp ON gp.id = cards.grading_period_id
      WHERE cards.no_grade OR cards.invalid_line OR cards.invalid_average
      GROUP BY gp.id, gp.label ORDER BY gp.start_date
    `);
    return getRows<{
      grading_period_id: string; period_label: string; generated_count: number; published_count: number;
    }>(result).map(row => ({ gradingPeriodId: row.grading_period_id, periodLabel: row.period_label,
      generatedCount: row.generated_count, publishedCount: row.published_count }));
  }

  async listCompletionForYear(schoolYearId: string) {
    const result = await this.db.execute<{
      class_id: string;
      subject_id: string;
      completed_count: number;
    }>(sql`
      SELECT csc.class_id::text, csc.subject_id::text,
             COUNT(*) FILTER (WHERE csc.status = 'completed')::int AS completed_count
      FROM class_subject_completion csc
      INNER JOIN grading_periods gp ON gp.id = csc.grading_period_id
      WHERE gp.school_year_id = ${schoolYearId}::uuid
      GROUP BY csc.class_id, csc.subject_id
    `);
    return getRows<{ class_id: string; subject_id: string; completed_count: number }>(result);
  }

  async listPublishedSummariesForStudent(studentId: string): Promise<
    Array<{
      id: string;
      periodLabel: string;
      schoolYearId: string;
      schoolYearLabel: string;
      className: string;
      generalAverage: number;
      rank: number;
      classHeadcount: number;
      publishedAt: string;
    }>
  > {
    const result = await this.db.execute<{
      id: string;
      period_label: string;
      school_year_id: string;
      school_year_label: string;
      class_name: string;
      general_average: string;
      rank: number;
      class_headcount: number;
      published_at: string;
    }>(sql`
      SELECT rc.id::text, gp.label AS period_label, sy.id::text AS school_year_id,
             sy.label AS school_year_label, c.name AS class_name,
             rc.general_average::text, rc.rank, rc.class_headcount, rc.published_at::text
      FROM report_cards rc
      INNER JOIN grading_periods gp ON gp.id = rc.grading_period_id
      INNER JOIN school_years sy ON sy.id = gp.school_year_id
      INNER JOIN classes c ON c.id = rc.class_id AND c.school_year_id = sy.id
      WHERE rc.student_id = ${studentId}::uuid AND rc.status = 'published'
        AND EXISTS (
          SELECT 1 FROM enrollments e
          WHERE e.student_id = rc.student_id AND e.class_id = rc.class_id
            AND e.school_year_id = sy.id AND e.status = 'confirmed'
        )
      ORDER BY gp.start_date DESC
    `);
    return getRows<{
      id: string;
      period_label: string;
      school_year_id: string;
      school_year_label: string;
      class_name: string;
      general_average: string;
      rank: number;
      class_headcount: number;
      published_at: string;
    }>(result).map((row) => ({
      id: row.id,
      periodLabel: row.period_label,
      schoolYearId: row.school_year_id,
      schoolYearLabel: row.school_year_label,
      className: row.class_name,
      generalAverage: Number(row.general_average),
      rank: row.rank,
      classHeadcount: row.class_headcount,
      publishedAt: row.published_at,
    }));
  }

  async findCardDetail(cardId: string) {
    const result = await this.db.execute<{
      id: string;
      student_id: string;
      student_name: string;
      class_id: string;
      class_name: string;
      grading_period_id: string;
      period_label: string;
      school_year_label: string;
      general_average: string;
      rank: number;
      class_average: string;
      class_min_average: string;
      class_max_average: string;
      class_headcount: number;
      status: string;
      generated_at: string;
      published_at: string | null;
      decision: string | null;
    }>(sql`
      SELECT rc.id::text, rc.student_id::text,
             concat_ws(' ', s.first_name, s.last_name) AS student_name,
             rc.class_id::text, c.name AS class_name,
             rc.grading_period_id::text, gp.label AS period_label, sy.label AS school_year_label,
             rc.general_average::text, rc.rank,
             rc.class_average::text, rc.class_min_average::text, rc.class_max_average::text,
             rc.class_headcount, rc.status::text, rc.generated_at::text, rc.published_at::text,
             cd.final_decision::text AS decision
      FROM report_cards rc
      INNER JOIN students s ON s.id = rc.student_id
      INNER JOIN classes c ON c.id = rc.class_id
      INNER JOIN grading_periods gp ON gp.id = rc.grading_period_id
      INNER JOIN school_years sy ON sy.id = gp.school_year_id
      LEFT JOIN class_decisions cd ON cd.id = rc.class_decision_id
      WHERE rc.id = ${cardId}::uuid
        AND gp.school_year_id = c.school_year_id
        AND EXISTS (
          SELECT 1 FROM enrollments e
          WHERE e.student_id = rc.student_id AND e.class_id = rc.class_id
            AND e.school_year_id = gp.school_year_id AND e.status = 'confirmed'
        )
      LIMIT 1
    `);
    const rows = getRows<{
      id: string;
      student_id: string;
      student_name: string;
      class_id: string;
      class_name: string;
      grading_period_id: string;
      period_label: string;
      school_year_label: string;
      general_average: string;
      rank: number;
      class_average: string;
      class_min_average: string;
      class_max_average: string;
      class_headcount: number;
      status: string;
      generated_at: string;
      published_at: string | null;
      decision: string | null;
    }>(result);
    return rows[0] ?? null;
  }

  async listCardLines(cardId: string) {
    const result = await this.db.execute<{
      id: string;
      subject_id: string | null;
      subject_name: string | null;
      line_type: string;
      subject_average: string;
      subject_coefficient: string;
      subject_rank: number | null;
    }>(sql`
      SELECT rcl.id::text, rcl.subject_id::text, sub.name AS subject_name,
             rcl.line_type::text, rcl.subject_average::text, rcl.subject_coefficient::text,
             rcl.subject_rank
      FROM report_card_lines rcl
      LEFT JOIN subjects sub ON sub.id = rcl.subject_id
      WHERE rcl.report_card_id = ${cardId}::uuid
      ORDER BY CASE WHEN rcl.line_type = 'conduct' THEN 1 ELSE 0 END, COALESCE(sub.name, '')
    `);
    return getRows<{
      id: string;
      subject_id: string | null;
      subject_name: string | null;
      line_type: string;
      subject_average: string;
      subject_coefficient: string;
      subject_rank: number | null;
    }>(result);
  }
}
