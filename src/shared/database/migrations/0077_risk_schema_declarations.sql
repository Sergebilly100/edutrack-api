-- Déclarations Drizzle des deux tables existantes de 0062 ; opérations hors périmètre écartées.
DO $$ BEGIN
  CREATE TYPE "tenant"."risk_level" AS ENUM('none', 'attention', 'warning', 'critical');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant"."risk_alert_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" varchar(16) NOT NULL,
	"signal_type" varchar(30) NOT NULL,
	"threshold_value" numeric(10, 2) NOT NULL,
	"period_days" integer DEFAULT 30 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "risk_alert_rules_subject_signal_unique" UNIQUE("subject_type","signal_type")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant"."teacher_risk_status" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teacher_id" uuid NOT NULL,
	"absences_signal" boolean DEFAULT false NOT NULL,
	"risk_score" integer DEFAULT 0 NOT NULL,
	"level" "tenant"."risk_level" DEFAULT 'none' NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teacher_risk_status_teacher_unique" UNIQUE("teacher_id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tenant"."teacher_risk_status" ADD CONSTRAINT "teacher_risk_status_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "tenant"."teachers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_teacher_risk_level" ON "tenant"."teacher_risk_status" USING btree ("level");
