DO $$ BEGIN
  CREATE TYPE "tenant"."financial_cache_status" AS ENUM ('up_to_date', 'late', 'waived');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tenant"."student_financial_status" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "student_id" uuid NOT NULL REFERENCES "tenant"."students"("id") ON DELETE CASCADE,
  "school_year_id" uuid NOT NULL REFERENCES "tenant"."school_years"("id") ON DELETE CASCADE,
  "total_expected_to_date" numeric(14,2) NOT NULL DEFAULT 0,
  "total_paid" numeric(14,2) NOT NULL DEFAULT 0,
  "waived_amount" numeric(14,2) NOT NULL DEFAULT 0,
  "total_due_year" numeric(14,2) NOT NULL DEFAULT 0,
  "status" "tenant"."financial_cache_status" NOT NULL DEFAULT 'up_to_date',
  "days_late" int,
  "earliest_overdue_step_due_date" date,
  "last_computed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "student_financial_status_student_year_unique" UNIQUE("student_id", "school_year_id")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_student_financial_status_year"
  ON "tenant"."student_financial_status" ("school_year_id", "status");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tenant"."class_financial_summary" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "class_id" uuid NOT NULL REFERENCES "tenant"."classes"("id") ON DELETE CASCADE,
  "school_year_id" uuid NOT NULL REFERENCES "tenant"."school_years"("id") ON DELETE CASCADE,
  "total_expected_to_date" numeric(14,2) NOT NULL DEFAULT 0,
  "total_paid" numeric(14,2) NOT NULL DEFAULT 0,
  "students_up_to_date_count" int NOT NULL DEFAULT 0,
  "students_late_count" int NOT NULL DEFAULT 0,
  "last_computed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "class_financial_summary_class_year_unique" UNIQUE("class_id", "school_year_id")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tenant"."school_financial_summary" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "school_year_id" uuid NOT NULL REFERENCES "tenant"."school_years"("id") ON DELETE CASCADE,
  "total_expected_to_date" numeric(14,2) NOT NULL DEFAULT 0,
  "total_paid" numeric(14,2) NOT NULL DEFAULT 0,
  "recovery_rate" numeric(6,4) NOT NULL DEFAULT 0,
  "students_up_to_date_count" int NOT NULL DEFAULT 0,
  "students_late_count" int NOT NULL DEFAULT 0,
  "previous_period_total_paid" numeric(14,2) NOT NULL DEFAULT 0,
  "last_computed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "school_financial_summary_year_unique" UNIQUE("school_year_id")
);--> statement-breakpoint
