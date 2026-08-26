DO $$ BEGIN
  CREATE TYPE "tenant"."report_card_status" AS ENUM ('generated', 'published');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "tenant"."report_card_line_type" AS ENUM ('subject', 'conduct');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tenant"."report_cards" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "student_id" uuid NOT NULL REFERENCES "tenant"."students"("id") ON DELETE CASCADE,
  "class_id" uuid NOT NULL REFERENCES "tenant"."classes"("id"),
  "grading_period_id" uuid NOT NULL REFERENCES "tenant"."grading_periods"("id") ON DELETE CASCADE,
  "general_average" numeric(8,3) NOT NULL,
  "rank" int NOT NULL,
  "class_average" numeric(8,3) NOT NULL,
  "class_min_average" numeric(8,3) NOT NULL,
  "class_max_average" numeric(8,3) NOT NULL,
  "class_headcount" int NOT NULL,
  "class_decision_id" uuid REFERENCES "tenant"."class_decisions"("id") ON DELETE SET NULL,
  "status" "tenant"."report_card_status" DEFAULT 'generated' NOT NULL,
  "generated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "published_at" timestamp with time zone,
  "published_by_user_id" uuid REFERENCES "tenant"."users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "report_cards_student_period_unique" UNIQUE("student_id", "grading_period_id")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_report_cards_class_period"
  ON "tenant"."report_cards" ("class_id", "grading_period_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tenant"."report_card_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "report_card_id" uuid NOT NULL REFERENCES "tenant"."report_cards"("id") ON DELETE CASCADE,
  "subject_id" uuid REFERENCES "tenant"."subjects"("id") ON DELETE CASCADE,
  "line_type" "tenant"."report_card_line_type" NOT NULL,
  "subject_average" numeric(8,3) NOT NULL,
  "subject_coefficient" numeric(8,3) NOT NULL,
  "subject_rank" int,
  "teacher_comment" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "report_card_lines_subject_unique"
  ON "tenant"."report_card_lines" ("report_card_id", "subject_id") WHERE subject_id IS NOT NULL;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "report_card_lines_conduct_unique"
  ON "tenant"."report_card_lines" ("report_card_id") WHERE line_type = 'conduct';--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_report_card_lines_report"
  ON "tenant"."report_card_lines" ("report_card_id");--> statement-breakpoint

-- Cachet et signature de l'école pour les bulletins PDF uniquement.
ALTER TABLE "public"."tenants"
  ADD COLUMN IF NOT EXISTS "stamp_image_url" text,
  ADD COLUMN IF NOT EXISTS "signature_image_url" text;--> statement-breakpoint
