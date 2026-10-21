import { sql, type SQL } from 'drizzle-orm';
import { confirmedSchoolStudent } from './confirmed-school-membership.js';

type StudentGradeRiskQueryOptions = {
  schoolYearId: SQL;
  gradingPeriodId?: string;
};

export const studentGradeRiskCtes = ({
  schoolYearId,
  gradingPeriodId,
}: StudentGradeRiskQueryOptions): SQL => sql`
  grade_rule AS (
    SELECT
      COALESCE((
        SELECT threshold_value FROM risk_alert_rules
        WHERE subject_type = 'student' AND signal_type = 'grades'
      ), 2::numeric) AS threshold_value,
      COALESCE((
        SELECT is_active FROM risk_alert_rules
        WHERE subject_type = 'student' AND signal_type = 'grades'
      ), true) AS is_active
  ),
  period_class_progress AS (
    SELECT gp.id AS grading_period_id,
           c.id AS class_id,
           COUNT(s.id)::int AS student_count,
           COUNT(rc.id) FILTER (WHERE rc.status IN ('generated', 'published'))::int AS card_count
    FROM grading_periods gp
    INNER JOIN classes c ON c.school_year_id = gp.school_year_id
      AND (c.is_active = true
        OR EXISTS (SELECT 1 FROM report_cards existing WHERE existing.class_id = c.id AND existing.grading_period_id = gp.id)
        OR EXISTS (SELECT 1 FROM grading_period_class_closures closure WHERE closure.class_id = c.id AND closure.grading_period_id = gp.id))
    LEFT JOIN students s ON ${confirmedSchoolStudent(sql`s.id`, sql`c.school_year_id`, sql`c.id`)}
    LEFT JOIN report_cards rc ON rc.student_id = s.id AND rc.class_id = c.id AND rc.grading_period_id = gp.id
    WHERE gp.school_year_id = ${schoolYearId}
    GROUP BY gp.id, c.id
  ),
  completed_periods AS (
    SELECT grading_period_id
    FROM period_class_progress
    GROUP BY grading_period_id
    HAVING COUNT(*) > 0
      AND BOOL_AND(
        EXISTS (
          SELECT 1 FROM grading_period_class_closures closure
          WHERE closure.grading_period_id = period_class_progress.grading_period_id
            AND closure.class_id = period_class_progress.class_id
        )
        OR (student_count > 0 AND card_count >= student_count)
      )
  ),
  requested_period AS (
    SELECT gp.id, gp.order_index
    FROM grading_periods gp
    WHERE gp.school_year_id = ${schoolYearId}
      AND (${gradingPeriodId ?? null}::uuid IS NULL OR gp.id = ${gradingPeriodId ?? null}::uuid)
    ORDER BY gp.order_index DESC
    LIMIT 1
  ),
  selected_period AS (
    SELECT gp.id, gp.order_index
    FROM grading_periods gp
    INNER JOIN completed_periods completed ON completed.grading_period_id = gp.id
    INNER JOIN requested_period requested ON gp.order_index <= requested.order_index
    WHERE gp.school_year_id = ${schoolYearId}
    ORDER BY gp.order_index DESC
    LIMIT 1
  ),
  previous_period AS (
    SELECT gp.id
    FROM grading_periods gp
    INNER JOIN completed_periods completed ON completed.grading_period_id = gp.id
    INNER JOIN selected_period selected ON gp.school_year_id = ${schoolYearId}
      AND gp.order_index < selected.order_index
    ORDER BY gp.order_index DESC
    LIMIT 1
  ),
  student_grade_risks AS (
    SELECT current_average.student_id,
           (grade_rule.is_active AND previous_average.average - current_average.average >= grade_rule.threshold_value) AS grades_signal
    FROM selected_period selected
    CROSS JOIN grade_rule
    INNER JOIN previous_period previous ON true
    INNER JOIN student_period_averages current_average
      ON current_average.grading_period_id = selected.id
     AND current_average.subject_id IS NULL
    INNER JOIN student_period_averages previous_average
      ON previous_average.grading_period_id = previous.id
     AND previous_average.student_id = current_average.student_id
     AND previous_average.subject_id IS NULL
  )
`;
