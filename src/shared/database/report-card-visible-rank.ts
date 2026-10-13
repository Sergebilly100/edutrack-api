import { sql } from 'drizzle-orm';

/** Rang dense lu depuis les moyennes figées, avec la précision montrée sur le bulletin. Alias externe : rc. */
export const visibleReportCardRank = sql<number>`(
  SELECT COUNT(DISTINCT ROUND(peer.general_average, 2))::int + 1
  FROM report_cards peer
  WHERE peer.class_id = rc.class_id
    AND peer.grading_period_id = rc.grading_period_id
    AND ROUND(peer.general_average, 2) > ROUND(rc.general_average, 2)
    AND EXISTS (
      SELECT 1 FROM enrollments e
      INNER JOIN classes peer_class ON peer_class.id = peer.class_id
      WHERE e.student_id = peer.student_id AND e.class_id = peer.class_id
        AND e.school_year_id = peer_class.school_year_id AND e.status = 'confirmed'
    )
)`;

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
