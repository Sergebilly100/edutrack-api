ALTER TABLE "tenant"."schedules"
ADD COLUMN IF NOT EXISTS "end_date" date;
--> statement-breakpoint
ALTER TABLE "tenant"."schedules"
DROP CONSTRAINT IF EXISTS "schedules_period_teacher_slot_day_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "schedules_period_teacher_slot_day_active_unique"
ON "tenant"."schedules" USING btree ("schedule_period_id","teacher_id","time_slot_id","day_of_week")
WHERE "tenant"."schedules"."is_active" = true
  AND "tenant"."schedules"."end_date" IS NULL;
