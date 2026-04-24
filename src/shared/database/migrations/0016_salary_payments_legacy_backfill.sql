WITH explicit_before_cutoff AS (
  SELECT
    sp.salary_record_id,
    COALESCE(SUM(sp.hours_paid), 0)::numeric(8,2) AS paid_hours_before_cutoff
  FROM "tenant"."salary_payments" sp
  INNER JOIN "tenant"."salary_records" sr ON sr.id = sp.salary_record_id
  WHERE sr.paid_at IS NOT NULL
    AND sp.paid_at <= sr.paid_at
  GROUP BY sp.salary_record_id
),
candidates AS (
  SELECT
    sr.id AS salary_record_id,
    sr.hourly_rate,
    sr.paid_at,
    sr.paid_by,
    GREATEST(
      0::numeric,
      sr.hours_done
      - COALESCE(done_after_paid.hours_done_since_paid, 0::numeric)
      - COALESCE(explicit_before_cutoff.paid_hours_before_cutoff, 0::numeric)
    )::numeric(6,2) AS missing_legacy_hours
  FROM "tenant"."salary_records" sr
  INNER JOIN "tenant"."teachers" t ON t.id = sr.teacher_id
  LEFT JOIN explicit_before_cutoff ON explicit_before_cutoff.salary_record_id = sr.id
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(
        SUM(EXTRACT(EPOCH FROM (ts.end_time - ts.start_time)) / 3600.0),
        0
      )::numeric(8,2) AS hours_done_since_paid
    FROM "tenant"."attendances_teacher" at
    INNER JOIN "tenant"."schedules" s ON s.id = at.schedule_id
    INNER JOIN "tenant"."time_slots" ts ON ts.id = s.time_slot_id
    WHERE sr.paid_at IS NOT NULL
      AND at.teacher_id = sr.teacher_id
      AND at.date BETWEEN sr.period_month AND (date_trunc('month', sr.period_month) + interval '1 month - 1 day')::date
      AND at.status IN ('present', 'late', 'excused')
      AND ((at.date::timestamp + ts.end_time)::timestamptz > sr.paid_at)
  ) done_after_paid ON true
  WHERE t.type = 'vacataire'
    AND sr.hourly_rate > 0
    AND sr.paid_at IS NOT NULL
    AND sr.paid_by IS NOT NULL
)
INSERT INTO "tenant"."salary_payments" (
  salary_record_id,
  hours_paid,
  amount_fcfa,
  notes,
  paid_at,
  paid_by
)
SELECT
  c.salary_record_id,
  c.missing_legacy_hours,
  ROUND(c.missing_legacy_hours * c.hourly_rate)::int,
  'Backfill legacy payment inferred from paid_at baseline',
  c.paid_at,
  c.paid_by
FROM candidates c
WHERE c.missing_legacy_hours > 0
  AND NOT EXISTS (
    SELECT 1
    FROM "tenant"."salary_payments" sp
    WHERE sp.salary_record_id = c.salary_record_id
      AND sp.paid_at = c.paid_at
      AND sp.notes = 'Backfill legacy payment inferred from paid_at baseline'
  );
