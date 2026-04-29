ALTER TABLE "public"."school_sms_features"
ADD COLUMN IF NOT EXISTS "sms_unit_price_fcfa" integer;
--> statement-breakpoint

DO $$
BEGIN
  ALTER TYPE "tenant"."notification_status" ADD VALUE IF NOT EXISTS 'skipped_no_active_subscription';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TYPE "tenant"."notification_status" ADD VALUE IF NOT EXISTS 'skipped_feature_disabled';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TYPE "tenant"."notification_status" ADD VALUE IF NOT EXISTS 'skipped_cap_reached';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TYPE "tenant"."notification_status" ADD VALUE IF NOT EXISTS 'skipped_subscription_expired';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TYPE "tenant"."notification_status" ADD VALUE IF NOT EXISTS 'skipped_unknown';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  ALTER TYPE "tenant"."notification_type" ADD VALUE IF NOT EXISTS 'subscription_expiry_alert';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
