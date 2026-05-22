-- P2-01: Performance indexes for hot-path queries
-- All indexes are idempotent (IF NOT EXISTS) and applied per tenant schema by migrate-all-tenants.ts

-- Student attendance by schedule+date (used in dashboard director, class attendance views)
CREATE INDEX IF NOT EXISTS "idx_att_student_schedule_date"
  ON "tenant"."attendances_student" ("schedule_id", "date");
--> statement-breakpoint

-- Notifications log: lookup by (type, related_id, phone) for de-dup checks before sending SMS
CREATE INDEX IF NOT EXISTS "idx_notifications_log_type_related"
  ON "tenant"."notifications_log" ("type", "related_id", "recipient_phone", "created_at" DESC);
--> statement-breakpoint

-- Notifications log: history queries by phone (parent SMS history, audit)
CREATE INDEX IF NOT EXISTS "idx_notifications_log_phone_created"
  ON "tenant"."notifications_log" ("recipient_phone", "type", "created_at" DESC);
--> statement-breakpoint

-- Notifications log: webhook delivery-receipt lookup by provider_ref (CRIT-06 follow-up,
-- replaces full table scan when Orange/AT confirms a SMS by reference)
CREATE INDEX IF NOT EXISTS "idx_notifications_log_provider_ref"
  ON "tenant"."notifications_log" ("provider_ref")
  WHERE "provider_ref" IS NOT NULL;
--> statement-breakpoint

-- Schedules by class+day (used when displaying a class' timetable)
CREATE INDEX IF NOT EXISTS "idx_schedules_class_day"
  ON "tenant"."schedules" ("class_id", "day_of_week")
  WHERE "is_active" = true;
--> statement-breakpoint

-- Teacher attendance: list absent teachers for a date (director morning view)
CREATE INDEX IF NOT EXISTS "idx_att_teacher_date_status_absent"
  ON "tenant"."attendances_teacher" ("date")
  WHERE "status" = 'absent';
--> statement-breakpoint

-- Teacher attendance: validation queue (director "à valider" page)
CREATE INDEX IF NOT EXISTS "idx_att_teacher_validation_pending"
  ON "tenant"."attendances_teacher" ("validation_status", "date")
  WHERE "validation_status" = 'pending';
--> statement-breakpoint

-- Salary records: list by period and status (billing/salaries dashboard)
CREATE INDEX IF NOT EXISTS "idx_salary_records_period"
  ON "tenant"."salary_records" ("period_month", "status");
