DO $$ BEGIN
  CREATE TYPE "tenant"."attendance_validation_status" AS ENUM (
    'not_required',
    'pending',
    'approved',
    'rejected'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TYPE "tenant"."notification_type" ADD VALUE IF NOT EXISTS 'qr_invalid_alert';
ALTER TYPE "tenant"."notification_type" ADD VALUE IF NOT EXISTS 'attendance_rejected';

ALTER TABLE "tenant"."attendances_teacher"
  ADD COLUMN IF NOT EXISTS "validation_status" "tenant"."attendance_validation_status" NOT NULL DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS "validation_reason" text,
  ADD COLUMN IF NOT EXISTS "validated_by" uuid,
  ADD COLUMN IF NOT EXISTS "validated_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "validated_hours" numeric(5,2);

DO $$ BEGIN
  ALTER TABLE "tenant"."attendances_teacher"
    ADD CONSTRAINT "attendances_teacher_validated_by_users_id_fk"
    FOREIGN KEY ("validated_by") REFERENCES "tenant"."users"("id")
    ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "tenant"."notifications_log"
  ADD COLUMN IF NOT EXISTS "recipient_id" uuid,
  ADD COLUMN IF NOT EXISTS "metadata" jsonb;

ALTER TABLE public.school_sms_features
  ADD COLUMN IF NOT EXISTS checkout_tolerance_minutes integer NOT NULL DEFAULT 5;

ALTER TABLE public.school_sms_features
  DROP CONSTRAINT IF EXISTS school_sms_features_checkout_tolerance_range_check;

ALTER TABLE public.school_sms_features
  ADD CONSTRAINT school_sms_features_checkout_tolerance_range_check
  CHECK (checkout_tolerance_minutes >= 0 AND checkout_tolerance_minutes <= 30);

CREATE INDEX IF NOT EXISTS idx_attendances_validation_status
  ON "tenant"."attendances_teacher" (validation_status)
  WHERE validation_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_attendances_geo_status
  ON "tenant"."attendances_teacher" (geo_status)
  WHERE geo_status = 'suspicious';
