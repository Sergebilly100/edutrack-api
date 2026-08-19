DO $$ BEGIN
  CREATE TYPE "tenant"."grading_period_type" AS ENUM ('trimester', 'semester');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "tenant"."evaluation_type" AS ENUM ('scheduled', 'spontaneous');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "tenant"."class_subject_completion_status" AS ENUM ('in_progress', 'completed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tenant"."subjects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "level_id" uuid NOT NULL REFERENCES "tenant"."levels"("id") ON DELETE CASCADE,
  "name" varchar(100) NOT NULL,
  "coefficient" numeric(8,3) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "subjects_coefficient_positive" CHECK ("coefficient" > 0),
  CONSTRAINT "subjects_level_name_unique" UNIQUE("level_id", "name")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_subjects_level" ON "tenant"."subjects" ("level_id", "name");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tenant"."teacher_subject_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "teacher_id" uuid NOT NULL REFERENCES "tenant"."teachers"("id") ON DELETE CASCADE,
  "subject_id" uuid NOT NULL REFERENCES "tenant"."subjects"("id") ON DELETE CASCADE,
  "class_id" uuid NOT NULL REFERENCES "tenant"."classes"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "teacher_subject_assignments_unique" UNIQUE("teacher_id", "subject_id", "class_id")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_teacher_subject_assignments_teacher" ON "tenant"."teacher_subject_assignments" ("teacher_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_teacher_subject_assignments_class" ON "tenant"."teacher_subject_assignments" ("class_id", "subject_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tenant"."grading_periods" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "school_year_id" uuid NOT NULL REFERENCES "tenant"."school_years"("id") ON DELETE CASCADE,
  "type" "tenant"."grading_period_type" NOT NULL,
  "order_index" integer NOT NULL,
  "label" varchar(100) NOT NULL,
  "start_date" date NOT NULL,
  "end_date" date NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "grading_periods_valid_dates" CHECK ("start_date" <= "end_date"),
  CONSTRAINT "grading_periods_order_positive" CHECK ("order_index" > 0),
  CONSTRAINT "grading_periods_year_order_unique" UNIQUE("school_year_id", "order_index"),
  CONSTRAINT "grading_periods_year_label_unique" UNIQUE("school_year_id", "label")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_grading_periods_year" ON "tenant"."grading_periods" ("school_year_id", "order_index");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tenant"."evaluations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "lesson_slot_id" uuid NOT NULL REFERENCES "tenant"."schedules"("id"),
  "subject_id" uuid NOT NULL REFERENCES "tenant"."subjects"("id"),
  "class_id" uuid NOT NULL REFERENCES "tenant"."classes"("id"),
  "grading_period_id" uuid NOT NULL REFERENCES "tenant"."grading_periods"("id"),
  "teacher_id" uuid NOT NULL REFERENCES "tenant"."teachers"("id"),
  "type" "tenant"."evaluation_type" NOT NULL,
  "coefficient" numeric(8,3) NOT NULL,
  "label" varchar(150) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "evaluations_coefficient_positive" CHECK ("coefficient" > 0)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_evaluations_period_subject_class" ON "tenant"."evaluations" ("grading_period_id", "subject_id", "class_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_evaluations_teacher" ON "tenant"."evaluations" ("teacher_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tenant"."evaluation_grades" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "evaluation_id" uuid NOT NULL REFERENCES "tenant"."evaluations"("id") ON DELETE CASCADE,
  "student_id" uuid NOT NULL REFERENCES "tenant"."students"("id") ON DELETE CASCADE,
  "score" numeric(8,3) NOT NULL,
  "max_score" numeric(8,3) NOT NULL,
  "comment" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "evaluation_grades_score_non_negative" CHECK ("score" >= 0),
  CONSTRAINT "evaluation_grades_max_score_positive" CHECK ("max_score" > 0),
  CONSTRAINT "evaluation_grades_score_within_max" CHECK ("score" <= "max_score"),
  CONSTRAINT "evaluation_grades_evaluation_student_unique" UNIQUE("evaluation_id", "student_id")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_evaluation_grades_student" ON "tenant"."evaluation_grades" ("student_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tenant"."class_subject_completion" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "class_id" uuid NOT NULL REFERENCES "tenant"."classes"("id") ON DELETE CASCADE,
  "subject_id" uuid NOT NULL REFERENCES "tenant"."subjects"("id") ON DELETE CASCADE,
  "grading_period_id" uuid NOT NULL REFERENCES "tenant"."grading_periods"("id") ON DELETE CASCADE,
  "status" "tenant"."class_subject_completion_status" DEFAULT 'in_progress' NOT NULL,
  "completed_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "class_subject_completion_unique" UNIQUE("class_id", "subject_id", "grading_period_id")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_class_subject_completion_period_class" ON "tenant"."class_subject_completion" ("grading_period_id", "class_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tenant"."student_period_averages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "student_id" uuid NOT NULL REFERENCES "tenant"."students"("id") ON DELETE CASCADE,
  "subject_id" uuid REFERENCES "tenant"."subjects"("id") ON DELETE CASCADE,
  "grading_period_id" uuid NOT NULL REFERENCES "tenant"."grading_periods"("id") ON DELETE CASCADE,
  "average" numeric(8,3) NOT NULL,
  "rank" integer,
  "computed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "student_period_averages_rank_positive" CHECK ("rank" IS NULL OR "rank" > 0)
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "student_period_averages_subject_unique"
  ON "tenant"."student_period_averages" ("student_id", "subject_id", "grading_period_id")
  WHERE "subject_id" IS NOT NULL;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "student_period_averages_general_unique"
  ON "tenant"."student_period_averages" ("student_id", "grading_period_id")
  WHERE "subject_id" IS NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_student_period_averages_period" ON "tenant"."student_period_averages" ("grading_period_id", "subject_id");
