import { sql } from 'drizzle-orm';

import type { TenantDb } from '../../shared/database/db.js';

type Rows<T> = { rows?: T[] };

const getRows = <T>(result: unknown): T[] => {
  if (typeof result !== 'object' || result === null || !('rows' in result)) {
    return [];
  }
  const rows = (result as Rows<T>).rows;
  return Array.isArray(rows) ? rows : [];
};

export class ReportCardsRepository {
  constructor(readonly db: TenantDb) {}

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

  async listClassStudents(classId: string): Promise<Array<{ id: string; fullName: string }>> {
    const result = await this.db.execute<{ id: string; full_name: string }>(sql`
      SELECT s.id::text, concat_ws(' ', s.first_name, s.last_name) AS full_name
      FROM students s
      WHERE s.class_id = ${classId}::uuid AND s.is_active = true
      ORDER BY s.last_name ASC, s.first_name ASC
    `);
    return getRows<{ id: string; full_name: string }>(result).map((row) => ({
      id: row.id,
      fullName: row.full_name,
    }));
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
      WHERE s.class_id = ${classId}::uuid
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
      WHERE s.class_id = ${classId}::uuid
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
      SELECT note::text, coefficient::text
      FROM conduct_grades
      WHERE student_id = ${studentId}::uuid AND grading_period_id = ${gradingPeriodId}::uuid
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

      await txDb.execute(sql`
        INSERT INTO report_cards (
          id, student_id, class_id, grading_period_id,
          general_average, rank, class_average, class_min_average, class_max_average,
          class_headcount, class_decision_id, status, generated_at, created_at, updated_at
        ) VALUES (
          ${cardId}::uuid, ${input.studentId}::uuid, ${input.classId}::uuid, ${input.gradingPeriodId}::uuid,
          ${input.generalAverage}, ${input.rank}, ${input.classAverage}, ${input.classMinAverage},
          ${input.classMaxAverage}, ${input.classHeadcount}, ${input.classDecisionId ?? null}::uuid,
          'generated', NOW(), NOW(), NOW()
        )
      `);

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
    const result = await this.db.execute(sql`
      UPDATE report_cards
      SET status = 'published', published_at = NOW(), published_by_user_id = ${userId}::uuid, updated_at = NOW()
      WHERE id = ${cardId}::uuid AND status = 'generated'
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
  }

  async listPublishableCardsOfClass(classId: string, gradingPeriodId: string): Promise<string[]> {
    const result = await this.db.execute<{ id: string }>(sql`
      SELECT id::text FROM report_cards
      WHERE class_id = ${classId}::uuid AND grading_period_id = ${gradingPeriodId}::uuid AND status = 'generated'
    `);
    return getRows<{ id: string }>(result).map((row) => row.id);
  }

  async listClassReadiness(gradingPeriodId: string, schoolYearId: string) {
    const result = await this.db.execute<{
      class_id: string;
      class_name: string;
      headcount: number;
      with_general: number;
    }>(sql`
      SELECT c.id::text AS class_id, c.name AS class_name,
             COUNT(DISTINCT s.id)::int AS headcount,
             COUNT(DISTINCT spa.student_id)::int AS with_general
      FROM classes c
      LEFT JOIN students s ON s.class_id = c.id AND s.is_active = true
      LEFT JOIN student_period_averages spa
        ON spa.student_id = s.id AND spa.grading_period_id = ${gradingPeriodId}::uuid AND spa.subject_id IS NULL
      WHERE c.school_year_id = ${schoolYearId}::uuid AND c.is_active = true
      GROUP BY c.id, c.name
      ORDER BY c.name ASC
    `);
    return getRows<{
      class_id: string;
      class_name: string;
      headcount: number;
      with_general: number;
    }>(result);
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
      schoolYearLabel: string;
      generalAverage: number;
      rank: number;
      classHeadcount: number;
      publishedAt: string;
    }>
  > {
    const result = await this.db.execute<{
      id: string;
      period_label: string;
      school_year_label: string;
      general_average: string;
      rank: number;
      class_headcount: number;
      published_at: string;
    }>(sql`
      SELECT rc.id::text, gp.label AS period_label, sy.label AS school_year_label,
             rc.general_average::text, rc.rank, rc.class_headcount, rc.published_at::text
      FROM report_cards rc
      INNER JOIN grading_periods gp ON gp.id = rc.grading_period_id
      INNER JOIN school_years sy ON sy.id = gp.school_year_id
      WHERE rc.student_id = ${studentId}::uuid AND rc.status = 'published'
      ORDER BY gp.start_date DESC
    `);
    return getRows<{
      id: string;
      period_label: string;
      school_year_label: string;
      general_average: string;
      rank: number;
      class_headcount: number;
      published_at: string;
    }>(result).map((row) => ({
      id: row.id,
      periodLabel: row.period_label,
      schoolYearLabel: row.school_year_label,
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
             rc.grading_period_id::text, gp.label AS period_label,
             rc.general_average::text, rc.rank,
             rc.class_average::text, rc.class_min_average::text, rc.class_max_average::text,
             rc.class_headcount, rc.status::text, rc.generated_at::text, rc.published_at::text,
             cd.final_decision::text AS decision
      FROM report_cards rc
      INNER JOIN students s ON s.id = rc.student_id
      INNER JOIN classes c ON c.id = rc.class_id
      INNER JOIN grading_periods gp ON gp.id = rc.grading_period_id
      LEFT JOIN class_decisions cd ON cd.id = rc.class_decision_id
      WHERE rc.id = ${cardId}::uuid
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
