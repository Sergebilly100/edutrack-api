-- Workflow de revue de fin d'année, appliqué dans chaque schéma tenant.
DO $$
BEGIN
  CREATE TYPE "tenant"."class_decision_type" AS ENUM ('promoted', 'repeat', 'expelled');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;
--> statement-breakpoint
ALTER TABLE "tenant"."school_years"
  ADD COLUMN IF NOT EXISTS "end_of_year_review_start_date" date;
--> statement-breakpoint
UPDATE "tenant"."school_years"
SET "end_of_year_review_start_date" = "end_date" - 30
WHERE "end_of_year_review_start_date" IS NULL;
--> statement-breakpoint
ALTER TABLE "tenant"."school_years"
  ALTER COLUMN "end_of_year_review_start_date" SET NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'school_years_review_before_end'
      AND conrelid = '"tenant"."school_years"'::regclass
  ) THEN
    ALTER TABLE "tenant"."school_years"
      ADD CONSTRAINT "school_years_review_before_end"
      CHECK ("end_of_year_review_start_date" < "end_date");
  END IF;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "tenant"."set_school_year_review_start_date"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."end_of_year_review_start_date" IS NULL THEN
    NEW."end_of_year_review_start_date" := NEW."end_date" - 30;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "school_years_review_start_date_default" ON "tenant"."school_years";
--> statement-breakpoint
CREATE TRIGGER "school_years_review_start_date_default"
BEFORE INSERT ON "tenant"."school_years"
FOR EACH ROW
EXECUTE FUNCTION "tenant"."set_school_year_review_start_date"();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant"."class_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "student_id" uuid NOT NULL REFERENCES "tenant"."students"("id") ON DELETE CASCADE,
  "school_year_id" uuid NOT NULL REFERENCES "tenant"."school_years"("id") ON DELETE CASCADE,
  "suggested_decision" "tenant"."class_decision_type",
  "final_decision" "tenant"."class_decision_type",
  "validated_by_user_id" uuid REFERENCES "tenant"."users"("id") ON DELETE SET NULL,
  "validated_at" timestamp with time zone,
  "next_level_id" uuid REFERENCES "tenant"."levels"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "class_decisions_student_year_unique" UNIQUE ("student_id", "school_year_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_class_decisions_school_year"
  ON "tenant"."class_decisions" ("school_year_id");
