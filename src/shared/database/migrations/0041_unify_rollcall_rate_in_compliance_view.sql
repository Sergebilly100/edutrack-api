-- Aligne la définition de la vue tenant.teacher_scan_compliance sur la
-- sémantique utilisée par teachers.repository.ts (getAttendanceStats) :
-- on compte les sessions où le prof était effectivement présent
-- (status IN present/late/excused) ET pour lesquelles au moins un pointage
-- élève existe. Auparavant la vue utilisait at.checked_in_at IS NOT NULL
-- avec COUNT(DISTINCT) ce qui divergeait en cas de pointage partiel.

CREATE OR REPLACE VIEW "tenant"."teacher_scan_compliance" AS
SELECT
  t.id AS teacher_id,
  u.name AS teacher_name,
  COUNT(at.id) FILTER (
    WHERE at.checked_in_at IS NOT NULL
      OR at.room_scan_start_at IS NOT NULL
      OR at.status IN ('present', 'late')
  )::int AS total_checkins,
  COUNT(at.id) FILTER (
    WHERE at.checked_out_at IS NOT NULL
      OR at.room_scan_end_at IS NOT NULL
  )::int AS total_checkouts,
  COALESCE(
    ROUND(
      COUNT(at.id) FILTER (
        WHERE at.checked_out_at IS NOT NULL
          OR at.room_scan_end_at IS NOT NULL
      )::numeric
      / NULLIF(
        COUNT(at.id) FILTER (
          WHERE at.checked_in_at IS NOT NULL
            OR at.room_scan_start_at IS NOT NULL
            OR at.status IN ('present', 'late')
        ),
        0
      ) * 100,
      1
    ),
    0
  ) AS scan_end_rate,
  COALESCE(
    ROUND(
      COUNT(at.id) FILTER (
        WHERE at.room_mismatch = false
          AND at.checked_in_at IS NOT NULL
      )::numeric
      / NULLIF(
        COUNT(at.id) FILTER (
          WHERE at.checked_in_at IS NOT NULL
        ),
        0
      ) * 100,
      1
    ),
    0
  ) AS room_correct_rate,
  COALESCE(
    ROUND(
      COUNT(at.id) FILTER (
        WHERE at.status IN ('present', 'late', 'excused')
          AND EXISTS (
            SELECT 1 FROM "tenant"."attendances_student" ast
            WHERE ast.schedule_id = at.schedule_id
              AND ast.date = at.date
          )
      )::numeric
      / NULLIF(
        COUNT(at.id) FILTER (
          WHERE at.status IN ('present', 'late', 'excused')
        ),
        0
      ) * 100,
      1
    ),
    0
  ) AS rollcall_rate,
  COALESCE(
    ROUND(
      COUNT(at.id) FILTER (
        WHERE at.status IN ('present', 'late')
      )::numeric
      / NULLIF(COUNT(s.id), 0) * 100,
      1
    ),
    0
  ) AS attendance_rate,
  COALESCE(
    ROUND(
      (
        COALESCE(
          COUNT(at.id) FILTER (
            WHERE at.checked_out_at IS NOT NULL
              OR at.room_scan_end_at IS NOT NULL
          )::numeric
          / NULLIF(
            COUNT(at.id) FILTER (
              WHERE at.checked_in_at IS NOT NULL
                OR at.room_scan_start_at IS NOT NULL
                OR at.status IN ('present', 'late')
            ),
            0
          ) * 30,
          0
        ) +
        COALESCE(
          COUNT(at.id) FILTER (
            WHERE at.room_mismatch = false
              AND at.checked_in_at IS NOT NULL
          )::numeric
          / NULLIF(
            COUNT(at.id) FILTER (
              WHERE at.checked_in_at IS NOT NULL
            ),
            0
          ) * 25,
          0
        ) +
        COALESCE(
          COUNT(at.id) FILTER (
            WHERE at.status IN ('present', 'late', 'excused')
              AND EXISTS (
                SELECT 1 FROM "tenant"."attendances_student" ast
                WHERE ast.schedule_id = at.schedule_id
                  AND ast.date = at.date
              )
          )::numeric
          / NULLIF(
            COUNT(at.id) FILTER (
              WHERE at.status IN ('present', 'late', 'excused')
            ),
            0
          ) * 25,
          0
        ) +
        COALESCE(
          COUNT(at.id) FILTER (
            WHERE at.status IN ('present', 'late')
          )::numeric
          / NULLIF(COUNT(s.id), 0) * 20,
          0
        )
      ),
      1
    ),
    0
  ) AS compliance_rate,
  DATE_TRUNC('month', at.date)::date AS month
FROM "tenant"."teachers" t
INNER JOIN "tenant"."users" u ON u.id = t.user_id
LEFT JOIN "tenant"."schedules" s ON s.teacher_id = t.id
LEFT JOIN "tenant"."attendances_teacher" at ON at.teacher_id = t.id
  AND at.schedule_id = s.id
  AND at.date >= DATE_TRUNC('month', CURRENT_DATE)
GROUP BY t.id, u.name, DATE_TRUNC('month', at.date);
