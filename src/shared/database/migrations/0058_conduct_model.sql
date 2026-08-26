CREATE TABLE IF NOT EXISTS "tenant"."educator_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "class_id" uuid REFERENCES "tenant"."classes"("id") ON DELETE CASCADE,
  "level_id" uuid REFERENCES "tenant"."levels"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "tenant"."users"("id") ON DELETE CASCADE,
  "assigned_by" uuid REFERENCES "tenant"."users"("id"),
  "assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "educator_assignments_target_required" CHECK (
    (class_id IS NOT NULL)::int + (level_id IS NOT NULL)::int = 1
  )
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "educator_assignments_class_unique"
  ON "tenant"."educator_assignments" ("class_id") WHERE class_id IS NOT NULL;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "educator_assignments_level_unique"
  ON "tenant"."educator_assignments" ("level_id") WHERE level_id IS NOT NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_educator_assignments_user"
  ON "tenant"."educator_assignments" ("user_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tenant"."teacher_conduct_inputs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "student_id" uuid NOT NULL REFERENCES "tenant"."students"("id") ON DELETE CASCADE,
  "teacher_id" uuid NOT NULL REFERENCES "tenant"."teachers"("id") ON DELETE CASCADE,
  "class_id" uuid NOT NULL REFERENCES "tenant"."classes"("id"),
  "grading_period_id" uuid NOT NULL REFERENCES "tenant"."grading_periods"("id") ON DELETE CASCADE,
  "note" numeric(5,2) NOT NULL,
  "observation" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "teacher_conduct_inputs_once_per_period" UNIQUE("student_id", "teacher_id", "grading_period_id"),
  CONSTRAINT "teacher_conduct_inputs_note_range" CHECK ("note" >= 0 AND "note" <= 20)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_teacher_conduct_inputs_student"
  ON "tenant"."teacher_conduct_inputs" ("student_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tenant"."conduct_grades" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "student_id" uuid NOT NULL REFERENCES "tenant"."students"("id") ON DELETE CASCADE,
  "grading_period_id" uuid NOT NULL REFERENCES "tenant"."grading_periods"("id") ON DELETE CASCADE,
  "note" numeric(5,2) NOT NULL,
  "coefficient" numeric(8,3) DEFAULT '1' NOT NULL,
  "decided_by_user_id" uuid NOT NULL REFERENCES "tenant"."users"("id"),
  "decided_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "conduct_grades_student_period_unique" UNIQUE("student_id", "grading_period_id"),
  CONSTRAINT "conduct_grades_note_range" CHECK ("note" >= 0 AND "note" <= 20),
  CONSTRAINT "conduct_grades_coefficient_positive" CHECK ("coefficient" > 0)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_conduct_grades_student"
  ON "tenant"."conduct_grades" ("student_id");--> statement-breakpoint
