import { sql, type SQL } from 'drizzle-orm';

/** Rang dense sur les moyennes générales actuelles, arrondies comme celles du bulletin. */
export const currentGeneralRank = (studentId: SQL, classId: SQL, gradingPeriodId: SQL) => sql<number | null>`(
  SELECT (
    SELECT COUNT(DISTINCT ROUND(peer_average.average, 2))::int + 1
    FROM student_period_averages peer_average
    WHERE peer_average.grading_period_id = current_average.grading_period_id
      AND peer_average.subject_id IS NULL
      AND ROUND(peer_average.average, 2) > ROUND(current_average.average, 2)
      AND EXISTS (
        SELECT 1
        FROM enrollments peer_enrollment
        INNER JOIN classes peer_class
          ON peer_class.id = peer_enrollment.class_id
         AND peer_class.school_year_id = peer_enrollment.school_year_id
        INNER JOIN grading_periods peer_period
          ON peer_period.id = peer_average.grading_period_id
         AND peer_period.school_year_id = peer_enrollment.school_year_id
        WHERE peer_enrollment.student_id = peer_average.student_id
          AND peer_enrollment.class_id = ${classId}
          AND peer_enrollment.status = 'confirmed'
      )
  )
  FROM student_period_averages current_average
  WHERE current_average.student_id = ${studentId}
    AND current_average.grading_period_id = ${gradingPeriodId}
    AND current_average.subject_id IS NULL
)`;

/** Rang général recalculé à la lecture pour rester identique sur chaque surface. Alias externe : rc. */
export const visibleReportCardRank = currentGeneralRank(
  sql`rc.student_id`,
  sql`rc.class_id`,
  sql`rc.grading_period_id`
);

/** Rang dense d'une matière parmi les lignes figées de la même classe/période. Alias externes : rc, rcl. */
export const visibleReportCardSubjectRank = sql<number | null>`CASE
  WHEN rcl.line_type = 'subject' AND rcl.subject_id IS NOT NULL THEN (
    SELECT COUNT(DISTINCT ROUND(peer_line.subject_average, 2))::int + 1
    FROM report_card_lines peer_line
    INNER JOIN report_cards peer ON peer.id = peer_line.report_card_id
    WHERE peer.class_id = rc.class_id
      AND peer.grading_period_id = rc.grading_period_id
      AND peer_line.subject_id = rcl.subject_id
      AND peer_line.line_type = 'subject'
      AND ROUND(peer_line.subject_average, 2) > ROUND(rcl.subject_average, 2)
      AND EXISTS (
        SELECT 1 FROM enrollments e
        INNER JOIN classes peer_class ON peer_class.id = peer.class_id
        WHERE e.student_id = peer.student_id AND e.class_id = peer.class_id
          AND e.school_year_id = peer_class.school_year_id AND e.status = 'confirmed'
      )
  )
  ELSE NULL
END`;
