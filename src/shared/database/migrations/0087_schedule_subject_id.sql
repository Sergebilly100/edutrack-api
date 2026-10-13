ALTER TABLE "tenant"."schedules" ADD COLUMN IF NOT EXISTS "subject_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'schedules_subject_id_subjects_id_fk'
      AND conrelid = '"tenant"."schedules"'::regclass
  ) THEN
    ALTER TABLE "tenant"."schedules"
      ADD CONSTRAINT "schedules_subject_id_subjects_id_fk"
      FOREIGN KEY ("subject_id") REFERENCES "tenant"."subjects"("id") ON DELETE RESTRICT;
  END IF;
END $$;--> statement-breakpoint
WITH certain_matches AS (
  SELECT sch.id AS schedule_id, MIN(sub.id::text)::uuid AS subject_id
  FROM "tenant"."schedules" sch
  INNER JOIN "tenant"."classes" c ON c.id = sch.class_id
  INNER JOIN "tenant"."subjects" sub ON sub.level_id = c.level_id AND sub.name = sch.subject
  INNER JOIN "tenant"."teacher_subject_assignments" tsa
    ON tsa.subject_id = sub.id AND tsa.class_id = c.id AND tsa.teacher_id = sch.teacher_id
  WHERE sch.subject_id IS NULL
  GROUP BY sch.id
  HAVING COUNT(DISTINCT sub.id) = 1
)
UPDATE "tenant"."schedules" sch
SET subject_id = match.subject_id
FROM certain_matches match
WHERE sch.id = match.schedule_id AND sch.subject_id IS NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "tenant"."protect_schedule_assignment"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "tenant"."schedules" sch
    INNER JOIN "tenant"."schedule_periods" sp ON sp.id = sch.schedule_period_id
    WHERE sch.teacher_id = OLD.teacher_id AND sch.class_id = OLD.class_id
      AND sch.subject_id = OLD.subject_id AND sch.is_active = true
      AND sp.valid_to >= CURRENT_DATE
      AND (sch.end_date IS NULL OR sch.end_date > CURRENT_DATE)
  ) THEN
    RAISE EXCEPTION 'Resolve active schedule subjects before changing this assignment' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "protect_schedule_assignment_delete" ON "tenant"."teacher_subject_assignments";
--> statement-breakpoint
CREATE TRIGGER "protect_schedule_assignment_delete" BEFORE DELETE ON "tenant"."teacher_subject_assignments"
FOR EACH ROW EXECUTE FUNCTION "tenant"."protect_schedule_assignment"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "protect_schedule_assignment_update" ON "tenant"."teacher_subject_assignments";
--> statement-breakpoint
CREATE TRIGGER "protect_schedule_assignment_update" BEFORE UPDATE OF teacher_id, class_id, subject_id ON "tenant"."teacher_subject_assignments"
FOR EACH ROW WHEN (OLD.teacher_id IS DISTINCT FROM NEW.teacher_id OR OLD.class_id IS DISTINCT FROM NEW.class_id OR OLD.subject_id IS DISTINCT FROM NEW.subject_id)
EXECUTE FUNCTION "tenant"."protect_schedule_assignment"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "tenant"."protect_schedule_class_level"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "tenant"."schedules" sch
    INNER JOIN "tenant"."schedule_periods" sp ON sp.id = sch.schedule_period_id
    INNER JOIN "tenant"."subjects" sub ON sub.id = sch.subject_id
    WHERE sch.class_id = OLD.id AND sch.is_active = true
      AND sp.valid_to >= CURRENT_DATE
      AND (sch.end_date IS NULL OR sch.end_date > CURRENT_DATE)
      AND (sub.level_id IS DISTINCT FROM NEW.level_id OR NEW.is_active = false)
  ) THEN
    RAISE EXCEPTION 'Resolve active schedules before changing this class' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "protect_schedule_class_level" ON "tenant"."classes";
