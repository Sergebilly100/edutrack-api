ALTER TABLE "tenant"."report_card_claims" ADD COLUMN IF NOT EXISTS "student_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'report_card_claims_student_id_students_id_fk'
      AND conrelid = '"tenant"."report_card_claims"'::regclass) THEN
    ALTER TABLE "tenant"."report_card_claims" ADD CONSTRAINT "report_card_claims_student_id_students_id_fk"
      FOREIGN KEY ("student_id") REFERENCES "tenant"."students"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
