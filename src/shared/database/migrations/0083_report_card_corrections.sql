CREATE TABLE IF NOT EXISTS "tenant"."academic_change_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"grading_period_id" uuid NOT NULL,
	"evaluation_id" uuid,
	"student_id" uuid,
	"claim_id" uuid,
	"operation" varchar(40) NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant"."report_card_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"class_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"grading_period_id" uuid NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" varchar(40) DEFAULT 'open' NOT NULL,
	"phase" varchar(24),
	"decided_by_user_id" uuid,
	"decision_reason" text,
	"decided_at" timestamp with time zone,
	"revalidated_at" timestamp with time zone,
	"regenerated_at" timestamp with time zone,
	"republished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant"."report_card_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"grading_period_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"published_by_user_id" uuid NOT NULL,
	"invalidated_at" timestamp with time zone,
	"invalidated_by_user_id" uuid,
	"invalidation_claim_id" uuid,
	"invalidation_reason" text,
	CONSTRAINT "report_card_versions_student_period_revision_unique" UNIQUE("student_id","grading_period_id","revision")
);
--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'academic_change_audit_actor_user_id_users_id_fk' AND conrelid = '"tenant"."academic_change_audit"'::regclass) THEN ALTER TABLE "tenant"."academic_change_audit" ADD CONSTRAINT "academic_change_audit_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "tenant"."users"("id") ON DELETE no action ON UPDATE no action; END IF; END $$;
--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'academic_change_audit_class_id_classes_id_fk' AND conrelid = '"tenant"."academic_change_audit"'::regclass) THEN ALTER TABLE "tenant"."academic_change_audit" ADD CONSTRAINT "academic_change_audit_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "tenant"."classes"("id") ON DELETE no action ON UPDATE no action; END IF; END $$;
--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'academic_change_audit_subject_id_subjects_id_fk' AND conrelid = '"tenant"."academic_change_audit"'::regclass) THEN ALTER TABLE "tenant"."academic_change_audit" ADD CONSTRAINT "academic_change_audit_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "tenant"."subjects"("id") ON DELETE no action ON UPDATE no action; END IF; END $$;
--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'academic_change_audit_grading_period_id_grading_periods_id_fk' AND conrelid = '"tenant"."academic_change_audit"'::regclass) THEN ALTER TABLE "tenant"."academic_change_audit" ADD CONSTRAINT "academic_change_audit_grading_period_id_grading_periods_id_fk" FOREIGN KEY ("grading_period_id") REFERENCES "tenant"."grading_periods"("id") ON DELETE no action ON UPDATE no action; END IF; END $$;
--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'academic_change_audit_evaluation_id_evaluations_id_fk' AND conrelid = '"tenant"."academic_change_audit"'::regclass) THEN ALTER TABLE "tenant"."academic_change_audit" ADD CONSTRAINT "academic_change_audit_evaluation_id_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "tenant"."evaluations"("id") ON DELETE no action ON UPDATE no action; END IF; END $$;
--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'academic_change_audit_student_id_students_id_fk' AND conrelid = '"tenant"."academic_change_audit"'::regclass) THEN ALTER TABLE "tenant"."academic_change_audit" ADD CONSTRAINT "academic_change_audit_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "tenant"."students"("id") ON DELETE no action ON UPDATE no action; END IF; END $$;
--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'academic_change_audit_claim_id_report_card_claims_id_fk' AND conrelid = '"tenant"."academic_change_audit"'::regclass) THEN ALTER TABLE "tenant"."academic_change_audit" ADD CONSTRAINT "academic_change_audit_claim_id_report_card_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "tenant"."report_card_claims"("id") ON DELETE no action ON UPDATE no action; END IF; END $$;
--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_card_claims_class_id_classes_id_fk' AND conrelid = '"tenant"."report_card_claims"'::regclass) THEN ALTER TABLE "tenant"."report_card_claims" ADD CONSTRAINT "report_card_claims_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "tenant"."classes"("id") ON DELETE no action ON UPDATE no action; END IF; END $$;
--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_card_claims_subject_id_subjects_id_fk' AND conrelid = '"tenant"."report_card_claims"'::regclass) THEN ALTER TABLE "tenant"."report_card_claims" ADD CONSTRAINT "report_card_claims_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "tenant"."subjects"("id") ON DELETE no action ON UPDATE no action; END IF; END $$;
--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_card_claims_grading_period_id_grading_periods_id_fk' AND conrelid = '"tenant"."report_card_claims"'::regclass) THEN ALTER TABLE "tenant"."report_card_claims" ADD CONSTRAINT "report_card_claims_grading_period_id_grading_periods_id_fk" FOREIGN KEY ("grading_period_id") REFERENCES "tenant"."grading_periods"("id") ON DELETE no action ON UPDATE no action; END IF; END $$;
--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_card_claims_requested_by_user_id_users_id_fk' AND conrelid = '"tenant"."report_card_claims"'::regclass) THEN ALTER TABLE "tenant"."report_card_claims" ADD CONSTRAINT "report_card_claims_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "tenant"."users"("id") ON DELETE no action ON UPDATE no action; END IF; END $$;
--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_card_claims_decided_by_user_id_users_id_fk' AND conrelid = '"tenant"."report_card_claims"'::regclass) THEN ALTER TABLE "tenant"."report_card_claims" ADD CONSTRAINT "report_card_claims_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "tenant"."users"("id") ON DELETE no action ON UPDATE no action; END IF; END $$;
--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_card_versions_student_id_students_id_fk' AND conrelid = '"tenant"."report_card_versions"'::regclass) THEN ALTER TABLE "tenant"."report_card_versions" ADD CONSTRAINT "report_card_versions_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "tenant"."students"("id") ON DELETE no action ON UPDATE no action; END IF; END $$;
--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_card_versions_class_id_classes_id_fk' AND conrelid = '"tenant"."report_card_versions"'::regclass) THEN ALTER TABLE "tenant"."report_card_versions" ADD CONSTRAINT "report_card_versions_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "tenant"."classes"("id") ON DELETE no action ON UPDATE no action; END IF; END $$;
--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_card_versions_grading_period_id_grading_periods_id_fk' AND conrelid = '"tenant"."report_card_versions"'::regclass) THEN ALTER TABLE "tenant"."report_card_versions" ADD CONSTRAINT "report_card_versions_grading_period_id_grading_periods_id_fk" FOREIGN KEY ("grading_period_id") REFERENCES "tenant"."grading_periods"("id") ON DELETE no action ON UPDATE no action; END IF; END $$;
--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_card_versions_published_by_user_id_users_id_fk' AND conrelid = '"tenant"."report_card_versions"'::regclass) THEN ALTER TABLE "tenant"."report_card_versions" ADD CONSTRAINT "report_card_versions_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "tenant"."users"("id") ON DELETE no action ON UPDATE no action; END IF; END $$;
--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_card_versions_invalidated_by_user_id_users_id_fk' AND conrelid = '"tenant"."report_card_versions"'::regclass) THEN ALTER TABLE "tenant"."report_card_versions" ADD CONSTRAINT "report_card_versions_invalidated_by_user_id_users_id_fk" FOREIGN KEY ("invalidated_by_user_id") REFERENCES "tenant"."users"("id") ON DELETE no action ON UPDATE no action; END IF; END $$;
--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_card_versions_invalidation_claim_id_report_card_claims_id_fk' AND conrelid = '"tenant"."report_card_versions"'::regclass) THEN ALTER TABLE "tenant"."report_card_versions" ADD CONSTRAINT "report_card_versions_invalidation_claim_id_report_card_claims_id_fk" FOREIGN KEY ("invalidation_claim_id") REFERENCES "tenant"."report_card_claims"("id") ON DELETE no action ON UPDATE no action; END IF; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_academic_change_audit_scope" ON "tenant"."academic_change_audit" USING btree ("grading_period_id","class_id","subject_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_report_card_claims_scope" ON "tenant"."report_card_claims" USING btree ("grading_period_id","class_id","subject_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "report_card_claims_open_scope_unique" ON "tenant"."report_card_claims" USING btree ("grading_period_id","class_id") WHERE status IN ('open', 'pending_exceptional_authorization', 'approved') OR (phase <> 'before' AND status IN ('corrected', 'regenerated'));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "report_card_versions_one_active_unique" ON "tenant"."report_card_versions" USING btree ("student_id","grading_period_id") WHERE invalidated_at IS NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "tenant"."prevent_academic_change_audit_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'academic_change_audit is append-only';
END;
$$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'academic_change_audit_immutable' AND tgrelid = '"tenant"."academic_change_audit"'::regclass) THEN
    CREATE TRIGGER academic_change_audit_immutable BEFORE UPDATE OR DELETE ON "tenant"."academic_change_audit"
      FOR EACH ROW EXECUTE FUNCTION "tenant"."prevent_academic_change_audit_mutation"();
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "tenant"."guard_report_card_version_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'report_card_versions cannot be deleted';
  END IF;
  IF OLD.invalidated_at IS NOT NULL
    OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
    OR NEW.card_id IS DISTINCT FROM OLD.card_id
    OR NEW.student_id IS DISTINCT FROM OLD.student_id
    OR NEW.class_id IS DISTINCT FROM OLD.class_id
    OR NEW.grading_period_id IS DISTINCT FROM OLD.grading_period_id
    OR NEW.revision IS DISTINCT FROM OLD.revision
    OR NEW.published_at IS DISTINCT FROM OLD.published_at
    OR NEW.published_by_user_id IS DISTINCT FROM OLD.published_by_user_id
    OR NEW.invalidated_at IS NULL THEN
    RAISE EXCEPTION 'report_card_versions cannot be rewritten';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'report_card_versions_guard' AND tgrelid = '"tenant"."report_card_versions"'::regclass) THEN
    CREATE TRIGGER report_card_versions_guard BEFORE UPDATE OR DELETE ON "tenant"."report_card_versions"
      FOR EACH ROW EXECUTE FUNCTION "tenant"."guard_report_card_version_mutation"();
  END IF;
END $$;
