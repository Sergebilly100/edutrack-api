DO $$ BEGIN
  CREATE TYPE "tenant"."risk_level" AS ENUM ('none', 'attention', 'warning', 'critical');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tenant"."risk_alert_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "subject_type" varchar(16) NOT NULL,
  "signal_type" varchar(30) NOT NULL,
  "threshold_value" numeric(10,2) NOT NULL,
  "period_days" int NOT NULL DEFAULT 30,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "risk_alert_rules_subject_signal_unique" UNIQUE("subject_type", "signal_type")
);--> statement-breakpoint

-- Seuils par défaut (choix documenté : prof = même esprit que le calcul
-- frontend remplacé, soit des absences sur une fenêtre glissante récente).
INSERT INTO "tenant"."risk_alert_rules" ("subject_type", "signal_type", "threshold_value", "period_days", "is_active")
VALUES
  ('student', 'absences', 3, 30, true),
  ('student', 'grades', 2, 0, true),
  ('student', 'payments', 1, 0, true),
  ('teacher', 'absences', 3, 30, true)
ON CONFLICT ("subject_type", "signal_type") DO NOTHING;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tenant"."student_risk_status" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "student_id" uuid NOT NULL REFERENCES "tenant"."students"("id") ON DELETE CASCADE,
  "absences_signal" boolean NOT NULL DEFAULT false,
  "grades_signal" boolean NOT NULL DEFAULT false,
  "payment_signal" boolean NOT NULL DEFAULT false,
  "risk_score" int NOT NULL DEFAULT 0,
  "level" "tenant"."risk_level" NOT NULL DEFAULT 'none',
  "computed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "student_risk_status_student_unique" UNIQUE("student_id")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tenant"."teacher_risk_status" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "teacher_id" uuid NOT NULL REFERENCES "tenant"."teachers"("id") ON DELETE CASCADE,
  "absences_signal" boolean NOT NULL DEFAULT false,
  "risk_score" int NOT NULL DEFAULT 0,
  "level" "tenant"."risk_level" NOT NULL DEFAULT 'none',
  "computed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "teacher_risk_status_teacher_unique" UNIQUE("teacher_id")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_student_risk_level"
  ON "tenant"."student_risk_status" ("level");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_teacher_risk_level"
  ON "tenant"."teacher_risk_status" ("level");--> statement-breakpoint
