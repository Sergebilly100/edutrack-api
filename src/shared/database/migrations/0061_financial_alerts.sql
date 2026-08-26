DO $$ BEGIN
  CREATE TYPE "tenant"."financial_alert_rule_type" AS ENUM ('preventive', 'late', 'severe_late');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "tenant"."financial_alert_channel" AS ENUM ('sms', 'in_app', 'both');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tenant"."financial_alert_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "type" "tenant"."financial_alert_rule_type" NOT NULL,
  "days_offset" int NOT NULL,
  "channel" "tenant"."financial_alert_channel" NOT NULL DEFAULT 'sms',
  "is_active" boolean NOT NULL DEFAULT true,
  "created_by_user_id" uuid REFERENCES "tenant"."users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "financial_alert_rules_type_unique" UNIQUE("type")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tenant"."financial_alert_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "student_id" uuid NOT NULL REFERENCES "tenant"."students"("id") ON DELETE CASCADE,
  "rule_id" uuid NOT NULL REFERENCES "tenant"."financial_alert_rules"("id") ON DELETE CASCADE,
  "channel" "tenant"."financial_alert_channel" NOT NULL,
  "status" varchar(16) NOT NULL DEFAULT 'sent',
  "message" text,
  "sent_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_financial_alert_logs_student_rule"
  ON "tenant"."financial_alert_logs" ("student_id", "rule_id", "sent_at" DESC);--> statement-breakpoint
