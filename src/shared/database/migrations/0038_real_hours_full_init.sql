-- P1-02: Consolidate all DDL previously performed at runtime by ensureTenantRealHoursInfrastructure
-- This migration replaces the runtime DDL calls in attendance/rooms/validations/billing/salaries repositories.
-- It is idempotent: every statement uses IF NOT EXISTS / DO $$ EXCEPTION patterns.

ALTER TABLE public.school_sms_features
  ADD COLUMN IF NOT EXISTS require_end_scan boolean NOT NULL DEFAULT false;
--> statement-breakpoint

ALTER TYPE "tenant"."notification_type" ADD VALUE IF NOT EXISTS 'scan_end_warning';
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "tenant"."end_scan_action_type" AS ENUM ('warned', 'sanctioned');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

ALTER TABLE "tenant"."attendances_teacher"
  ADD COLUMN IF NOT EXISTS "end_scan_action" "tenant"."end_scan_action_type",
  ADD COLUMN IF NOT EXISTS "end_scan_action_reason" text,
  ADD COLUMN IF NOT EXISTS "end_scan_action_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "end_scan_action_by" uuid,
  ADD COLUMN IF NOT EXISTS "end_scan_action_cancelled_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "end_scan_action_cancel_reason" text;
--> statement-breakpoint

ALTER TABLE "tenant"."salary_records"
  ADD COLUMN IF NOT EXISTS "updated_at" timestamptz DEFAULT NOW();
--> statement-breakpoint

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'teacher_scan_compliance'
      AND n.nspname = 'tenant'
      AND c.relkind = 'r'
  ) THEN
    EXECUTE 'DROP TABLE "tenant"."teacher_scan_compliance"';
  ELSIF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'teacher_scan_compliance'
      AND n.nspname = 'tenant'
      AND c.relkind = 'v'
  ) THEN
    EXECUTE 'DROP VIEW "tenant"."teacher_scan_compliance"';
  END IF;
END $$;
--> statement-breakpoint

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
      COUNT(DISTINCT (at.schedule_id, at.date)) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM "tenant"."attendances_student" ast
          WHERE ast.schedule_id = at.schedule_id
            AND ast.date = at.date
        )
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
  ) AS rollcall_rate,
  COALESCE(
    ROUND(
      COUNT(at.id) FILTER (
        WHERE at.status IN ('present', 'late', 'excused')
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
          COUNT(DISTINCT (at.schedule_id, at.date)) FILTER (
            WHERE EXISTS (
              SELECT 1 FROM "tenant"."attendances_student" ast
              WHERE ast.schedule_id = at.schedule_id
                AND ast.date = at.date
            )
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
