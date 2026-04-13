CREATE INDEX "idx_att_student_date" ON "tenant"."attendances_student" USING btree ("student_id","date");--> statement-breakpoint
CREATE INDEX "idx_att_teacher_date" ON "tenant"."attendances_teacher" USING btree ("teacher_id","date");--> statement-breakpoint
CREATE INDEX "idx_att_teacher_schedule" ON "tenant"."attendances_teacher" USING btree ("schedule_id","date");--> statement-breakpoint
CREATE INDEX "idx_att_teacher_mismatch" ON "tenant"."attendances_teacher" USING btree ("room_mismatch","date") WHERE "tenant"."attendances_teacher"."room_mismatch" = true;--> statement-breakpoint
CREATE INDEX "idx_att_teacher_synced" ON "tenant"."attendances_teacher" USING btree ("synced_at") WHERE "tenant"."attendances_teacher"."synced_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_notif_status" ON "tenant"."notifications_log" USING btree ("status") WHERE "tenant"."notifications_log"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "idx_rooms_qr_token" ON "tenant"."rooms" USING btree ("qr_token");--> statement-breakpoint
CREATE INDEX "idx_periods_dates" ON "tenant"."schedule_periods" USING btree ("valid_from","valid_to");--> statement-breakpoint
CREATE INDEX "idx_schedules_period" ON "tenant"."schedules" USING btree ("schedule_period_id");--> statement-breakpoint
CREATE INDEX "idx_schedules_teacher" ON "tenant"."schedules" USING btree ("teacher_id");--> statement-breakpoint
CREATE INDEX "idx_schedules_room" ON "tenant"."schedules" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "idx_schedules_day" ON "tenant"."schedules" USING btree ("day_of_week");--> statement-breakpoint
CREATE INDEX "idx_schedules_active" ON "tenant"."schedules" USING btree ("teacher_id","day_of_week","time_slot_id") WHERE "tenant"."schedules"."is_active" = true;--> statement-breakpoint
CREATE INDEX "idx_students_class" ON "tenant"."students" USING btree ("class_id");--> statement-breakpoint
CREATE INDEX "idx_teachers_username" ON "tenant"."teachers" USING btree ("username");--> statement-breakpoint
CREATE INDEX "idx_teachers_user" ON "tenant"."teachers" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "tenant"."rooms" ADD CONSTRAINT "rooms_name_unique" UNIQUE("name");--> statement-breakpoint
ALTER TABLE "tenant"."time_slots" ADD CONSTRAINT "time_slots_label_unique" UNIQUE("label");--> statement-breakpoint
ALTER TABLE "tenant"."attendances_teacher" ADD CONSTRAINT "att_teacher_late_minutes_positive" CHECK ("tenant"."attendances_teacher"."late_minutes" IS NULL OR "tenant"."attendances_teacher"."late_minutes" >= 0);--> statement-breakpoint
ALTER TABLE "tenant"."attendances_teacher" ADD CONSTRAINT "att_teacher_scan_time_range" CHECK ("tenant"."attendances_teacher"."room_scan_end_at" IS NULL OR "tenant"."attendances_teacher"."room_scan_start_at" IS NULL OR "tenant"."attendances_teacher"."room_scan_end_at" > "tenant"."attendances_teacher"."room_scan_start_at");