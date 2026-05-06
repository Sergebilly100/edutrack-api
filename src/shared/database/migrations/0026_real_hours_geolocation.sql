ALTER TABLE "tenant"."attendances_teacher"
  ADD COLUMN IF NOT EXISTS "checked_out_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "actual_minutes" integer,
  ADD COLUMN IF NOT EXISTS "checkin_latitude" numeric(10,7),
  ADD COLUMN IF NOT EXISTS "checkin_longitude" numeric(10,7),
  ADD COLUMN IF NOT EXISTS "checkin_accuracy" numeric(6,2),
  ADD COLUMN IF NOT EXISTS "checkin_distance" numeric(8,2),
  ADD COLUMN IF NOT EXISTS "geo_status" text DEFAULT 'not_checked',
  ADD COLUMN IF NOT EXISTS "checkout_latitude" numeric(10,7),
  ADD COLUMN IF NOT EXISTS "checkout_longitude" numeric(10,7),
  ADD COLUMN IF NOT EXISTS "checkout_accuracy" numeric(6,2),
  ADD COLUMN IF NOT EXISTS "checkout_geo_status" text DEFAULT 'not_checked';
--> statement-breakpoint
ALTER TABLE "tenant"."rooms"
  ADD COLUMN IF NOT EXISTS "latitude" numeric(10,7),
  ADD COLUMN IF NOT EXISTS "longitude" numeric(10,7),
  ADD COLUMN IF NOT EXISTS "geo_radius" integer DEFAULT 100;
--> statement-breakpoint
ALTER TABLE public.school_sms_features
  ADD COLUMN IF NOT EXISTS use_real_hours boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS geo_check_enabled boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE OR REPLACE VIEW "tenant"."teacher_scan_compliance" AS
SELECT
  t.id AS teacher_id,
  u.name AS teacher_name,
  COUNT(at.id)::int AS total_checkins,
  COUNT(at.checked_out_at)::int AS total_checkouts,
  COALESCE(
    ROUND(COUNT(at.checked_out_at)::numeric / NULLIF(COUNT(at.id), 0) * 100, 1),
    0
  ) AS compliance_rate,
  DATE_TRUNC('month', at.created_at)::date AS month
FROM "tenant"."teachers" t
INNER JOIN "tenant"."users" u ON u.id = t.user_id
LEFT JOIN "tenant"."attendances_teacher" at ON at.teacher_id = t.id
GROUP BY t.id, u.name, DATE_TRUNC('month', at.created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_att_teacher_compliance_teacher_created
  ON "tenant"."attendances_teacher" ("teacher_id", "created_at");
