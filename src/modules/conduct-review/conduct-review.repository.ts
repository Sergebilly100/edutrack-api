import { sql } from 'drizzle-orm';
import type { TenantDb } from '../../shared/database/db.js';
import { confirmedSchoolStudent } from '../../shared/database/confirmed-school-membership.js';
import { authorizedConductClass } from '../../shared/database/conduct-decision-scope.js';
import { teacherClassRelation } from '../../shared/database/teacher-class-relation.js';
import { BUSINESS_DATE_SQL } from '../../shared/database/business-date.js';

type QueryResult<T> = { rows?: T[] };
const rows = <T>(result: unknown): T[] => {
  if (!result || typeof result !== 'object' || !('rows' in result)) return [];
  return (result as QueryResult<T>).rows ?? [];
};

type TeacherActionRow = { class_id: string; class_name: string; grading_period_id: string; grading_period_label: string; end_date: string; pending_count: number };
type DecisionScopeRow = { class_id: string; class_name: string; level_id: string; level_name: string;
  school_year_id: string; school_year_label: string; school_year_status: 'draft' | 'active' | 'closed'; grading_period_id: string; grading_period_label: string;
  review_open: boolean; is_closed: boolean; student_count: number; pending_count: number };

export type ReviewAction = {
  classId: string;
  className: string;
  gradingPeriodId: string;
  gradingPeriodLabel: string;
  endDate: string;
  pendingCount: number;
};

export type DecisionScope = Omit<ReviewAction, 'endDate'> & {
  levelId: string;
  levelName: string;
  schoolYearId: string;
  schoolYearLabel: string;
  schoolYearStatus: 'draft' | 'active' | 'closed';
  studentCount: number;
  reviewOpen: boolean;
  isClosed: boolean;
};

export class ConductReviewRepository {
  constructor(private readonly db: TenantDb) {}

  async listTeacherOpenScopes(userId: string): Promise<ReviewAction[]> {
    const result = await this.db.execute<TeacherActionRow>(sql`
      SELECT c.id::text AS class_id, c.name AS class_name,
             gp.id::text AS grading_period_id, gp.label AS grading_period_label, gp.end_date::text,
             COUNT(DISTINCT s.id) FILTER (WHERE tci.id IS NULL AND cg.id IS NULL)::int AS pending_count
      FROM teachers t
      INNER JOIN classes c ON c.is_active = true AND ${teacherClassRelation(sql`t.id`, sql`c.id`)}
      INNER JOIN grading_periods gp ON gp.school_year_id = c.school_year_id
        AND gp.review_start_date <= ${BUSINESS_DATE_SQL} AND ${BUSINESS_DATE_SQL} <= gp.end_date
      INNER JOIN school_years sy ON sy.id = gp.school_year_id AND sy.status = 'active'
      LEFT JOIN enrollments e ON e.class_id = c.id AND e.school_year_id = c.school_year_id
        AND e.status = 'confirmed'
      LEFT JOIN students s ON s.id = e.student_id AND ${confirmedSchoolStudent(sql`s.id`, sql`c.school_year_id`, sql`c.id`)}
      LEFT JOIN teacher_conduct_inputs tci ON tci.student_id = s.id AND tci.teacher_id = t.id
        AND tci.grading_period_id = gp.id
      LEFT JOIN conduct_grades cg ON cg.student_id = s.id AND cg.grading_period_id = gp.id
      WHERE t.user_id = ${userId}::uuid
        AND NOT EXISTS (SELECT 1 FROM grading_period_class_closures closure
          WHERE closure.class_id = c.id AND closure.grading_period_id = gp.id)
        AND NOT EXISTS (SELECT 1 FROM report_cards rc
          WHERE rc.class_id = c.id AND rc.grading_period_id = gp.id)
      GROUP BY c.id, c.name, gp.id, gp.label, gp.end_date
      HAVING COUNT(DISTINCT s.id) > 0
      ORDER BY gp.review_start_date, c.name
    `);
    return rows<TeacherActionRow>(result).map((row) => ({
      classId: row.class_id, className: row.class_name,
      gradingPeriodId: row.grading_period_id, gradingPeriodLabel: row.grading_period_label,
      endDate: row.end_date,
      pendingCount: row.pending_count,
    }));
  }

  async listDecisionScopes(userId: string, canFinalize: boolean): Promise<DecisionScope[]> {
    const result = await this.db.execute<DecisionScopeRow>(sql`
      SELECT c.id::text AS class_id, c.name AS class_name, l.id::text AS level_id,
             l.name AS level_name, sy.id::text AS school_year_id,
             sy.label AS school_year_label, sy.status AS school_year_status, gp.id::text AS grading_period_id,
             gp.label AS grading_period_label,
             sy.status = 'active' AND gp.review_start_date <= ${BUSINESS_DATE_SQL}
               AND ${BUSINESS_DATE_SQL} <= gp.end_date AS review_open,
             EXISTS (SELECT 1 FROM grading_period_class_closures closure
               WHERE closure.class_id = c.id AND closure.grading_period_id = gp.id)
               OR EXISTS (SELECT 1 FROM report_cards rc
                 WHERE rc.class_id = c.id AND rc.grading_period_id = gp.id) AS is_closed,
             COUNT(DISTINCT s.id)::int AS student_count,
             COUNT(DISTINCT s.id) FILTER (WHERE cg.id IS NULL)::int AS pending_count
      FROM classes c
      INNER JOIN school_years sy ON sy.id = c.school_year_id
      INNER JOIN levels l ON l.id = c.level_id
      INNER JOIN grading_periods gp ON gp.school_year_id = sy.id
      LEFT JOIN enrollments e ON e.class_id = c.id AND e.school_year_id = sy.id AND e.status = 'confirmed'
      LEFT JOIN students s ON s.id = e.student_id AND ${confirmedSchoolStudent(sql`s.id`, sql`sy.id`, sql`c.id`)}
      LEFT JOIN conduct_grades cg ON cg.student_id = s.id AND cg.grading_period_id = gp.id
      WHERE ${authorizedConductClass(userId, canFinalize)}
      GROUP BY c.id, c.name, l.id, l.name, sy.id, sy.label, sy.status, gp.id, gp.label
      ORDER BY sy.label DESC, l.name, c.name, gp.order_index
    `);
    return rows<DecisionScopeRow>(result).map((row) => ({
      classId: row.class_id, className: row.class_name,
      levelId: row.level_id, levelName: row.level_name,
      schoolYearId: row.school_year_id, schoolYearLabel: row.school_year_label, schoolYearStatus: row.school_year_status,
      gradingPeriodId: row.grading_period_id, gradingPeriodLabel: row.grading_period_label,
      reviewOpen: row.review_open, isClosed: row.is_closed,
      studentCount: row.student_count, pendingCount: row.pending_count,
    }));
  }

}
