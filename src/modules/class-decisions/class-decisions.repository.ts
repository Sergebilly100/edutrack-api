import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { QueryResult, QueryResultRow } from 'pg';

import type {
  ClassDecisionItem,
  ClassDecisionValue,
  EndOfYearSchoolYear,
  LevelOption,
} from './class-decisions.types.js';

type ClassDecisionQueryExecutor = NodePgDatabase<Record<string, unknown>>;

type SchoolYearRow = {
  id: string;
  label: string;
  end_date: string;
  end_of_year_review_start_date: string;
};

type DecisionRow = {
  student_id: string;
  student_first_name: string;
  student_last_name: string;
  student_matricule: string | null;
  class_name: string;
  current_level_name: string;
  suggested_decision: ClassDecisionValue | null;
  final_decision: ClassDecisionValue | null;
  next_level_id: string | null;
  next_level_name: string | null;
  validated_at: Date | string | null;
};

type LevelRow = { id: string; name: string; order_index: number };

const getRows = <TRow extends QueryResultRow>(result: QueryResult<TRow>): TRow[] => result.rows;

const mapSchoolYear = (row: SchoolYearRow): EndOfYearSchoolYear => ({
  id: row.id,
  label: row.label,
  endDate: row.end_date,
  endOfYearReviewStartDate: row.end_of_year_review_start_date,
});

const mapDecision = (row: DecisionRow): ClassDecisionItem => ({
  studentId: row.student_id,
  studentFirstName: row.student_first_name,
  studentLastName: row.student_last_name,
  studentMatricule: row.student_matricule,
  className: row.class_name,
  currentLevelName: row.current_level_name,
  suggestedDecision: row.suggested_decision,
  finalDecision: row.final_decision,
  nextLevelId: row.next_level_id,
  nextLevelName: row.next_level_name,
  validatedAt: row.validated_at ? new Date(row.validated_at).toISOString() : null,
});

export class ClassDecisionsRepository {
  constructor(private readonly db: ClassDecisionQueryExecutor) {}

  async getActiveSchoolYear(): Promise<EndOfYearSchoolYear | null> {
    const result = await this.db.execute<SchoolYearRow>(sql`
      SELECT id, label, end_date::text, end_of_year_review_start_date::text
      FROM school_years
      WHERE status = 'active'
      LIMIT 1
    `);
    const row = getRows(result)[0];
    return row ? mapSchoolYear(row) : null;
  }

  async listForSchoolYear(schoolYearId: string): Promise<ClassDecisionItem[]> {
    const result = await this.db.execute<DecisionRow>(sql`
      SELECT
        s.id AS student_id,
        s.first_name AS student_first_name,
        s.last_name AS student_last_name,
        s.matricule AS student_matricule,
        c.name AS class_name,
        current_level.name AS current_level_name,
        cd.suggested_decision,
        cd.final_decision,
        cd.next_level_id,
        next_level.name AS next_level_name,
        cd.validated_at
      FROM students s
      INNER JOIN classes c ON c.id = s.class_id
      INNER JOIN levels current_level ON current_level.id = c.level_id
      LEFT JOIN class_decisions cd
        ON cd.student_id = s.id
       AND cd.school_year_id = c.school_year_id
      LEFT JOIN levels next_level ON next_level.id = cd.next_level_id
      WHERE s.is_active = true
        AND c.is_active = true
        AND c.school_year_id = ${schoolYearId}::uuid
      ORDER BY c.name ASC, s.last_name ASC, s.first_name ASC
    `);
    return getRows(result).map(mapDecision);
  }

  async listLevels(): Promise<LevelOption[]> {
    const result = await this.db.execute<LevelRow>(sql`
      SELECT id, name, order_index
      FROM levels
      ORDER BY order_index ASC, name ASC
    `);
    return getRows(result).map((row) => ({ id: row.id, name: row.name, orderIndex: row.order_index }));
  }

  async levelExists(levelId: string): Promise<boolean> {
    const result = await this.db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM levels WHERE id = ${levelId}::uuid) AS exists
    `);
    return getRows(result)[0]?.exists ?? false;
  }

  async validateDecision(input: {
    studentId: string;
    schoolYearId: string;
    finalDecision: ClassDecisionValue;
    nextLevelId: string | null;
    validatedByUserId: string;
  }): Promise<ClassDecisionItem | null> {
    const result = await this.db.execute<DecisionRow>(sql`
      WITH eligible_student AS (
        SELECT s.id
        FROM students s
        INNER JOIN classes c ON c.id = s.class_id
        WHERE s.id = ${input.studentId}::uuid
          AND s.is_active = true
          AND c.is_active = true
          AND c.school_year_id = ${input.schoolYearId}::uuid
      ), upserted AS (
        INSERT INTO class_decisions (
          student_id,
          school_year_id,
          final_decision,
          next_level_id,
          validated_by_user_id,
          validated_at,
          updated_at
        )
        SELECT
          id,
          ${input.schoolYearId}::uuid,
          ${input.finalDecision}::class_decision_type,
          ${input.nextLevelId}::uuid,
          ${input.validatedByUserId}::uuid,
          now(),
          now()
        FROM eligible_student
        ON CONFLICT (student_id, school_year_id) DO UPDATE SET
          final_decision = EXCLUDED.final_decision,
          next_level_id = EXCLUDED.next_level_id,
          validated_by_user_id = EXCLUDED.validated_by_user_id,
          validated_at = EXCLUDED.validated_at,
          updated_at = now()
        RETURNING *
      )
      SELECT
        s.id AS student_id,
        s.first_name AS student_first_name,
        s.last_name AS student_last_name,
        s.matricule AS student_matricule,
        c.name AS class_name,
        current_level.name AS current_level_name,
        cd.suggested_decision,
        cd.final_decision,
        cd.next_level_id,
        next_level.name AS next_level_name,
        cd.validated_at
      FROM upserted cd
      INNER JOIN students s ON s.id = cd.student_id
      INNER JOIN classes c ON c.id = s.class_id
      INNER JOIN levels current_level ON current_level.id = c.level_id
      LEFT JOIN levels next_level ON next_level.id = cd.next_level_id
    `);
    const row = getRows(result)[0];
    return row ? mapDecision(row) : null;
  }
}
