CREATE TABLE IF NOT EXISTS "tenant"."student_tuition_schedule_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "student_id" uuid NOT NULL REFERENCES "tenant"."students"("id") ON DELETE CASCADE,
  "school_year_id" uuid NOT NULL REFERENCES "tenant"."school_years"("id") ON DELETE CASCADE,
  "due_date" date NOT NULL,
  "cumulative_amount_expected" numeric(12, 2) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "student_tuition_schedule_steps_student_year_date_unique" UNIQUE("student_id", "school_year_id", "due_date"),
  CONSTRAINT "student_tuition_schedule_steps_amount_non_negative" CHECK ("cumulative_amount_expected" >= 0)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_student_tuition_schedule_steps_student_year_due_date"
  ON "tenant"."student_tuition_schedule_steps" ("student_id", "school_year_id", "due_date");
