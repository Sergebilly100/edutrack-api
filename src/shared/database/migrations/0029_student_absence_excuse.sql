-- Migration 0029: excuse_reason column for student absences
-- Allows marking a student absence as excused with an optional justification note.

ALTER TABLE "tenant"."attendances_student"
  ADD COLUMN IF NOT EXISTS excuse_reason text,
  ADD COLUMN IF NOT EXISTS excused_by uuid,
  ADD COLUMN IF NOT EXISTS excused_at timestamptz;

DO $$ BEGIN
  ALTER TABLE "tenant"."attendances_student"
    ADD CONSTRAINT "attendances_student_excused_by_users_id_fk"
    FOREIGN KEY ("excused_by") REFERENCES "tenant"."users"("id")
    ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Partial index: fast lookup of all excused absences per student
CREATE INDEX IF NOT EXISTS idx_att_student_excused
  ON "tenant"."attendances_student" (student_id, date)
  WHERE status = 'excused';