--> statement-breakpoint
CREATE TRIGGER "protect_schedule_class_level" BEFORE UPDATE OF level_id, is_active ON "tenant"."classes"
FOR EACH ROW EXECUTE FUNCTION "tenant"."protect_schedule_class_level"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "tenant"."protect_schedule_subject_history"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.subject IS DISTINCT FROM NEW.subject
      OR (OLD.subject_id IS NOT NULL AND OLD.subject_id IS DISTINCT FROM NEW.subject_id))
    AND EXISTS (
      SELECT 1 FROM "tenant"."attendances_teacher" WHERE schedule_id = OLD.id
      UNION ALL
      SELECT 1 FROM "tenant"."attendances_student" WHERE schedule_id = OLD.id
    ) THEN
    RAISE EXCEPTION 'Schedule subject history is locked' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "protect_schedule_subject_history" ON "tenant"."schedules";
--> statement-breakpoint
CREATE TRIGGER "protect_schedule_subject_history" BEFORE UPDATE OF subject, subject_id ON "tenant"."schedules"
FOR EACH ROW EXECUTE FUNCTION "tenant"."protect_schedule_subject_history"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "tenant"."validate_schedule_subject_scope"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  year_start date;
  year_end date;
  period_start date;
  period_end date;
BEGIN
  IF NEW.subject_id IS NULL THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'A new schedule requires an official subject' USING ERRCODE = '23514';
    END IF;
    IF NEW.is_active AND EXISTS (
      SELECT 1 FROM "tenant"."schedule_periods" sp
      WHERE sp.id = NEW.schedule_period_id AND sp.valid_to >= CURRENT_DATE
        AND (NEW.end_date IS NULL OR NEW.end_date > CURRENT_DATE)
    ) THEN
      RAISE EXCEPTION 'A new or reassigned schedule requires an official subject' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT sy.start_date, sy.end_date, sp.valid_from, sp.valid_to
    INTO year_start, year_end, period_start, period_end
  FROM "tenant"."teacher_subject_assignments" tsa
  INNER JOIN "tenant"."classes" c ON c.id = tsa.class_id
  INNER JOIN "tenant"."school_years" sy ON sy.id = c.school_year_id AND sy.status = 'active'
  INNER JOIN "tenant"."schedule_periods" sp ON sp.id = NEW.schedule_period_id
  INNER JOIN "tenant"."subjects" sub ON sub.id = tsa.subject_id AND sub.level_id = c.level_id
  INNER JOIN "tenant"."teachers" t ON t.id = tsa.teacher_id AND t.is_blocked = false
  INNER JOIN "tenant"."users" u ON u.id = t.user_id AND u.is_active = true
  WHERE tsa.teacher_id = NEW.teacher_id AND tsa.class_id = NEW.class_id
    AND tsa.subject_id = NEW.subject_id AND c.is_active = true
  FOR SHARE OF tsa, c, sy, sp, sub, t, u;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Schedule subject is outside the active class and teacher assignment' USING ERRCODE = '23514';
  END IF;
  IF CURRENT_DATE < year_start THEN
    RAISE EXCEPTION 'School year has not started for this schedule' USING ERRCODE = '23514';
  END IF;
  IF CURRENT_DATE > year_end OR NEW.start_date > year_end OR period_start > year_end THEN
    RAISE EXCEPTION 'School year has ended for this schedule' USING ERRCODE = '23514';
  END IF;
  IF NEW.start_date < year_start OR period_end < year_start THEN
    RAISE EXCEPTION 'Schedule is outside the active school year' USING ERRCODE = '23514';
  END IF;
  IF NEW.end_date IS NOT NULL AND NEW.end_date > year_end + 1 THEN
    RAISE EXCEPTION 'Schedule occurrence exceeds the active school year' USING ERRCODE = '23514';
  END IF;
  IF NEW.end_date IS NULL AND (
    year_end + 1 + ((NEW.day_of_week - EXTRACT(ISODOW FROM year_end + 1)::int + 7) % 7)
  ) <= period_end THEN
    RAISE EXCEPTION 'Recurring schedule exceeds the active school year' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "validate_schedule_subject_scope" ON "tenant"."schedules";
--> statement-breakpoint
CREATE TRIGGER "validate_schedule_subject_scope"
BEFORE INSERT OR UPDATE ON "tenant"."schedules"
FOR EACH ROW EXECUTE FUNCTION "tenant"."validate_schedule_subject_scope"();
