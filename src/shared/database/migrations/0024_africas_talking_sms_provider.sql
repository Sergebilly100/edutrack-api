ALTER TABLE "public"."app_settings"
ADD COLUMN IF NOT EXISTS "sms_provider" varchar(50) NOT NULL DEFAULT 'mock';
--> statement-breakpoint
ALTER TABLE "public"."app_settings"
ADD COLUMN IF NOT EXISTS "sms_api_base_url" varchar(255);
--> statement-breakpoint
ALTER TABLE "public"."app_settings"
ADD COLUMN IF NOT EXISTS "sms_api_key" text;
--> statement-breakpoint
ALTER TABLE "public"."app_settings"
ADD COLUMN IF NOT EXISTS "sms_api_key_last4" varchar(4);
--> statement-breakpoint
ALTER TABLE "public"."app_settings"
ADD COLUMN IF NOT EXISTS "sms_api_key_updated_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "public"."app_settings"
ADD COLUMN IF NOT EXISTS "sms_sender_id" varchar(20) NOT NULL DEFAULT 'EduTrack';
--> statement-breakpoint
ALTER TABLE "public"."app_settings"
ADD COLUMN IF NOT EXISTS "sms_fallback_sender_id" varchar(20);
--> statement-breakpoint
ALTER TABLE "public"."app_settings"
ADD COLUMN IF NOT EXISTS "sms_default_country_code" varchar(8) NOT NULL DEFAULT '+225';
--> statement-breakpoint
ALTER TABLE "public"."app_settings"
ADD COLUMN IF NOT EXISTS "sms_alert_quota_threshold_pct" integer NOT NULL DEFAULT 80;
--> statement-breakpoint
ALTER TABLE "public"."app_settings"
ADD COLUMN IF NOT EXISTS "sms_alert_failure_threshold_count" integer NOT NULL DEFAULT 5;
--> statement-breakpoint
ALTER TABLE "public"."app_settings"
ADD COLUMN IF NOT EXISTS "sms_alert_email" varchar(255);
--> statement-breakpoint
ALTER TABLE "public"."app_settings"
ADD COLUMN IF NOT EXISTS "sms_maintenance_mode" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "public"."app_settings"
ADD COLUMN IF NOT EXISTS "sms_maintenance_message" text NOT NULL DEFAULT 'Service SMS en maintenance';
--> statement-breakpoint
ALTER TABLE "public"."app_settings"
DROP CONSTRAINT IF EXISTS app_settings_sms_provider_check;
--> statement-breakpoint
ALTER TABLE "public"."app_settings"
ADD CONSTRAINT app_settings_sms_provider_check
CHECK ("sms_provider" IN ('mock', 'infobip', 'africas_talking', 'twilio', 'orange_api', 'smsmode', 'custom'));
